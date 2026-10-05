const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MongoClient } = require("mongodb");
const { MemorySaver } = require("@langchain/langgraph");
const { AIMessage } = require("@langchain/core/messages");
const database = require("../src/db/mongodb.ts");
const models = require("../src/agent/model.ts");
const users = require("../src/repositories/user.repository.ts");
const { databaseErrorResponse } = require("../src/utils/database-errors.ts");
const { makeDatabaseTool } = require("../src/agent/db-tool.ts");
const lead = { mongoUserId: "aaaaaaaaaaaaaaaaaaaaaaaa", userKey: "u-el-1", name: "Lead", role: "ENGINEERING_LEAD", active: true };
const connectionError = (name = "MongoServerSelectionError") => Object.assign(new Error("Server selection timed out after 10000 ms; mongodb://private:secret@internal.invalid"), { name });

function environment(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}
async function connectionFixture(t, connect = async function () { return this; }) {
  await database.closeMongoClients();
  environment(t, "MONGODB_URI", "mongodb://unit-test.invalid");
  environment(t, "MONGODB_SERVER_SELECTION_TIMEOUT_MS", undefined);
  const attempts = [], closed = [];
  t.mock.method(MongoClient.prototype, "connect", async function () { attempts.push(this); return connect.call(this); });
  t.mock.method(MongoClient.prototype, "close", async function () { closed.push(this); });
  t.after(() => database.closeMongoClients());
  return { attempts, closed };
}

test("Concurrent requests share one connection attempt and the default 30-second selection window", async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = await connectionFixture(t, async function () { await pending; return this; });
  const requests = Array.from({ length: 8 }, () => database.getMongoClient());
  assert.equal(f.attempts.length, 1);
  release();
  const clients = await Promise.all(requests);
  assert.ok(clients.every((client) => client === clients[0]));
  assert.equal(clients[0].options.serverSelectionTimeoutMS, 30000);
  assert.equal(clients[0].options.maxPoolSize, 10);
});

test("Reloading the MongoDB module reuses the existing process connection", async (t) => {
  const f = await connectionFixture(t);
  const first = await database.getMongoClient();
  const path = require.resolve("../src/db/mongodb.ts"), previous = require.cache[path];
  delete require.cache[path];
  t.after(() => { require.cache[path] = previous; });
  assert.equal(await require(path).getMongoClient(), first);
  assert.equal(f.attempts.length, 1);
});

test("A failed connection is closed and a later request can connect without replaying work", async (t) => {
  const outage = connectionError();
  let fail = true;
  const f = await connectionFixture(t, async function () { if (fail) { fail = false; throw outage; } return this; });
  await assert.rejects(database.getMongoClient(), (error) => error === outage);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.closed.length, 1);
  const recovered = await database.getMongoClient();
  assert.equal(f.attempts.length, 2);
  assert.notEqual(recovered, f.closed[0]);
});

test("Cleanup errors do not replace the original connection failure", async (t) => {
  const outage = connectionError();
  await connectionFixture(t, async () => { throw outage; });
  t.mock.method(MongoClient.prototype, "close", async () => { throw Error("cleanup failed"); });
  await assert.rejects(database.getMongoClient(), (error) => error === outage);
});

test("Connection settings are configurable and separate URIs do not share clients", async (t) => {
  const f = await connectionFixture(t);
  process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS = "45000";
  const first = await database.getMongoClient();
  assert.equal(first.options.serverSelectionTimeoutMS, 45000);
  process.env.MONGODB_URI = "mongodb://another-unit-test.invalid";
  const second = await database.getMongoClient();
  assert.notEqual(first, second);
  assert.equal(f.attempts.length, 2);
});

test("Invalid timeout values fail before creating a connection", async (t) => {
  const f = await connectionFixture(t);
  for (const value of ["0", "999", "60001", "1.5", "NaN", "Infinity"]) {
    process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS = value;
    await assert.rejects(database.getMongoClient(), /MONGODB_SERVER_SELECTION_TIMEOUT_MS/);
  }
  assert.equal(f.attempts.length, 0);
});

