const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { MemorySaver } = require("@langchain/langgraph");
const database = require("../src/db/mongodb.ts");
const models = require("../src/agent/model.ts");
const { recordListIntent, readRecordList, MAX_LIST_RECORDS } = require("../src/agent/record-list.ts");

const oid = (n) => new ObjectId(n.toString(16).padStart(24, "0"));
const lead = { mongoUserId: String(oid(1)), userKey: "u-el-1", name: "Lead", role: "ENGINEERING_LEAD", active: true };
const developer = { ...lead, mongoUserId: String(oid(2)), userKey: "u-dev-1", role: "DEVELOPER" };
const sprint14 = oid(114);
const eq = (a, b) => a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a === b;
function fieldValues(row, path) {
  if (!path.length) return [row];
  if (Array.isArray(row)) return row.flatMap((item) => fieldValues(item, path));
  return fieldValues(row?.[path[0]], path.slice(1));
}
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$and") return value.every((branch) => matches(row, branch));
    if (key === "$or") return value.some((branch) => matches(row, branch));
    return fieldValues(row, key.split(".")).some((stored) => {
      if (value && typeof value === "object" && !(value instanceof ObjectId)) {
        if ("$in" in value) return value.$in.some((item) => eq(stored, item));
        if ("$ne" in value) return !eq(stored, value.$ne);
        throw new Error("Unsupported fixture filter");
      }
      return eq(stored, value);
    });
  });
}

function fixture(t) {
  const data = {
    users: [2, 3].map((n) => ({ _id: oid(n), reportsToUserId: oid(1), active: true })),
    sprints: [8, 14].map((n) => ({ _id: oid(100 + n), sprintNumber: n, name: `Sprint ${n}`, capacities: [{ developerId: oid(2) }, { developerId: oid(3) }] })),
    tasks: Array.from({ length: 27 }, (_, i) => ({
      _id: oid(200 + i), taskKey: `TASK-${i + 1}`, title: `Sprint 14 task ${i + 1}`, sprintId: sprint14,
      assigneeId: oid(i === 0 ? 2 : 3), createdBy: oid(1), storyPoints: 3, priority: "HIGH", status: "TODO",
    })),
  };
  data.tasks.push(
    { _id: oid(900), taskKey: "TASK-OTHER-SPRINT", title: "Sprint 8 task", sprintId: oid(108), assigneeId: oid(2), createdBy: oid(1) },
    { _id: oid(901), taskKey: "TASK-OTHER-TEAM", title: "Other team task", sprintId: sprint14, assigneeId: oid(4), createdBy: oid(5) },
  );
  const reads = [], audits = [], session = { lastAgent: "DOCUMENTATION" };
  const state = { failCollection: undefined, failSkip: 0 };
  const db = { collection(name) {
    if (name === "chat_sessions") return {
      async findOne() { return session; },
      async updateOne(_filter, update) { Object.assign(session, update.$set); },
    };
    if (name === "audit_logs") return { async insertOne(entry) { audits.push(entry); } };
    assert.ok(Object.hasOwn(data, name), `Unexpected collection: ${name}`);
    return { find(filter, options) {
      const call = { collection: name, filter, options, skip: 0, limit: Infinity, sort: {} };
      reads.push(call);
      let transform = (row) => row;
      const values = () => {
        if (state.failCollection === name && call.skip >= state.failSkip) throw new Error("Simulated read failure");
        return data[name].filter((row) => matches(row, filter)).sort((a, b) => {
          for (const [field, direction] of Object.entries(call.sort)) {
            if (String(a[field]) < String(b[field])) return -direction;
            if (String(a[field]) > String(b[field])) return direction;
          }
          return 0;
        }).slice(call.skip, call.skip + call.limit).map((row) => options?.projection
          ? Object.fromEntries(Object.entries(row).filter(([key]) => options.projection[key] === 1)) : row).map(transform);
      };
      return {
        sort(value) { call.sort = value; return this; },
        skip(value) { call.skip = value; return this; },
        limit(value) { call.limit = value; return this; },
        map(fn) { transform = fn; return this; },
        async toArray() { return values(); },
        async *[Symbol.asyncIterator]() { yield* values(); },
        async close() {},
      };
    } };
  } };
  t.mock.method(database, "getDb", async () => db);
  t.mock.method(database, "getMongoClient", async () => ({}));
  t.mock.method(models, "getRouterModel", () => { throw new Error("Sprint task lists must bypass the model router"); });
  t.mock.method(models, "getModel", () => { throw new Error("Sprint task lists must bypass the model"); });
  const paths = [require.resolve("@langchain/langgraph-checkpoint-mongodb"), require.resolve("../src/agent/specialist-agent.ts"), require.resolve("../src/agent/supervisor.ts")];
  const previous = paths.map((path) => require.cache[path]);
  class TestSaver extends MemorySaver { constructor() { super(); } async setup() {} }
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { MongoDBSaver: TestSaver } };
  delete require.cache[paths[1]];
  delete require.cache[paths[2]];
  t.after(() => paths.forEach((path, index) => { if (previous[index]) require.cache[path] = previous[index]; else delete require.cache[path]; }));
  const { runChat } = require("../src/agent/supervisor.ts");
  return { data, reads, audits, state, session, run: (caller = lead, message = "Show all tasks in Sprint 14") => runChat({ caller, sessionId: "sprint-list", message }) };
}

