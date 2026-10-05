const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const database = require("../src/db/mongodb.ts");
const { makeDatabaseTool } = require("../src/agent/db-tool.ts");

const lead = { mongoUserId: "aaaaaaaaaaaaaaaaaaaaaaaa", userKey: "u-el-1", name: "Lead", role: "ENGINEERING_LEAD", active: true };
const rahulId = new ObjectId("6aba3de4d6f922d2386934bc");
const assignment = (identity, field = "assignee") => ({
  collection: "tasks", operation: "update_one", reason: "Assign TASK-207 to the requested developer",
  conditionsJson: JSON.stringify([{ field: "taskKey", operator: "eq", stringValue: "TASK-207" }]),
  fieldsJson: JSON.stringify([{ field, stringValue: identity }]),
});

function fixture(t, { found = true, matched = 1 } = {}) {
  const lookups = [], writes = [], audits = [], scopes = [];
  const session = {};
  t.mock.method(database, "getDb", async () => ({ collection(name) {
    if (name === "chat_sessions") return {
      async findOne() { return session; },
      async updateOne(_filter, update) { Object.assign(session, update.$set); },
    };
    if (name === "users") return {
      async findOne(filter, options) { lookups.push({ filter, options }); return found ? { _id: rahulId } : null; },
      find(filter) { scopes.push(filter); return { map(fn) { return { async toArray() { return [{ _id: rahulId }].map(fn); } }; } }; },
    };
    if (name === "audit_logs") return { async insertOne(entry) { audits.push(entry); } };
    assert.equal(name, "tasks");
    return {
      async findOne() { return { _id: new ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb"), taskKey: "TASK-207", title: "Epic 1 task 8", status: "TODO" }; },
      async updateOne(filter, update) { writes.push({ filter, update }); return { matchedCount: matched, modifiedCount: matched }; },
    };
  } }));
  return { lookups, writes, audits, scopes };
}

test("Engineering Lead assigns a task by name through the guarded tool and backend resolver", async (t) => {
  const f = fixture(t), traces = [];
  const result = JSON.parse(await makeDatabaseTool("SPRINT_TASK", lead, traces).invoke(assignment("rahul kumar")));
  assert.equal(result.ok, true);
  assert.equal(result.result.matchedCount, 1);
  assert.deepEqual(f.lookups[0].filter.$or.find((part) => part.name), { name: { $regex: "^rahul kumar$", $options: "i" } });
  assert.deepEqual(f.lookups[0].options.projection, { _id: 1 });
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].filter, { $and: [{ taskKey: "TASK-207" }, { $or: [
    { assigneeId: { $in: [new ObjectId(lead.mongoUserId), rahulId] } }, { createdBy: new ObjectId(lead.mongoUserId) },
  ] }] });
  assert.equal(String(f.writes[0].update.$set.assigneeId), String(rahulId));
  assert.equal(f.audits[0].executionStatus, "SUCCEEDED");
  assert.equal(traces[0].guardrail, "ALLOWED");
});

test("Engineering Lead assignment accepts the supplied MongoDB ID with either supported mutation field", async (t) => {
  const f = fixture(t), tool = makeDatabaseTool("SPRINT_TASK", lead, []);
  for (const field of ["assignee", "assigneeId"]) {
    const result = JSON.parse(await tool.invoke(assignment(String(rahulId), field)));
    assert.equal(result.result.modifiedCount, 1);
  }
  assert.equal(f.lookups.length, 0);
  assert.ok(f.writes.every((call) => String(call.update.$set.assigneeId) === String(rahulId)));
});

