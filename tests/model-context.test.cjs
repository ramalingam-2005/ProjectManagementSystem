const { test } = require("node:test");
const assert = require("node:assert/strict");
const { HumanMessage, AIMessage, ToolMessage } = require("@langchain/core/messages");
const { convertToOpenAITool } = require("@langchain/core/utils/function_calling");
const { prepareModelMessages, estimateRequestTokens, messageType } = require("../src/agent/model-context.ts");
// Load after the approval suite installs its test checkpointer.
const systemPrompt = (...args) => require("../src/agent/specialist-agent.ts").systemPrompt(...args);
const { makeDatabaseTool } = require("../src/agent/db-tool.ts");
const { recordListIntent, readRecordList, MAX_LIST_RECORDS } = require("../src/agent/record-list.ts");
const { withModelRetry } = require("../src/utils/retry.ts");
const { modelErrorResponse } = require("../src/utils/model-errors.ts");

const lead = { mongoUserId: "aaaaaaaaaaaaaaaaaaaaaaaa", userKey: "u-el-1", name: "Lead", role: "ENGINEERING_LEAD", active: true };
const latest = "for user login intergration create tasks";
const toolCall = (id, args = {}) => new AIMessage({ content: "", tool_calls: [{ id, name: "sprint_task_database_action", type: "tool_call", args }] });
const toolResult = (id, result) => new ToolMessage({ tool_call_id: id, content: JSON.stringify(result) });
const storyRows = (count) => Array.from({ length: count }, (_, i) => ({
  _id: i.toString(16).padStart(24, "0"), storyKey: `US-${i + 1}`, title: i === 42 ? "User login integration" : `Story ${i + 1}`,
  epicId: "bbbbbbbbbbbbbbbbbbbbbbbb", storyPoints: 3, priority: "HIGH", status: "DRAFT",
}));
function pages(rows) {
  const calls = [];
  return { calls, async invoke(action) {
    calls.push(action);
    const items = rows.slice(action.skip, action.skip + action.limit);
    const hasMore = action.skip + items.length < rows.length;
    return JSON.stringify({ ok: true, result: { items, returned: items.length, hasMore, nextSkip: hasMore ? action.skip + action.limit : null } });
  } };
}

test("Large epic and story history fits the model budget while keeping the referenced story", async () => {
  const storyList = await readRecordList(recordListIntent("show all user stories"), pages(storyRows(76)).invoke);
  const history = [
    new HumanMessage("show all the epics"), toolCall("old-epics"), toolResult("old-epics", { items: Array(10).fill({ description: "Epic description ".repeat(200) }) }), new AIMessage("Epic table ".repeat(600)),
    new HumanMessage("show all user stories"), toolCall("old-stories"), toolResult("old-stories", { items: storyRows(76) }), new AIMessage(storyList),
    new HumanMessage(latest),
  ];
  const definitions = [convertToOpenAITool(makeDatabaseTool("SPRINT_TASK", lead, []))];
  const selected = prepareModelMessages(systemPrompt("SPRINT_TASK", lead), history, definitions);
  assert.ok(estimateRequestTokens(selected, definitions) <= 5000);
  assert.equal(selected.at(-1), history.at(-1), "latest request must be preserved verbatim");
  assert.ok(selected.some((message) => String(message.content).includes("User login integration")));
  assert.ok(selected.some((message) => String(message.content).includes("US-43")));
  assert.equal(selected.filter((message) => messageType(message) === "tool").length, 0);
  assert.ok(selected.every((message) => !message.tool_calls?.length));
  assert.equal(history[6].content, JSON.stringify({ items: storyRows(76) }), "stored history stays unchanged");
});

test("Current tool-call pairs and completed mutation receipts survive context selection", () => {
  const current = [new HumanMessage(latest), toolCall("read"), toolResult("read", { ok: true, result: { status: "APPROVED" } }),
    toolCall("write"), toolResult("write", { ok: true, result: { insertedId: "cccccccccccccccccccccccc" } })];
  const selected = prepareModelMessages("Use confirmed action results.", current);
  assert.deepEqual(selected.slice(1), current);
  assert.deepEqual(selected.filter((message) => messageType(message) === "tool").map((message) => message.tool_call_id), ["read", "write"]);
});

