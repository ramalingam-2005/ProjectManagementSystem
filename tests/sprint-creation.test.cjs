const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { AIMessage } = require("@langchain/core/messages");
const { MemorySaver } = require("@langchain/langgraph");
const database = require("../src/db/mongodb.ts");
const models = require("../src/agent/model.ts");
const { makeDatabaseTool } = require("../src/agent/db-tool.ts");
const { executeDatabaseAction } = require("../src/services/database-action.service.ts");
const lead = { mongoUserId: "aaaaaaaaaaaaaaaaaaaaaaaa", userKey: "u-el-1", name: "Lead", role: "ENGINEERING_LEAD", active: true };
const memberId = new ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");
const numberField = { field: "sprintNumber", numberValue: 15 };
const input = (fields = [numberField]) => ({ collection: "sprints", operation: "insert_one", reason: "Create Sprint 15", fieldsJson: JSON.stringify(fields) });
const equal = (a, b) => a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a === b;
function values(row, parts) {
  if (!parts.length) return [row];
  if (Array.isArray(row)) return row.flatMap((item) => values(item, parts));
  return values(row?.[parts[0]], parts.slice(1));
}
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$and") return value.every((part) => matches(row, part));
    if (key === "$or") return value.some((part) => matches(row, part));
    return values(row, key.split(".")).some((stored) => {
      if (value && !(value instanceof ObjectId) && typeof value === "object") {
        if ("$in" in value) return value.$in.some((item) => equal(stored, item));
        if ("$ne" in value) return !equal(stored, value.$ne);
        throw new Error("Unsupported fixture operator");
      }
      return equal(stored, value);
    });
  });
}
function fixture(t) {
  const sprints = [{ _id: new ObjectId(), sprintNumber: 14, name: "Sprint 14", endDate: new Date("2026-10-11T23:59:59.999Z"), capacities: [{ developerId: memberId, capacity: 8 }] }];
  const reads = [], writes = [], audits = [];
  const session = { lastAgent: "SPRINT_TASK" };
  const state = { failInsert: false };
  t.mock.method(database, "getDb", async () => ({ collection(name) {
    if (name === "chat_sessions") return { async findOne() { return session; }, async updateOne(_filter, update) { Object.assign(session, update.$set); } };
    if (name === "audit_logs") return { async insertOne(entry) { audits.push(entry); } };
    const records = name === "users" ? [{ _id: memberId, reportsToUserId: new ObjectId(lead.mongoUserId), active: true }] : sprints;
    assert.ok(["sprints", "users"].includes(name));
    const project = (row, projection) => row && projection ? Object.fromEntries(Object.entries(row).filter(([key]) => projection[key] === 1)) : row;
    return {
      async findOne(filter, options) { reads.push({ name, filter }); return project(records.find((row) => matches(row, filter)) ?? null, options?.projection); },
      find(filter, options) {
        reads.push({ name, filter });
        let limit = Infinity, skip = 0, transform = (row) => row;
        const result = () => records.filter((row) => matches(row, filter)).slice(skip, skip + limit).map((row) => transform(project(row, options?.projection)));
        return { limit(n) { limit = n; return this; }, skip(n) { skip = n; return this; }, sort() { return this; }, map(fn) { transform = fn; return this; }, async toArray() { return result(); }, async *[Symbol.asyncIterator]() { yield* result(); }, async close() {} };
      },
      async insertOne(document) {
        assert.equal(name, "sprints");
        if (state.failInsert) throw new Error("Simulated insert failure");
        const stored = { ...document, _id: new ObjectId() };
        sprints.push(stored); writes.push(stored);
        return { insertedId: stored._id };
      },
    };
  } }));
  const traces = [];
  const tool = makeDatabaseTool("SPRINT_TASK", lead, traces);
  return { sprints, reads, writes, audits, state, traces, invoke: async (action = input()) => JSON.parse(await tool.invoke(action)) };
}

