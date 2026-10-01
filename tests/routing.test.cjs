const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { MemorySaver } = require("@langchain/langgraph");
const database = require("../src/db/mongodb.ts");
const models = require("../src/agent/model.ts");
const { routeAgent } = require("../src/agent/router.ts");
const { validateMongoAction } = require("../src/security/mongo-validator.ts");

const lead = { mongoUserId: "aaaaaaaaaaaaaaaaaaaaaaaa", userKey: "u-el-1", name: "Lead", role: "ENGINEERING_LEAD", active: true };

function routerFixture(t, selectedAgent = "DOCUMENTATION") {
  const session = { lastAgent: "DOCUMENTATION" };
  const writes = [], prompts = [];
  const db = { collection(name) {
    assert.equal(name, "chat_sessions");
    return {
      async findOne() { return session; },
      async updateOne(filter, update, options) { writes.push({ filter, update, options }); Object.assign(session, update.$set); },
    };
  } };
  t.mock.method(database, "getDb", async () => db);
  t.mock.method(models, "getRouterModel", () => ({ withStructuredOutput: () => ({
    async invoke(messages) { prompts.push(messages); return { agent: selectedAgent, reason: "Test selection" }; },
  }) }));
  return { writes, prompts, session };
}

test("Engineering Lead story list overrides a previous Documentation route without consulting the model", async (t) => {
  const f = routerFixture(t);
  assert.equal(await routeAgent(lead, "stories", "show all user stories"), "REQUIREMENTS");
  assert.equal(f.prompts.length, 0);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].filter.sessionKey, `${lead.mongoUserId}:stories`);
  assert.equal(f.writes[0].update.$set.lastAgent, "REQUIREMENTS");
  assert.equal(f.writes[0].update.$set.role, "ENGINEERING_LEAD");
  assert.equal(f.writes[0].options.upsert, true);
});

test("Story list variants and explicit collection names route to Requirements", async (t) => {
  const f = routerFixture(t);
  for (const message of ["Please show me all the user stories!", "LIST USER STORIES", "get user_stories", "display the user stories please."]) {
    assert.equal(await routeAgent(lead, "variants", message), "REQUIREMENTS", message);
  }
  assert.equal(f.prompts.length, 0);
});

test("Product Managers retain Requirements access for story lists", async (t) => {
  const f = routerFixture(t);
  assert.equal(await routeAgent({ ...lead, role: "PRODUCT_MANAGER" }, "pm", "list user stories"), "REQUIREMENTS");
  assert.equal(f.prompts.length, 0);
});

test("Developer story lists use the Sprint agent with the existing ownership restriction", async (t) => {
  const f = routerFixture(t);
  const developer = { ...lead, role: "DEVELOPER" };
  const agent = await routeAgent(developer, "dev", "show all user stories");
  assert.equal(agent, "SPRINT_TASK");
  assert.doesNotThrow(() => validateMongoAction(agent, developer, { collection: "user_stories", operation: "find" }));
  const { getRolePolicy } = require("../src/security/policy.ts");
  assert.equal(getRolePolicy(agent, developer.role).user_stories.scope, "OWN");
  assert.equal(f.prompts.length, 0);
});

test("Routing QA story requests does not grant access to story records", async (t) => {
  routerFixture(t);
  const qa = { ...lead, role: "QA" };
  const agent = await routeAgent(qa, "qa", "show all user stories");
  assert.equal(agent, "REQUIREMENTS");
  assert.throws(() => validateMongoAction(agent, qa, { collection: "user_stories", operation: "find" }), /COLLECTION_NOT_ALLOWED:user_stories/);
});

test("Simple collection lists use their owning specialist", async (t) => {
  const f = routerFixture(t);
  for (const [entity, agent] of [
    ["feature requests", "REQUIREMENTS"], ["epics", "REQUIREMENTS"],
    ["tasks", "SPRINT_TASK"], ["sprints", "SPRINT_TASK"], ["bugs", "BUG"],
    ["test cases", "BUG"], ["releases", "RELEASE"], ["documents", "DOCUMENTATION"],
  ]) assert.equal(await routeAgent(lead, "collections", `show all ${entity}`), agent);
  assert.equal(f.prompts.length, 0);
});

test("User-story documentation questions still use the semantic router", async (t) => {
  const f = routerFixture(t);
  const message = "Show documentation about writing user stories";
  assert.equal(await routeAgent(lead, "docs", message), "DOCUMENTATION");
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].at(-1).content, message);
  assert.match(f.prompts[0][0].content, /REQUIREMENTS:.*Permitted collections: feature_requests, epics, user_stories/);
});

test("Filtered lists, draft requests and multi-action messages stay with the semantic router", async (t) => {
  const f = routerFixture(t, "REQUIREMENTS");
  for (const message of ["Show all approved user stories", "Draft user stories for CSV import", "Show user stories and create tasks"]) {
    assert.equal(await routeAgent(lead, "semantic", message), "REQUIREMENTS");
  }
  assert.equal(f.prompts.length, 3);
});

test("Unrecognized entity names cannot resolve inherited properties of the routing table", async (t) => {
  const f = routerFixture(t);
  assert.equal(await routeAgent(lead, "unknown", "show constructor"), "DOCUMENTATION");
  assert.equal(f.prompts.length, 1);
});

test("An ambiguous follow-up sees the specialist selected by the preceding explicit list", async (t) => {
  const f = routerFixture(t, "REQUIREMENTS");
  await routeAgent(lead, "followup", "show all user stories");
  await routeAgent(lead, "followup", "Which ones are approved?");
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0][0].content, /Previous specialist agent in this session: REQUIREMENTS/);
});