test("Numbered sprint task lists recognize complete requests without discarding additional constraints", () => {
  for (const message of ["Show all tasks in Sprint 14", "Please show me all the tasks for Sprint #14!", "LIST TASKS IN SPRINT 14", "get tasks for the sprint 14 please."]) {
    const intent = recordListIntent(message);
    assert.equal(intent?.collection, "tasks", message);
    assert.equal(intent.sprintNumber, 14);
  }
  assert.equal(recordListIntent("list tasks in Sprint 8").sprintNumber, 8);
  for (const message of [
    "Show all tasks in Sprint 14 assigned to Rahul", "Show blocked tasks in Sprint 14",
    "Show tasks in Sprint 14 and reassign them", "Show tasks in Sprint 14 or Sprint 15",
    "Show tasks in Sprint 14.5", "Show tasks in Sprint -14", "Show tasks in Sprint 9007199254740993",
    "Show documentation about tasks in Sprint 14", "Show tasks in the current sprint",
  ]) assert.equal(recordListIntent(message), undefined, message);
});

test("Chat resolves Sprint 14 exactly and lists every permitted task across pages without model calls", async (t) => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.agent, "SPRINT_TASK");
  assert.equal(f.session.lastAgent, "SPRINT_TASK");
  assert.match(result.response, /Tasks in Sprint 14 \(27\)/);
  assert.match(result.response, /\| Task Key \| Title \| Assignee ID \| Points \| Priority \| Status \|/);
  assert.match(result.response, /\| TASK-1 \| Sprint 14 task 1 \|/);
  assert.match(result.response, /\| TASK-27 \| Sprint 14 task 27 \|/);
  assert.match(result.response, /Listed all 27 records/);
  assert.doesNotMatch(result.response, /TASK-OTHER|tool_call|<function/);
  assert.equal(result.trace.length, 3);
  assert.ok(result.trace.every((entry) => entry.guardrail === "ALLOWED"));
  assert.deepEqual(result.trace[0].generatedAction.filter, { sprintNumber: 14 });
  for (const trace of result.trace.slice(1)) {
    assert.equal(trace.generatedAction.collection, "tasks");
    assert.deepEqual(trace.generatedAction.filter, { sprintId: String(sprint14) });
  }
  const taskReads = f.reads.filter((read) => read.collection === "tasks");
  assert.deepEqual(taskReads.map((read) => read.skip), [0, 25]);
  assert.ok(taskReads.every((read) => read.filter.$and[0].sprintId instanceof ObjectId));
  assert.equal(f.audits.length, 3);
});

