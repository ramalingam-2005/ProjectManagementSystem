const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AIMessage, HumanMessage, ToolMessage } = require("@langchain/core/messages");
const { MemorySaver } = require("@langchain/langgraph");
const { convertToOpenAITool } = require("@langchain/core/utils/function_calling");
const { encodeContextValue, encodeToolContent } = require("../src/agent/tool-context.ts");
const { prepareModelMessages, estimateRequestTokens } = require("../src/agent/model-context.ts");
const { makeDatabaseTool } = require("../src/agent/db-tool.ts");
const database = require("../src/db/mongodb.ts");
const models = require("../src/agent/model.ts");
const actions = require("../src/services/database-action.service.ts");
const lead = { mongoUserId: "aaaaaaaaaaaaaaaaaaaaaaaa", userKey: "u-el-1", name: "Lead", role: "ENGINEERING_LEAD", active: true };

// Independent reader: expand tables, then resolve pointers against the expanded
// JSON. Used to verify that every source fact survives the model representation.
function decode(encoded) {
  const references = new WeakMap();
  function expand(value, literal = false) {
    if (Array.isArray(value)) return value.map((item) => expand(item));
    if (!value || typeof value !== "object") return value;
    if (!literal && Object.hasOwn(value, "$ref")) {
      const reference = {}; references.set(reference, value.$ref); return reference;
    }
    if (!literal && Object.hasOwn(value, "$literal")) return expand(value.$literal, true);
    if (!literal && Object.hasOwn(value, "$columns")) return value.$rows.map((row) => Array.isArray(row)
      ? Object.fromEntries(value.$columns.map((key, index) => [key, expand(row[index])])) : expand(row));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
  }
  const expanded = expand(encoded);
  function resolve(value) {
    if (!value || typeof value !== "object") return value;
    if (references.has(value)) {
      const path = references.get(value);
      const target = path === "" ? expanded : path.slice(1).split("/").reduce((node, key) => node[key.replace(/~1/g, "/").replace(/~0/g, "~")], expanded);
      return resolve(target);
    }
    return Array.isArray(value) ? value.map(resolve) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  }
  return resolve(expanded);
}
const unpack = (message) => {
  const value = JSON.parse(message.content);
  return value.modelContextEncoding ? decode(value.data) : value.modelContextTruncated ? value.data : value;
};
const call = (id, agent, args) => new AIMessage({ content: "", tool_calls: [{ id, name: `${agent.toLowerCase()}_database_action`, type: "tool_call", args }] });
const result = (id, value) => new ToolMessage({ tool_call_id: id, content: JSON.stringify(value) });
const records = (count = 25) => Array.from({ length: count }, (_, index) => ({
  key: `RECORD-${index}`, title: `Stored record ${index}`, status: index === count - 1 ? "BLOCKED" : "ACTIVE",
  score: index * 3, capacity: 8, active: index % 2 === 0, optional: null,
  detail: `Distinct detail ${index} ` + "background evidence ".repeat(12),
  children: [{ key: `CHILD-${index}`, points: index, reason: index === count - 1 ? "Dependency unavailable" : null }],
}));

test("Generic JSON packing preserves nested records, repeated subsets, order and all scalar values", () => {
  const rows = records();
  const source = { ok: true, result: { arbitraryRows: rows, selected: [rows[24], rows[0]], hasMore: false, nextSkip: null } };
  const encoded = encodeContextValue(source);
  assert.deepEqual(decode(encoded), source);
  assert.ok(JSON.stringify(encoded).length < JSON.stringify(source).length);
  assert.match(JSON.stringify(encoded), /\$columns/);
  assert.match(JSON.stringify(encoded), /\$ref/);
});

test("Packing escapes reserved keys, pointer characters, Unicode and prototype-shaped data", () => {
  const shared = { title: "ऐतिहासिक प्रमाण 🧪", detail: "Long shared value ".repeat(15), optional: null };
  const source = JSON.parse('{"__proto__":{"polluted":true}}');
  Object.assign(source, { "a/~": shared, repeat: shared, $ref: "literal reference", $columns: ["ordinary"], $rows: [[1]], $literal: { $ref: "still literal" } });
  assert.deepEqual(decode(encodeContextValue(source)), source);
  assert.equal({}.polluted, undefined);
  assert.equal(encodeToolContent("plain text"), "plain text");
  assert.equal(encodeToolContent('{"ok":true}'), '{"ok":true}');
});

test("Empty, heterogeneous and differently ordered object arrays retain their original meaning", () => {
  for (const source of [[], [null, 0, false, "", { x: 1 }], [{ a: 1 }, { b: 2 }], [{ a: 1, b: 2 }, { b: 3, a: 4 }]]) {
    assert.deepEqual(decode(encodeContextValue(source)), source);
  }
});