test("Oversized current tool results are marked as excerpts without mutating the original", () => {
  const result = toolResult("large", { ok: true, result: { items: storyRows(25).map((row) => ({ ...row, description: "detail ".repeat(3000) })), hasMore: true, nextSkip: 25 } });
  const original = result.content;
  const selected = prepareModelMessages("Use current evidence.", [new HumanMessage("summarize these stories"), toolCall("large", { operation: "find" }), result], [], 2500);
  assert.ok(estimateRequestTokens(selected) <= 2500);
  assert.equal(selected.at(-1).tool_call_id, "large");
  const compacted = JSON.parse(selected.at(-1).content);
  assert.equal(compacted.modelContextTruncated, true);
  assert.equal(compacted.data.result.hasMore, true);
  assert.equal(compacted.data.result.nextSkip, 25);
  assert.equal(result.content, original);
});

test("Latest mutation instructions are rejected locally when they cannot fit, never truncated", () => {
  const input = new HumanMessage("Change task title to " + "x".repeat(8000));
  assert.throws(() => prepareModelMessages("Keep complete instructions.", [input], [], 1000), /MODEL_CONTEXT_TOO_LARGE/);
  assert.equal(input.content.length, 8021);
});

test("Tool schema overhead and Unicode content count against the input budget", () => {
  const history = [new HumanMessage("अगला कार्य ".repeat(50))];
  const plain = estimateRequestTokens(history);
  const definitions = [{ description: "tool schema ".repeat(300) }];
  assert.ok(estimateRequestTokens(history, definitions) > plain + 1000);
  assert.throws(() => prepareModelMessages("Role boundary", history, definitions, plain + 100), /MODEL_CONTEXT_TOO_LARGE/);
});

test("All Engineering Lead specialists fit the configured budget with real tool schemas", () => {
  for (const agent of ["REQUIREMENTS", "SPRINT_TASK", "BUG", "RELEASE", "DOCUMENTATION"]) {
    const definitions = [convertToOpenAITool(makeDatabaseTool(agent, lead, []))];
    const messages = prepareModelMessages(systemPrompt(agent, lead), [new HumanMessage(latest)], definitions);
    assert.ok(estimateRequestTokens(messages, definitions) < 4000, agent);
  }
});

test("Permanent 413 errors are not retried with the same payload", async () => {
  let calls = 0;
  const error = new Error('413 {"error":{"message":"Request too large", "code":"rate_limit_exceeded"}}');
  await assert.rejects(withModelRetry(async () => { calls++; throw error; }), (value) => value === error);
  assert.equal(calls, 1);
});

test("Daily token exhaustion is returned without repeating calls", async () => {
  let calls = 0;
  await assert.rejects(withModelRetry(async () => { calls++; throw new Error("429 tokens per day (TPD): limit reached"); }));
  assert.equal(calls, 1);
});

test("Short per-minute quota waits retry the model while long waits return immediately", async (t) => {
  const waits = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay) => { waits.push(delay); queueMicrotask(callback); });
  let calls = 0;
  const result = await withModelRetry(async () => {
    if (++calls === 1) throw new Error("429 tokens per minute (TPM). Please try again in 15.3975s.");
    return "response";
  });
  assert.equal(result, "response");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [15648]);
  calls = 0;
  await assert.rejects(withModelRetry(async () => { calls++; throw new Error("429 Please try again in 45s."); }), /429/);
  assert.equal(calls, 1);
  assert.equal(waits.length, 1);
});