test("An unknown assignee returns the real lookup failure without updating the task", async (t) => {
  const f = fixture(t, { found: false });
  const result = JSON.parse(await makeDatabaseTool("SPRINT_TASK", lead, []).invoke(assignment("Unknown Developer")));
  assert.equal(result.ok, false);
  assert.match(result.error, /USER_REFERENCE_NOT_FOUND/);
  assert.equal(f.lookups.length, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(f.audits[0].executionStatus, "FAILED");
});

test("A malformed assignment identifies the missing condition operator before any lookup or update", async (t) => {
  const f = fixture(t);
  const input = { ...assignment("rahul kumar"), conditionsJson: '[{"field":"taskKey","stringValue":"TASK-207"}]' };
  const result = JSON.parse(await makeDatabaseTool("SPRINT_TASK", lead, []).invoke(input));
  assert.equal(result.ok, false);
  assert.match(result.error, /INVALID_BUSINESS_ACTION_JSON:conditionsJson\.0\.operator/);
  assert.equal(f.lookups.length, 0);
  assert.equal(f.writes.length, 0);
});

test("A task outside the Engineering Lead's scope retains a zero-match update result", async (t) => {
  const f = fixture(t, { matched: 0 });
  const result = JSON.parse(await makeDatabaseTool("SPRINT_TASK", lead, []).invoke(assignment("rahul kumar")));
  assert.equal(result.result.matchedCount, 0);
  assert.equal(result.result.modifiedCount, 0);
  assert.equal(f.scopes.length, 1);
  assert.equal(f.writes[0].filter.$and.length, 2);
});

test("Developer, PM and QA task reassignment attempts remain blocked before user lookup", async (t) => {
  const f = fixture(t);
  for (const role of ["DEVELOPER", "PRODUCT_MANAGER", "QA"]) {
    const result = JSON.parse(await makeDatabaseTool("SPRINT_TASK", { ...lead, role }, []).invoke(assignment("rahul kumar")));
    assert.equal(result.ok, false);
    assert.match(result.error, /FIELD_NOT_MUTABLE:assignee|OPERATION_NOT_ALLOWED:update_one/);
  }
  assert.equal(f.lookups.length, 0);
  assert.equal(f.writes.length, 0);
  assert.ok(f.audits.every((entry) => entry.executionStatus === "NOT_EXECUTED"));
});

test("Name resolution does not give the assistant native access to the users collection", async (t) => {
  const f = fixture(t);
  const result = JSON.parse(await makeDatabaseTool("SPRINT_TASK", lead, []).invoke({ collection: "users", operation: "find", filter: {} }));
  assert.equal(result.ok, false);
  assert.match(result.error, /COLLECTION_NOT_ALLOWED:users/);
  assert.equal(f.lookups.length, 0);
  assert.equal(f.writes.length, 0);
});

test("The chat graph resumes task assignment when an old conversation asks for a quoted user ID", async (t) => {
  const { MemorySaver } = require("@langchain/langgraph");
  const { AIMessage } = require("@langchain/core/messages");
  const models = require("../src/agent/model.ts");
  const f = fixture(t);
  const paths = [require.resolve("@langchain/langgraph-checkpoint-mongodb"), require.resolve("../src/agent/specialist-agent.ts"), require.resolve("../src/agent/supervisor.ts")];
  const previous = paths.map((path) => require.cache[path]);
  class TestSaver extends MemorySaver { constructor() { super(); } async setup() {} }
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { MongoDBSaver: TestSaver } };
  delete require.cache[paths[1]];
  delete require.cache[paths[2]];
  t.after(() => paths.forEach((path, i) => { if (previous[i]) require.cache[path] = previous[i]; else delete require.cache[path]; }));
  t.mock.method(database, "getMongoClient", async () => ({}));
  t.mock.method(models, "getRouterModel", () => { throw Error("Assignment and identifier follow-up must not use the model router"); });
  let calls = 0;
  const call = (id, args) => new AIMessage({ content: "", tool_calls: [{ id, name: "sprint_task_database_action", type: "tool_call", args }] });
  t.mock.method(models, "getModel", () => ({ bindTools: () => ({ async invoke(messages) {
    calls++;
    if (calls === 1) return call("read", { collection: "tasks", operation: "findOne", filter: { taskKey: "TASK-207" } });
    // Seed the legacy response so the follow-up matches the reported incident.
    if (calls === 2) return new AIMessage("Provide Rahul Kumar's MongoDB ID to assign TASK-207.");
    if (calls === 3) {
      assert.equal(messages.at(-1).content, '"6aba3de4d6f922d2386934bc"');
      assert.ok(messages.some((message) => String(message.content).includes("assign task-207 to rahul kumar")));
      return call("assign", assignment(String(rahulId)));
    }
    assert.equal(calls, 4);
    const receipt = JSON.parse(messages.at(-1).content);
    assert.equal(receipt.result.matchedCount, 1);
    return new AIMessage("TASK-207 is assigned to Rahul Kumar.");
  } }) }));
  const { runChat } = require("../src/agent/supervisor.ts");
  const input = { caller: lead, sessionId: "legacy-assignment" };
  await runChat({ ...input, message: "assign task-207 to rahul kumar" });
  const result = await runChat({ ...input, message: '"6aba3de4d6f922d2386934bc"' });
  assert.equal(result.agent, "SPRINT_TASK");
  assert.match(result.response, /TASK-207 is assigned to Rahul Kumar/);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].guardrail, "ALLOWED");
  assert.equal(f.writes.length, 1);
  assert.equal(String(f.writes[0].update.$set.assigneeId), String(rahulId));
});