test("Lossless context selection retains the last record and duplicate evidence after a rejected call", () => {
  const rows = records(10);
  const payload = { ok: true, operation: "calculate", result: { entries: rows, selected: rows.slice(-2) } };
  const history = [new HumanMessage("Compare these records and recommend changes"),
    call("bad", "SPRINT_TASK", { collection: "sprints", operation: "calculate", sort: { sprintNumber: 14 } }), result("bad", { ok: false, error: "NATIVE_MUTATIONS_NOT_ALLOWED" }),
    call("good", "SPRINT_TASK", { collection: "sprints", operation: "calculate", metric: "sprint_overload_summary" }), result("good", payload)];
  const original = history.at(-1).content;
  const rawSize = estimateRequestTokens(history);
  const selected = prepareModelMessages("Use backend evidence.", history, [], rawSize - 300, { allowTruncation: false });
  assert.deepEqual(unpack(selected.at(-1)), payload);
  assert.equal(history.at(-1).content, original);
  assert.deepEqual(selected.filter((message) => message.getType() === "tool").map((message) => message.tool_call_id), ["bad", "good"]);
  assert.equal(selected[1], history[0]);
});

test("Actual read-result excerpts preserve all top-level records and signal missing nested details", () => {
  const rows = records(12).map((row) => ({ ...row, detail: row.detail.repeat(40), children: records(20) }));
  const payload = { ok: true, result: { items: rows, hasMore: true, nextSkip: 12 } };
  const history = [new HumanMessage("Summarize the records"), call("large", "BUG", { operation: "find" }), result("large", payload)];
  const selected = prepareModelMessages("Use confirmed facts.", history, [], 3500);
  const body = JSON.parse(selected.at(-1).content), data = unpack(selected.at(-1));
  assert.equal(body.modelContextTruncated, true);
  assert.equal(data.result.items.length, 12);
  assert.equal(data.result.items[11].status, "BLOCKED");
  assert.equal(data.result.hasMore, true);
  assert.equal(data.result.nextSkip, 12);
  assert.ok(data.result.items[0].children.at(-1).omittedItems > 0);
  assert.ok(estimateRequestTokens(selected) <= 3500);
});

test("Mutation results and unknown action results cannot be shortened to fit a budget", () => {
  const receipt = { ok: true, result: { insertedId: "bbbbbbbbbbbbbbbbbbbbbbbb", document: { content: "Saved exact text ".repeat(500) } } };
  for (const operation of ["insert_one", "update_many", "unknown_action"]) {
    const history = [new HumanMessage("Apply the requested change"), call("write", "REQUIREMENTS", { operation }), result("write", receipt)];
    assert.throws(() => prepareModelMessages("Preserve receipts.", history, [], 1000), /MODEL_CONTEXT_TOO_LARGE/);
    assert.equal(history.at(-1).content, JSON.stringify(receipt));
  }
});

function graphFixture(t) {
  const paths = [require.resolve("@langchain/langgraph-checkpoint-mongodb"), require.resolve("../src/agent/specialist-agent.ts")];
  const previous = paths.map((path) => require.cache[path]);
  class TestSaver extends MemorySaver { constructor() { super(); } async setup() {} }
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { MongoDBSaver: TestSaver } };
  delete require.cache[paths[1]];
  t.after(() => paths.forEach((path, index) => { if (previous[index]) require.cache[path] = previous[index]; else delete require.cache[path]; }));
  t.mock.method(database, "getMongoClient", async () => ({}));
  return require("../src/agent/specialist-agent.ts");
}

test("Every specialist recovers from oversized context through the shared evidence-only answer step", async (t) => {
  const { runSpecialistAgent } = graphFixture(t);
  const payload = { ok: true, result: { items: records(), hasMore: false } };
  let active, boundCalls = 0, finalCalls = 0, reads = 0;
  t.mock.method(actions, "executeDatabaseAction", async () => { reads++; return payload; });
  t.mock.method(models, "getModel", () => ({
    bindTools(tools) { return { async invoke(messages) {
      assert.ok(estimateRequestTokens(messages, tools.map((tool) => convertToOpenAITool(tool))) <= 5000);
      if (++boundCalls === 1) return call("read", active.agent, { collection: active.collection, operation: "find", filter: {} });
      throw Object.assign(new Error("Provider request too large"), { status: 413 });
    } }; },
    async invoke(messages) {
      finalCalls++;
      assert.ok(estimateRequestTokens(messages) <= 5000);
      assert.match(messages[0].content, /Tools are disabled/);
      assert.doesNotMatch(messages[0].content, /APPROVED SCHEMA/);
      assert.deepEqual(unpack(messages.findLast((message) => message.getType() === "tool")), payload);
      assert.ok(messages.some((message) => message.content === active.question));
      return new AIMessage("RECORD-24 is blocked. Review its dependency before moving work.");
    },
  }));
  for (const [agent, collection, question] of [
    ["REQUIREMENTS", "user_stories", "Compare the saved requirements"],
    ["SPRINT_TASK", "tasks", "Who is overloaded in Sprint 14, and what should we rebalance?"],
    ["BUG", "bugs", "Which issues need attention?"],
    ["RELEASE", "releases", "Summarize release evidence"],
    ["DOCUMENTATION", "documents", "What does the migration guide say?"],
  ]) {
    active = { agent, collection, question }; boundCalls = 0;
    const output = await runSpecialistAgent({ agent, caller: lead, threadId: `generic-budget-${agent}`, message: question });
    assert.match(output.response, /RECORD-24 is blocked/);
    assert.equal(output.trace.length, 1);
    assert.deepEqual(output.trace[0].result, payload);
  }
  assert.equal(finalCalls, 5);
  assert.equal(reads, 5, "model retries must not rerun database calls");
});