test("Provider size and quota errors expose useful messages without provider internals", () => {
  for (const status of [413, 429]) {
    const error = Object.assign(new Error(`${status} org_private request details https://console.groq.com/settings/billing`), { status });
    const mapped = modelErrorResponse(error);
    assert.equal(mapped.status, status);
    assert.doesNotMatch(mapped.message, /org_private|https:|\{"/);
  }
  assert.equal(modelErrorResponse(new Error("USER_NOT_FOUND")), undefined);
});

test("All 76 stories are fetched in four scoped pages with a stable sort", async () => {
  const f = pages(storyRows(76));
  const response = await readRecordList(recordListIntent("show all user stories"), f.invoke);
  assert.deepEqual(f.calls.map((call) => call.skip), [0, 25, 50, 75]);
  assert.ok(f.calls.every((call) => call.limit === 25 && call.sort._id === 1 && Object.keys(call.filter).length === 0));
  assert.match(response, /Listed all 76 records/);
  assert.match(response, /\| US-76 \| Story 76 \|/);
  assert.doesNotMatch(response, /hasMore|page forward/);
});

test("Story tables render six distinct headings and safely display pipes in stored titles", async () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const [{ default: Markdown }, { default: gfm }] = await Promise.all([import("react-markdown"), import("remark-gfm")]);
  const rows = storyRows(1);
  rows[0].title = "Login | **admin**\n[guide](https://example.com)";
  const response = await readRecordList(recordListIntent("show all user stories"), pages(rows).invoke);
  const html = renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [gfm] }, response));
  assert.equal((html.match(/<th>/g) ?? []).length, 6);
  assert.equal((html.match(/<td>/g) ?? []).length, 6);
  assert.match(html, /<th>Story Key<\/th>/);
  assert.match(html, /<th>Title<\/th>/);
  assert.match(html, /Login \| \*\*admin\*\*/);
  // GFM may auto-link the literal URL, but stored markdown must stay literal.
  assert.match(html, /\[guide\]\(/);
  assert.doesNotMatch(html, /<strong>admin|>guide<\/a>/);
});

test("Epic table headings and rows have matching columns", async () => {
  const response = await readRecordList(recordListIntent("show all the epics"), pages([{ epicKey: "EPIC-101", title: "Onboarding", status: "ACTIVE" }]).invoke);
  assert.match(response, /\| Epic Key \| Title \| Feature Request ID \| Status \|\n\| --- \| --- \| --- \| --- \|/);
  assert.match(response, /Listed all 1 records/);
});

test("Large lists stop at the display cap and clearly report incompleteness", async () => {
  const f = pages(storyRows(MAX_LIST_RECORDS + 1));
  const response = await readRecordList(recordListIntent("list user stories"), f.invoke);
  assert.equal(f.calls.length, MAX_LIST_RECORDS / 25);
  assert.match(response, /Showing the first 500 records/);
  assert.doesNotMatch(response, /Listed all/);
});

test("A failure after the first page preserves records and reports the incomplete list", async () => {
  const f = pages(storyRows(30));
  let calls = 0;
  const response = await readRecordList(recordListIntent("list user stories"), async (action) => ++calls === 1
    ? f.invoke(action) : JSON.stringify({ ok: false, error: "DATABASE_READ_FAILED" }));
  assert.match(response, /US-25/);
  assert.match(response, /remaining records could not be loaded/);
  assert.doesNotMatch(response, /Listed all/);
});

test("Empty and unauthorized lists are distinguished without inventing missing documentation", async () => {
  const intent = recordListIntent("list user stories");
  assert.match(await readRecordList(intent, pages([]).invoke), /No user stories were found within your access/);
  assert.match(await readRecordList(intent, async () => JSON.stringify({ ok: false, error: "COLLECTION_NOT_ALLOWED:user_stories" })), /does not have permission/);
});