test("Sprint task lists retain developer OWN scope on both sprint resolution and tasks", async (t) => {
  const f = fixture(t);
  const result = await f.run(developer);
  assert.match(result.response, /Listed all 1 records/);
  assert.match(result.response, /\| TASK-1 \|/);
  assert.doesNotMatch(result.response, /TASK-2|TASK-OTHER/);
  assert.equal(String(f.reads.find((read) => read.collection === "sprints").filter.$and[1]["capacities.developerId"]), developer.mongoUserId);
  assert.equal(String(f.reads.find((read) => read.collection === "tasks").filter.$and[1].assigneeId), developer.mongoUserId);
});

test("PM and QA retain their existing full read access to tasks in the selected sprint", async (t) => {
  const f = fixture(t);
  for (const role of ["PRODUCT_MANAGER", "QA"]) {
    const result = await f.run({ ...lead, role });
    assert.match(result.response, /Listed all 28 records/);
    assert.match(result.response, /TASK-OTHER-TEAM/);
    assert.doesNotMatch(result.response, /TASK-OTHER-SPRINT/);
  }
});

test("Missing or inaccessible sprints stop before any task read", async (t) => {
  const f = fixture(t);
  f.data.sprints.push({ _id: oid(199), sprintNumber: 99, name: "Hidden sprint", capacities: [{ developerId: oid(4) }] });
  for (const sprint of [99, 404]) {
    const result = await f.run(developer, `Show all tasks in Sprint ${sprint}`);
    assert.match(result.response, new RegExp(`Sprint ${sprint} was not found within your access`));
    assert.equal(result.trace.length, 1);
  }
  assert.ok(f.reads.every((read) => read.collection !== "tasks"));
});

test("Duplicate sprint numbers require disambiguation instead of selecting the first match", async (t) => {
  const f = fixture(t);
  f.data.sprints.push({ ...f.data.sprints[1], _id: oid(115) });
  const result = await f.run();
  assert.match(result.response, /Multiple sprints match Sprint 14/);
  assert.match(result.response, new RegExp(String(oid(115))));
  assert.equal(result.trace.length, 1);
  assert.ok(f.reads.every((read) => read.collection !== "tasks"));
});

test("An empty sprint task list never falls back to another sprint", async (t) => {
  const f = fixture(t);
  f.data.tasks = f.data.tasks.filter((row) => !eq(row.sprintId, sprint14));
  const result = await f.run();
  assert.match(result.response, /No tasks in sprint 14 were found within your access/);
  assert.equal(result.trace.length, 2);
});

test("Sprint resolution failures and permission refusals do not fetch tasks", async (t) => {
  const f = fixture(t);
  const refused = await f.run({ ...lead, active: false });
  assert.match(refused.response, /does not have permission/);
  f.state.failCollection = "sprints";
  const failed = await f.run();
  assert.match(failed.response, /couldn't retrieve tasks in sprint 14/);
  assert.doesNotMatch(failed.response, /not found/);
  assert.ok(f.reads.every((read) => read.collection !== "tasks"));
});

test("Task page failures preserve already fetched tasks and report incompleteness", async (t) => {
  const f = fixture(t);
  f.state.failCollection = "tasks";
  f.state.failSkip = 25;
  const result = await f.run();
  assert.match(result.response, /\| TASK-25 \|/);
  assert.match(result.response, /This list is incomplete/);
  assert.doesNotMatch(result.response, /Listed all|TASK-27/);
});

test("Sprint task lists keep the sprint filter through the 500-record cap", async () => {
  let pages = 0;
  const response = await readRecordList(recordListIntent("Show tasks in Sprint 14"), async (action) => {
    if (action.collection === "sprints") return JSON.stringify({ ok: true, result: { items: [{ _id: String(sprint14) }], hasMore: false } });
    pages++;
    assert.deepEqual(action.filter, { sprintId: String(sprint14) });
    return JSON.stringify({ ok: true, result: { items: Array.from({ length: action.limit }, (_, i) => ({ taskKey: `TASK-${action.skip + i}` })), hasMore: true, nextSkip: action.skip + action.limit } });
  });
  assert.equal(pages, MAX_LIST_RECORDS / 25);
  assert.match(response, /Showing the first 500 records/);
  assert.doesNotMatch(response, /Listed all/);
});