test("If both model steps fail after a write, the response retains its receipt and unfinished work", async (t) => {
  const { runSpecialistAgent } = graphFixture(t);
  let calls = 0, writes = 0, finalCalls = 0;
  t.mock.method(actions, "executeDatabaseAction", async () => { writes++; return { ok: true, result: { insertedId: "bbbbbbbbbbbbbbbbbbbbbbbb" } }; });
  t.mock.method(models, "getModel", () => ({
    bindTools: () => ({ async invoke() {
      if (++calls === 1) return call("insert", "SPRINT_TASK", { collection: "tasks", operation: "insert_one", reason: "Create the requested task", fieldsJson: '[{"field":"title","stringValue":"Implement login"}]' });
      throw Object.assign(new Error("Request too large"), { status: 413 });
    } }),
    async invoke() { finalCalls++; throw Object.assign(new Error("Request too large"), { status: 413 }); },
  }));
  const output = await runSpecialistAgent({ agent: "SPRINT_TASK", caller: lead, threadId: "receipt-fallback", message: "Create the first task, then prepare the other changes" });
  assert.match(output.response, /created bbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.match(output.response, /remaining work is unfinished/);
  assert.doesNotMatch(output.response, /start a new chat|No actions/);
  assert.equal(writes, 1);
  assert.equal(finalCalls, 1, "a final request that cannot shrink must not be repeated");
  assert.equal(output.trace.length, 1);
});

test("Textual tool calls trigger an evidence-only answer without executing the printed action", async (t) => {
  const { runSpecialistAgent } = graphFixture(t);
  let reads = 0, boundCalls = 0, finalCalls = 0;
  const payload = { ok: true, result: { items: [{ taskKey: "TASK-14", status: "BLOCKED" }], hasMore: false } };
  t.mock.method(actions, "executeDatabaseAction", async () => { reads++; return payload; });
  t.mock.method(models, "getModel", () => ({
    bindTools: () => ({ async invoke() {
      if (++boundCalls === 1) return call("read", "SPRINT_TASK", { collection: "tasks", operation: "find", filter: { status: "BLOCKED" } });
      return new AIMessage('<tool_call><function=sprint_task_database_action><parameter=operation>update_one</parameter></function></tool_call>');
    } }),
    async invoke(messages) {
      finalCalls++;
      assert.deepEqual(unpack(messages.findLast((message) => message.getType() === "tool")), payload);
      assert.ok(messages.every((message) => !String(message.content).includes("<tool_call>")));
      return new AIMessage("TASK-14 is blocked.");
    },
  }));
  const result = await runSpecialistAgent({ agent: "SPRINT_TASK", caller: lead, threadId: "printed-tool-call", message: "Which tasks are blocked?" });
  assert.equal(result.response, "TASK-14 is blocked.");
  assert.equal(reads, 1);
  assert.equal(finalCalls, 1);
  assert.equal(result.trace.length, 1);
});

test("Repeated textual or malformed tool calls return an honest fallback without leaking markup", async (t) => {
  const { runSpecialistAgent } = graphFixture(t);
  let reads = 0;
  t.mock.method(actions, "executeDatabaseAction", async () => { reads++; throw new Error("Printed calls must never execute"); });
  for (const [index, malformed] of [
    new AIMessage("<tool_call><function=sprint_task_database_action></function></tool_call>"),
    new AIMessage(String.raw`\<tool\_call> \<function=sprint\_task\_database\_action> \</function> \</tool\_call>`),
    new AIMessage({ content: "", invalid_tool_calls: [{ name: "sprint_task_database_action", args: "{", error: "Invalid JSON", type: "invalid_tool_call" }] }),
  ].entries()) {
    t.mock.method(models, "getModel", () => ({ bindTools: () => ({ async invoke() { return malformed; } }), async invoke() { return malformed; } }));
    const result = await runSpecialistAgent({ agent: "SPRINT_TASK", caller: lead, threadId: `malformed-tool-${index}`, message: "Which tasks are blocked?" });
    assert.match(result.response, /No database action was completed/);
    assert.doesNotMatch(result.response, /tool.call|<function|No response generated/);
    assert.equal(result.trace.length, 0);
  }
  assert.equal(reads, 0);
});