function graph(t) {
  const paths = [require.resolve("@langchain/langgraph-checkpoint-mongodb"), require.resolve("../src/agent/specialist-agent.ts")];
  const previous = paths.map((path) => require.cache[path]);
  class TestSaver extends MemorySaver { constructor() { super(); } async setup() {} }
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { MongoDBSaver: TestSaver } };
  delete require.cache[paths[1]];
  t.after(() => paths.forEach((path, index) => { if (previous[index]) require.cache[path] = previous[index]; else delete require.cache[path]; }));
  t.mock.method(database, "getMongoClient", async () => ({}));
  return require("../src/agent/specialist-agent.ts").runSpecialistAgent;
}
const toolCall = (id, args) => new AIMessage({ content: "", tool_calls: [{ id, name: "sprint_task_database_action", type: "tool_call", args }] });

test("insert_one rejects documentsJson, mixed and missing fields before any business read or write", async (t) => {
  const f = fixture(t);
  for (const payload of [
    { ...input(), fieldsJson: undefined },
    { ...input(), fieldsJson: undefined, documentsJson: '[{"sprintNumber":{"numberValue":15}}]' },
    { ...input(), fieldsJson: undefined, documentsJson: JSON.stringify([{ fields: [numberField] }]) },
    { ...input(), documentsJson: "malformed" },
    input([]), input({ sprintNumber: 15 }),
  ]) {
    const result = await f.invoke(payload);
    assert.equal(result.ok, false);
    assert.match(result.error, /INVALID_INSERT_PAYLOAD:.*insert_one requires fieldsJson|INVALID_BUSINESS_ACTION_JSON:fieldsJson/);
    assert.equal(result.retryable, true);
    assert.equal(result.executionStatus, "NOT_EXECUTED");
    assert.doesNotMatch(result.userMessage, /fieldsJson|documentsJson|payload/);
  }
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
  assert.ok(f.audits.every((entry) => entry.executionStatus === "NOT_EXECUTED"));
});

test("The executor also rejects an insert_one documents payload without relying on the tool", async (t) => {
  const f = fixture(t);
  await assert.rejects(executeDatabaseAction("SPRINT_TASK", lead, { collection: "sprints", operation: "insert_one", reason: "Create sprint", documents: [{ fields: [numberField] }] }), /INVALID_INSERT_PAYLOAD:insert_one requires fieldsJson/);
  assert.equal(f.writes.length, 0);
});

test("insert_many retains its distinct documentsJson contract", async (t) => {
  fixture(t);
  const actions = require("../src/services/database-action.service.ts");
  const dispatched = [];
  t.mock.method(actions, "executeDatabaseAction", async (_agent, _caller, action) => { dispatched.push(action); return { ok: true, result: { insertedCount: 1 } }; });
  const tool = makeDatabaseTool("REQUIREMENTS", { ...lead, role: "PRODUCT_MANAGER" }, []);
  const fields = [{ field: "title", stringValue: "A story" }];
  const base = { collection: "user_stories", operation: "insert_many", reason: "Test payload decoding" };
  for (const args of [{ ...base, fieldsJson: JSON.stringify(fields) }, { ...base, documentsJson: "[]" }, { ...base, fieldsJson: JSON.stringify(fields), documentsJson: JSON.stringify([{ fields }]) }]) {
    const rejected = JSON.parse(await tool.invoke(args));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.retryable, true);
  }
  const result = JSON.parse(await tool.invoke({ ...base, documentsJson: JSON.stringify([{ fields }]) }));
  assert.equal(result.ok, true);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].documents, [{ fields }]);
  assert.equal(dispatched[0].fields, undefined);
  // Real permissions and PM review remain covered by the authorization suite.
});