test("Draft stories block Engineering Lead task creation before any business insert", async (t) => {
  const database = require("../src/db/mongodb.ts");
  const { executeDatabaseAction } = require("../src/services/database-action.service.ts");
  const audits = [];
  let inserts = 0;
  t.mock.method(database, "getDb", async () => ({ collection(name) {
    if (name === "users") return { find: () => ({ map() { return this; }, async toArray() { return []; } }) };
    if (name === "user_stories") return { async findOne() { return { status: "DRAFT" }; } };
    if (name === "audit_logs") return { async insertOne(entry) { audits.push(entry); } };
    assert.equal(name, "tasks");
    return { async insertOne() { inserts++; throw new Error("Unexpected task insertion"); } };
  } }));
  await assert.rejects(executeDatabaseAction("SPRINT_TASK", lead, {
    collection: "tasks", operation: "insert_one", reason: "Create a task for the selected story",
    fields: [{ field: "storyId", stringValue: "bbbbbbbbbbbbbbbbbbbbbbbb" }, { field: "title", stringValue: "Implement login" }],
  }), /TASK_CREATION_REQUIRES_APPROVED_STORY/);
  assert.equal(inserts, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].executionStatus, "FAILED");
});

test("Chat API maps a provider 413 to an actionable response", async (t) => {
  const users = require("../src/repositories/user.repository.ts");
  const supervisor = require("../src/agent/supervisor.ts");
  t.mock.method(users, "resolveCaller", async () => lead);
  t.mock.method(supervisor, "runChat", async () => { throw new Error('413 {"org":"private", "code":"rate_limit_exceeded"}'); });
  const { POST } = require("../app/api/chat/route.ts");
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "u-el-1", sessionId: "context", message: latest }) }));
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /Narrow the request/);
  assert.doesNotMatch(body.error, /private|rate_limit_exceeded/);
});

test("A 413 after a completed mutation retries only the model with smaller context", async (t) => {
  const { MemorySaver } = require("@langchain/langgraph");
  const database = require("../src/db/mongodb.ts");
  const models = require("../src/agent/model.ts");
  const actions = require("../src/services/database-action.service.ts");
  const paths = [require.resolve("@langchain/langgraph-checkpoint-mongodb"), require.resolve("../src/agent/specialist-agent.ts")];
  const previous = paths.map((path) => require.cache[path]);
  class TestSaver extends MemorySaver { constructor() { super(); } async setup() {} }
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { MongoDBSaver: TestSaver } };
  delete require.cache[paths[1]];
  t.after(() => paths.forEach((path, i) => { if (previous[i]) require.cache[path] = previous[i]; else delete require.cache[path]; }));
  t.mock.method(database, "getMongoClient", async () => ({}));
  let writes = 0, calls = 0;
  const estimates = [];
  t.mock.method(actions, "executeDatabaseAction", async () => {
    writes++;
    return { ok: true, result: { insertedId: "cccccccccccccccccccccccc", document: { title: "Implement login", description: "saved ".repeat(500) } } };
  });
  const invoke = async (messages, definitions = []) => {
    calls++;
    if (calls === 1) return new AIMessage("Earlier planning context ".repeat(200));
    if (calls === 2) return toolCall("insert", { collection: "tasks", operation: "insert_one", reason: "Create requested task", fieldsJson: JSON.stringify([{ field: "title", stringValue: "Implement login" }]) });
    assert.ok(calls <= 4);
    estimates.push(estimateRequestTokens(messages, definitions));
    if (calls === 3) throw Object.assign(new Error("Request too large"), { status: 413 });
    assert.ok(JSON.stringify(messages).includes("cccccccccccccccccccccccc"));
    return new AIMessage("The task was created.");
  };
  t.mock.method(models, "getModel", () => ({ invoke, bindTools(tools) {
    return { invoke: (messages) => invoke(messages, tools.map((tool) => convertToOpenAITool(tool))) };
  } }));
  const { runSpecialistAgent } = require("../src/agent/specialist-agent.ts");
  const input = { agent: "SPRINT_TASK", caller: lead, threadId: "size-retry" };
  await runSpecialistAgent({ ...input, message: "Summarize the earlier planning context" });
  const output = await runSpecialistAgent({ ...input, message: "Create the requested task" });
  assert.equal(output.response, "The task was created.");
  assert.equal(writes, 1);
  assert.equal(output.trace.length, 1);
  assert.equal(output.trace[0].result.result.insertedId, "cccccccccccccccccccccccc");
  assert.equal(calls, 4);
  assert.ok(estimates[1] < estimates[0], `${estimates[1]} must be smaller than ${estimates[0]}`);
});