test("Task assignment routes to Sprint/Task even after a Requirements conversation", async (t) => {
  const f = routerFixture(t, "REQUIREMENTS");
  f.session.lastAgent = "REQUIREMENTS";
  for (const message of ["assign task-207 to rahul kumar", "Please reassign TASK-207 to rahul@example.com"]) {
    assert.equal(await routeAgent(lead, "assignment", message), "SPRINT_TASK");
  }
  assert.equal(f.prompts.length, 0);
});

test("An ID-only reply stays with the previous specialist, including quoted IDs", async (t) => {
  const f = routerFixture(t, "REQUIREMENTS");
  f.session.lastAgent = "SPRINT_TASK";
  for (const message of ['"6aba3de4d6f922d2386934bc"', "6aba3de4d6f922d2386934bc", "'6aba3de4d6f922d2386934bc'", "`6aba3de4d6f922d2386934bc`"]) {
    assert.equal(await routeAgent(lead, "id-reply", message), "SPRINT_TASK");
  }
  assert.equal(f.prompts.length, 0);
  assert.equal(f.session.lastAgent, "SPRINT_TASK");
});

test("Identifier handling does not override explicit topics or invent a previous specialist", async (t) => {
  const f = routerFixture(t, "REQUIREMENTS");
  f.session.lastAgent = "SPRINT_TASK";
  assert.equal(await routeAgent(lead, "topic", "Show story 6aba3de4d6f922d2386934bc"), "REQUIREMENTS");
  for (const lastAgent of [undefined, "UNKNOWN_AGENT"]) {
    f.session.lastAgent = lastAgent;
    assert.equal(await routeAgent(lead, "no-session", "6aba3de4d6f922d2386934bc"), "REQUIREMENTS");
  }
  assert.equal(f.prompts.length, 3);
});

test("The chat path lists stored stories across pages after a Documentation conversation", async (t) => {
  const rows = Array.from({ length: 27 }, (_, i) => ({
    _id: new ObjectId(i.toString(16).padStart(24, "0")), storyKey: `US-${i + 1}`,
    title: `Stored story ${i + 1}`, status: i % 2 ? "APPROVED" : "DRAFT", storyPoints: 3,
  }));
  const reads = [], audits = [];
  let closed = 0;
  const session = { lastAgent: "DOCUMENTATION" };
  const db = { collection(name) {
    if (name === "chat_sessions") return {
      async findOne() { return session; },
      async updateOne(_filter, update) { Object.assign(session, update.$set); },
    };
    if (name === "audit_logs") return { async insertOne(entry) { audits.push(entry); } };
    assert.equal(name, "user_stories", "this request must read stories rather than documents");
    return { find(filter, options) {
      const call = { filter, options, skip: 0, limit: Infinity };
      reads.push(call);
      return {
        sort(value) { call.sort = value; return this; },
        skip(value) { call.skip = value; return this; },
        limit(value) { call.limit = value; return this; },
        async *[Symbol.asyncIterator]() { yield* rows.slice(call.skip, call.skip + call.limit); },
        async close() { closed++; },
      };
    } };
  } };
  t.mock.method(database, "getDb", async () => db);
  t.mock.method(database, "getMongoClient", async () => ({}));
  t.mock.method(models, "getRouterModel", () => { throw new Error("Explicit story lists must not use the model router"); });
  t.mock.method(models, "getModel", () => { throw new Error("Simple lists must not send records to a model"); });
  // Give this graph its own memory checkpointer, including when the approval
  // suite has already loaded a specialist graph in the same Node process.
  const paths = [require.resolve("@langchain/langgraph-checkpoint-mongodb"), require.resolve("../src/agent/specialist-agent.ts"), require.resolve("../src/agent/supervisor.ts")];
  const previous = paths.map((path) => require.cache[path]);
  class TestSaver extends MemorySaver { constructor() { super(); } async setup() {} }
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { MongoDBSaver: TestSaver } };
  delete require.cache[paths[1]];
  delete require.cache[paths[2]];
  t.after(() => paths.forEach((path, i) => { if (previous[i]) require.cache[path] = previous[i]; else delete require.cache[path]; }));
  const { runChat } = require("../src/agent/supervisor.ts");
  const result = await runChat({ caller: lead, sessionId: "story-regression", message: "show all user stories" });
  assert.equal(result.agent, "REQUIREMENTS");
  assert.equal(session.lastAgent, "REQUIREMENTS");
  assert.equal(result.trace.length, 2);
  assert.ok(result.trace.every((entry) => entry.guardrail === "ALLOWED"));
  assert.match(result.response, /\| Story Key \| Title \| Epic ID \| Points \| Priority \| Status \|/);
  assert.match(result.response, /\| US-1 \| Stored story 1 \|/);
  assert.match(result.response, /\| US-27 \| Stored story 27 \|/);
  assert.match(result.response, /Listed all 27 records/);
  assert.doesNotMatch(result.response, /Not documented/i);
  assert.deepEqual(reads.map((call) => call.filter), [{}, {}]);
  assert.deepEqual(reads.map((call) => call.skip), [0, 25]);
  assert.equal(closed, 2);
  assert.equal(audits.length, 2);
  const services = require("../src/services/requirements-review.service.ts");
  t.mock.method(services, "getRequirementsReviewService", () => { throw new Error("Listing records must not begin or invalidate a PM review"); });
  const pmList = await runChat({ caller: { ...lead, role: "PRODUCT_MANAGER" }, sessionId: "pm-list", message: "show all user stories" });
  assert.match(pmList.response, /Listed all 27 records/);
});