test("Sprint 15 is created with backend dates, defaults and caller ownership", async (t) => {
  const f = fixture(t);
  const result = await f.invoke(input([numberField, { field: "name", stringValue: "Sprint 15" }, { field: "status", stringValue: "PLANNED" }]));
  assert.equal(result.ok, true, result.error);
  const sprint = f.writes[0];
  assert.equal(sprint.startDate.toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(sprint.endDate.toISOString(), "2026-10-25T23:59:59.999Z");
  assert.equal(sprint.endDate - sprint.startDate + 1, 14 * 24 * 60 * 60 * 1000);
  assert.equal(sprint.velocity, 0);
  assert.equal(sprint.status, "PLANNED");
  assert.deepEqual(sprint.capacities, []);
  assert.equal(String(sprint.createdBy), lead.mongoUserId);
  assert.ok(sprint.createdAt instanceof Date);
  assert.equal(f.audits.at(-1).executionStatus, "SUCCEEDED");
  assert.equal(result.result.insertedId, String(sprint._id));
  const visible = await f.invoke({ collection: "sprints", operation: "findOne", filter: { sprintNumber: 15 } });
  assert.equal(visible.result.name, "Sprint 15", "a sprint with no capacities must remain visible to its creator");
});

test("Two-week scheduling handles midnight end dates, leap years and year boundaries in UTC", async (t) => {
  const f = fixture(t);
  for (const [end, start, finish] of [
    ["2026-10-11T00:00:00Z", "2026-10-12", "2026-10-25"],
    ["2028-02-28T23:59:59Z", "2028-02-29", "2028-03-13"],
    ["2026-12-31T23:59:59Z", "2027-01-01", "2027-01-14"],
  ]) {
    f.sprints.splice(1);
    f.sprints[0].endDate = new Date(end);
    const result = await f.invoke();
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.document.startDate, `${start}T00:00:00.000Z`);
    assert.equal(result.result.document.endDate, `${finish}T23:59:59.999Z`);
  }
});

test("Sprint creation rejects invented dates and system values without inserting", async (t) => {
  const f = fixture(t);
  for (const field of [
    { field: "startDate", stringValue: "2026-10-15" }, { field: "endDate", stringValue: "2026-10-28" },
    { field: "velocity", numberValue: 20 }, { field: "status", stringValue: "ACTIVE" },
    { field: "createdAt", stringValue: "2026-01-01" }, { field: "createdBy", stringValue: "cccccccccccccccccccccccc" },
  ]) {
    const result = await f.invoke(input([numberField, field]));
    assert.equal(result.ok, false);
    assert.match(result.error, /SPRINT_DATES_MANAGED|SPRINT_VELOCITY_MANAGED|SPRINT_INITIAL_STATUS|FIELD_NOT_MUTABLE/);
  }
  assert.equal(f.writes.length, 0);
});

test("Invalid sprint numbers cannot create malformed records", async (t) => {
  const f = fixture(t);
  for (const field of [{ field: "name", stringValue: "Sprint 15" }, { field: "sprintNumber", stringValue: "15" }, ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((numberValue) => ({ field: "sprintNumber", numberValue }))]) {
    const result = await f.invoke(input([field]));
    assert.match(result.error, /SPRINT_NUMBER_REQUIRED/);
  }
  assert.equal(f.writes.length, 0);
});

test("Missing, duplicate and inaccessible predecessors never select another sprint or invent dates", async (t) => {
  const f = fixture(t);
  const previous = f.sprints[0];
  for (const records of [[], [{ ...previous, sprintNumber: 13 }], [{ ...previous, capacities: [{ developerId: new ObjectId() }] }], [previous, { ...previous, _id: new ObjectId() }]]) {
    f.sprints.splice(0, f.sprints.length, ...records);
    const result = await f.invoke();
    assert.match(result.error, /SPRINT_PREDECESSOR_REQUIRED/);
    assert.equal(result.retryable, false);
  }
  assert.equal(f.writes.length, 0);
});