test("Database outage mapping follows wrapped causes and never exposes connection details", () => {
  for (const name of ["MongoServerSelectionError", "MongoNetworkError", "MongoNetworkTimeoutError", "MongoPoolClearedError"]) {
    const response = databaseErrorResponse(new Error("Read failed", { cause: connectionError(name) }));
    assert.equal(response.status, 503);
    assert.equal(response.code, "DATABASE_UNAVAILABLE");
    assert.doesNotMatch(response.message, /mongodb:|private|secret|internal|10000/);
  }
  const circular = new Error("ordinary error"); circular.cause = circular;
  assert.equal(databaseErrorResponse(circular), undefined);
  assert.equal(databaseErrorResponse(new Error("USER_NOT_FOUND")), undefined);
  assert.equal(databaseErrorResponse(Object.assign(new Error("Authentication failed"), { name: "MongoServerError", code: 18 })), undefined);
});

const chatRequest = () => new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "u-el-1", sessionId: "db-outage", message: "is there anyone overloaded in sprint 14.suggest rebalance" }) });

test("Chat returns HTTP 503 before invoking the model when caller lookup cannot reach MongoDB", async (t) => {
  const supervisor = require("../src/agent/supervisor.ts");
  t.mock.method(users, "resolveCaller", async () => { throw connectionError(); });
  let calls = 0;
  t.mock.method(supervisor, "runChat", async () => { calls++; });
  const { POST } = require("../app/api/chat/route.ts");
  const response = await POST(chatRequest());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "DATABASE_UNAVAILABLE");
  assert.doesNotMatch(body.error, /private|mongodb:|10000/);
  assert.equal(calls, 0);
});

test("A database timeout during chat does not resubmit the request or claim no changes occurred", async (t) => {
  const supervisor = require("../src/agent/supervisor.ts");
  t.mock.method(users, "resolveCaller", async () => lead);
  let calls = 0;
  t.mock.method(supervisor, "runChat", async () => { calls++; throw connectionError("MongoNetworkTimeoutError"); });
  const response = await require("../app/api/chat/route.ts").POST(chatRequest());
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
  assert.doesNotMatch((await response.json()).error, /no (?:data|records|changes)/i);
});

test("Health checks report a database outage without invoking Groq", async (t) => {
  t.mock.method(database, "getDb", async () => ({ async command() { throw connectionError(); } }));
  t.mock.method(models, "getModel", () => { throw Error("Groq must not run while MongoDB is down"); });
  const response = await require("../app/api/health/route.ts").GET();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).mongodb, "unavailable");
});

test("Read and calculation outages avoid another connection attempt for the audit", async (t) => {
  let connections = 0;
  t.mock.method(database, "getDb", async () => { connections++; throw connectionError(); });
  for (const [agent, input] of [
    ["REQUIREMENTS", { collection: "feature_requests", operation: "findOne", filter: {} }],
    ["SPRINT_TASK", { collection: "sprints", operation: "calculate", metric: "sprint_overload_summary", conditionsJson: '[{"field":"sprintNumber","operator":"eq","numberValue":14}]' }],
  ]) {
    connections = 0;
    const response = JSON.parse(await makeDatabaseTool(agent, lead, []).invoke(input));
    assert.equal(response.code, "DATABASE_UNAVAILABLE");
    assert.equal(connections, 1);
    assert.doesNotMatch(response.error, /mongodb:|private|secret/);
  }
});