test("A missing or invalid predecessor end date requests the missing scheduling fact", async (t) => {
  const f = fixture(t);
  for (const end of [undefined, "not-a-date", new Date(NaN), null]) {
    f.sprints[0].endDate = end;
    const result = await f.invoke();
    assert.match(result.error, /SPRINT_PREDECESSOR_DATE_REQUIRED/);
    assert.match(result.userMessage, /What is Sprint 14's end date/);
  }
  assert.equal(f.writes.length, 0);
});

test("Repeating creation refuses an existing scoped sprint and preserves the original", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke()).ok, true);
  const duplicate = await f.invoke();
  assert.match(duplicate.error, /SPRINT_ALREADY_EXISTS/);
  assert.equal(f.writes.length, 1);
});

test("Only Engineering Leads can create sprints and ownership is not granted to another lead", async (t) => {
  const f = fixture(t);
  for (const role of ["PRODUCT_MANAGER", "DEVELOPER", "QA"]) {
    const result = JSON.parse(await makeDatabaseTool("SPRINT_TASK", { ...lead, role }, []).invoke(input()));
    assert.match(result.error, /OPERATION_NOT_ALLOWED:insert_one/);
    assert.equal(result.retryable, undefined);
  }
  assert.equal(f.writes.length, 0);
  await f.invoke();
  const other = JSON.parse(await makeDatabaseTool("SPRINT_TASK", { ...lead, mongoUserId: "cccccccccccccccccccccccc" }, []).invoke({ collection: "sprints", operation: "findOne", filter: { sprintNumber: 15 } }));
  assert.equal(other.result, null);
});

test("The graph corrects documentsJson internally and confirms exactly one successful creation", async (t) => {
  const f = fixture(t), run = graph(t);
  let calls = 0;
  t.mock.method(models, "getModel", () => ({ bindTools: () => ({ async invoke(messages) {
    calls++;
    if (calls === 1) return toolCall("bad", { ...input(), fieldsJson: undefined, documentsJson: '[{"sprintNumber":{"numberValue":15}}]' });
    if (calls === 2) {
      assert.match(messages.at(-1).content, /INVALID_INSERT_PAYLOAD/);
      return new AIMessage("Correct the mutation payload and resubmit fieldsJson.");
    }
    if (calls === 3) return toolCall("corrected", input());
    assert.equal(calls, 4);
    assert.match(messages.at(-1).content, /2026-10-12T00:00:00.000Z/);
    return new AIMessage("Created Sprint 15, planned for October 12–25, 2026.");
  } }) }));
  const result = await run({ agent: "SPRINT_TASK", caller: lead, threadId: "sprint-payload-repair", message: "create a sprint 15" });
  assert.match(result.response, /Created Sprint 15/);
  assert.doesNotMatch(result.response, /Json|payload|resubmit/);
  assert.equal(f.writes.length, 1);
  assert.equal(result.trace.length, 2);
  assert.equal(result.trace[0].result.executionStatus, "NOT_EXECUTED");
  assert.equal(result.trace[1].result.ok, true);
});

test("Failed payload recovery gives a plain-language failure instead of asking the user for JSON", async (t) => {
  const f = fixture(t), run = graph(t);
  let calls = 0;
  t.mock.method(models, "getModel", () => ({ bindTools: () => ({ async invoke() {
    if (++calls === 1) return toolCall("bad", { ...input(), fieldsJson: undefined, documentsJson: "[]" });
    return new AIMessage("Correct the mutation payload and resubmit fieldsJson.");
  } }) }));
  const result = await run({ agent: "SPRINT_TASK", caller: lead, threadId: "sprint-payload-failed", message: "create sprint 15" });
  assert.equal(calls, 3, "one bounded repair attempt after the normal tool loop");
  assert.match(result.response, /internal sprint-creation action failed validation/);
  assert.doesNotMatch(result.response, /fieldsJson|payload|resubmit/);
  assert.equal(f.writes.length, 0);
});

test("Execution failures are not labeled safe for automatic payload recovery", async (t) => {
  const f = fixture(t);
  f.state.failInsert = true;
  const result = await f.invoke();
  assert.equal(result.ok, false);
  assert.equal(result.retryable, undefined);
  assert.equal(result.executionStatus, undefined);
});