test("A review outage returns HTTP 503 and preserves retrying the same approval receipt", async (t) => {
  const service = require("../src/services/requirements-review.service.ts");
  t.mock.method(users, "resolveCaller", async () => ({ ...lead, role: "PRODUCT_MANAGER" }));
  let approvals = 0;
  t.mock.method(service, "getRequirementsReviewService", async () => ({ async approve() { approvals++; throw connectionError(); } }));
  const request = new Request("http://localhost/api/requirements/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    userId: "u-pm-1", sessionId: "review-outage", action: "approve",
    review: { id: "bbbbbbbbbbbbbbbbbbbbbbbb", featureTitle: "Feature", draft: { featureRequestId: "cccccccccccccccccccccccc", epic: { title: "Epic", description: "Description" }, stories: [] } },
  }) });
  const response = await require("../app/api/requirements/review/route.ts").POST(request);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "DATABASE_UNAVAILABLE");
  assert.match(body.error, /retry this same review/);
  assert.equal(approvals, 1);
});

function graphFixture(t, failure) {
  const paths = [require.resolve("@langchain/langgraph-checkpoint-mongodb"), require.resolve("../src/agent/specialist-agent.ts")];
  const previous = paths.map((path) => require.cache[path]);
  const counts = { clients: 0, setups: 0, models: 0 };
  class TestSaver extends MemorySaver {
    constructor() { super(); }
    async setup() { if (++counts.setups === 1 && failure === "setup") throw connectionError(); }
  }
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { MongoDBSaver: TestSaver } };
  delete require.cache[paths[1]];
  t.after(() => paths.forEach((path, index) => { if (previous[index]) require.cache[path] = previous[index]; else delete require.cache[path]; }));
  t.mock.method(database, "getMongoClient", async () => { if (++counts.clients === 1 && failure === "client") throw connectionError(); return {}; });
  t.mock.method(models, "getModel", () => ({ bindTools: () => ({ async invoke() { counts.models++; return new AIMessage("Connection recovered."); } }) }));
  return { ...require("../src/agent/specialist-agent.ts"), counts };
}

for (const failure of ["client", "setup"]) test(`Checkpoint initialization recovers on the next request after a ${failure} failure`, async (t) => {
  const f = graphFixture(t, failure);
  const input = { agent: "SPRINT_TASK", caller: lead, threadId: `recover-${failure}`, message: "Summarize sprint workload" };
  await assert.rejects(f.runSpecialistAgent(input), { name: "MongoServerSelectionError" });
  assert.equal(f.counts.models, 0);
  const result = await f.runSpecialistAgent(input);
  assert.equal(result.response, "Connection recovered.");
  assert.equal(f.counts.clients, 2);
  assert.equal(f.counts.models, 1);
});

test("An outage after a completed write returns its receipt without another model call or write", async (t) => {
  const f = graphFixture(t);
  const service = require("../src/services/database-action.service.ts");
  let calls = 0, writes = 0;
  t.mock.method(service, "executeDatabaseAction", async (_agent, _caller, action) => {
    if (action.operation === "insert_one") { writes++; return { ok: true, result: { insertedId: "bbbbbbbbbbbbbbbbbbbbbbbb" } }; }
    throw connectionError();
  });
  t.mock.method(models, "getModel", () => ({ bindTools: () => ({ async invoke() {
    calls++;
    assert.ok(calls <= 2);
    const args = calls === 1 ? { collection: "tasks", operation: "insert_one", reason: "Create requested task", fieldsJson: '[{"field":"title","stringValue":"New task"}]' }
      : { collection: "tasks", operation: "find", filter: {} };
    return new AIMessage({ content: "", tool_calls: [{ id: `call-${calls}`, name: "sprint_task_database_action", type: "tool_call", args }] });
  } }) }));
  const result = await f.runSpecialistAgent({ agent: "SPRINT_TASK", caller: lead, threadId: "outage-after-write", message: "Create the task, then inspect the backlog" });
  assert.match(result.response, /temporarily unavailable/);
  assert.match(result.response, /created bbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.match(result.response, /remaining work is unfinished/);
  assert.equal(writes, 1);
  assert.equal(calls, 2);
});
