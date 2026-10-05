const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isDeepStrictEqual } = require("node:util");
const { ObjectId, BSON } = require("mongodb");
const { AIMessage } = require("@langchain/core/messages");
const { MemorySaver } = require("@langchain/langgraph");
const database = require("../src/db/mongodb.ts");
const models = require("../src/agent/model.ts");
const { makeDatabaseTool } = require("../src/agent/db-tool.ts");
const { executeDatabaseAction } = require("../src/services/database-action.service.ts");
const { isBugCountRequest, readBugCount } = require("../src/agent/bug-response.ts");

const oid = (n) => new ObjectId(n.toString(16).padStart(24, "0"));
const leadId = oid(1), otherLeadId = oid(2), devId = oid(3), otherDevId = oid(4), qaId = oid(5), productId = oid(6), testCaseId = oid(7);
const caller = (id, role, name) => ({ mongoUserId: String(id), userKey: `u-${name}`, name, role, active: true });
const lead = caller(leadId, "ENGINEERING_LEAD", "Lead"), otherLead = caller(otherLeadId, "ENGINEERING_LEAD", "Other Lead");
const qa = caller(qaId, "QA", "QA"), developer = caller(devId, "DEVELOPER", "Dev");
const fields = (object) => Object.entries(object).filter(([, value]) => value !== undefined).map(([field, value]) => ({ field, [Array.isArray(value) ? "stringListValue" : typeof value === "number" ? "numberValue" : "stringValue"]: value }));
const insert = (rest = {}) => ({ collection: "bugs", operation: "insert_one", reason: "Report the bug", fieldsJson: JSON.stringify(fields({ title: "Login button does not respond", severity: "HIGH", sourceTestCase: rest.sourceTestCaseId ? undefined : "TC-106", ...rest })) });
const update = (key, values) => ({ collection: "bugs", operation: "update_one", reason: "Update the requested bug", conditionsJson: JSON.stringify([{ field: "bugKey", operator: "eq", stringValue: key }]), fieldsJson: JSON.stringify(fields(values)) });
const clone = (value) => BSON.deserialize(BSON.serialize({ value })).value;
const equal = (a, b) => a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a instanceof Date && b instanceof Date ? +a === +b : a === b;
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$and") return value.every((part) => matches(row, part));
    if (key === "$or") return value.some((part) => matches(row, part));
    const stored = key.split(".").reduce((obj, part) => obj?.[part], row);
    if (value === null) return stored == null;
    if (Array.isArray(value)) return isDeepStrictEqual(stored, value);
    if (value && typeof value === "object" && !(value instanceof ObjectId) && !(value instanceof Date)) {
      return Object.entries(value).every(([op, arg]) => {
        if (op === "$eq") return equal(stored, arg);
        if (op === "$ne") return !equal(stored, arg);
        if (op === "$in") return arg.some((v) => equal(stored, v));
        if (op === "$exists") return (stored !== undefined) === arg;
        if (op === "$regex") return new RegExp(arg, value.$options).test(stored ?? "");
        if (op === "$options") return true;
        throw Error(`Unsupported mock operator: ${op}`);
      });
    }
    return equal(stored, value);
  });
}
function setFields(row, fields) {
  for (const [path, value] of Object.entries(fields)) {
    const parts = path.split("."); let target = row;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = clone(value);
  }
}
function fixture(t) {
  const data = {
    users: [
      { _id: leadId, name: "Lead", email: "lead@example.test", role: "EL", active: true },
      { _id: otherLeadId, name: "Other Lead", role: "ENGINEERING_LEAD", active: true },
      { _id: devId, name: "Dev", role: "DEVELOPER", reportsToUserId: leadId, active: true },
      { _id: otherDevId, name: "Other Dev", role: "DEV", reportsToUserId: otherLeadId, active: true },
      { _id: qaId, name: "QA", role: "QA", active: true },
    ], bugs: [], products: [{ _id: productId, active: true }], test_cases: [{ _id: testCaseId, testCaseKey: "TC-106", productId, active: true,
      executions: [{ attempt: 1, releaseVersion: "v2.4", result: "PASS", testedBy: qaId, linkedBugId: null, executedAt: new Date("2026-09-28T06:00:00Z") }],
    }], audit_logs: [],
  };
  const writes = [], testWrites = [], state = { race: false, failInsert: false, failLink: false, failAudit: false, staleLink: false, retryTransaction: false };
  const session = { async withTransaction(work) {
    const before = clone(data), writeCount = writes.length, linkCount = testWrites.length;
    const restore = () => { for (const key of Object.keys(data)) delete data[key]; Object.assign(data, clone(before)); writes.length = writeCount; testWrites.length = linkCount; };
    try {
      const result = await work();
      if (state.retryTransaction) { state.retryTransaction = false; restore(); return await work(); }
      return result;
    } catch (error) { restore(); throw error; }
  } };
  function cursor(rows, projection) {
    let skip = 0, limit = Infinity, transform = (v) => v;
    const values = () => rows.slice(skip, skip + limit).map((row) => transform(clone(projection
      ? Object.fromEntries(Object.entries(row).filter(([key]) => projection[key] === 1)) : row)));
    return { limit(n) { limit = n; return this; }, skip(n) { skip = n; return this; }, sort() { return this; },
      map(fn) { transform = fn; return this; }, async toArray() { return values(); }, async *[Symbol.asyncIterator]() { yield* values(); }, async close() {} };
  }
  const db = { collection(name) {
    const rows = data[name] ??= [];
    return {
      find(filter, options) { return cursor(rows.filter((row) => matches(row, filter)), options?.projection); },
      async findOne(filter, options) { return (await cursor(rows.filter((row) => matches(row, filter)), options?.projection).toArray())[0] ?? null; },
      async distinct(key, filter) { return rows.filter((row) => matches(row, filter)).map((row) => row[key]); },
      async countDocuments(filter) { return rows.filter((row) => matches(row, filter)).length; },
      async insertOne(document, options) {
        if (name === "bugs" && document.sourceTestExecutionAttempt !== undefined) assert.equal(options?.session, session);
        if (name === "bugs" && state.failInsert) throw Error("Simulated bug insert failure");
        if (name === "audit_logs" && options?.session && state.failAudit) throw Error("Simulated audit failure");
        const row = { ...clone(document), _id: document._id ?? new ObjectId() }; (data[name] ??= []).push(row);
        if (name !== "audit_logs") writes.push({ name, row });
        return { insertedId: row._id };
      },
      async updateOne(filter, update, options) {
        if (name === "test_cases") {
          assert.equal(options?.session, session);
          if (state.failLink) throw Error("Simulated link failure");
          if (state.staleLink) return { matchedCount: 0, modifiedCount: 0 };
        }
        if (state.race) { data.bugs[0].status = "FIX_READY"; state.race = false; }
        const row = data[name].find((r) => matches(r, filter));
        if (!row) return { matchedCount: 0, modifiedCount: 0 };
        setFields(row, update.$set); (name === "test_cases" ? testWrites : writes).push({ name, filter, update });
        return { matchedCount: 1, modifiedCount: 1 };
      },
    };
  } };
  t.mock.method(database, "getDb", async () => db);
  t.mock.method(database, "getMongoClient", async () => ({ async withSession(work) { return work(session); } }));
  const traces = [];
  const invoke = (who, action, agent = "BUG") => makeDatabaseTool(agent, who, traces).invoke(action).then(JSON.parse);
  const bug = (rest = {}) => {
    const row = { _id: new ObjectId(), bugKey: `BUG-${data.bugs.length + 101}`, title: "Existing bug", severity: "HIGH", status: "NEW", assigneeId: null, ...rest };
    data.bugs.push(row); return row;
  };
  return { data, writes, testWrites, state, traces, invoke, bug };
}

test("QA reports NEW unassigned bugs into the shared backlog without teamLeadId or invented lifecycle fields", async (t) => {
  const f = fixture(t);
  const result = await f.invoke(qa, insert({ description: "Clicking login does nothing", stepsToReproduce: ["Open login", "Click Login"], productId: String(productId) }));
  assert.equal(result.ok, true, result.error);
  const bug = f.data.bugs[0];
  assert.equal(bug.status, "NEW"); assert.equal(bug.assigneeId, null);
  assert.equal(Object.hasOwn(bug, "teamLeadId"), false); assert.equal(String(bug.reportedBy), String(qaId));
  assert.equal(bug.bugKey, "BUG-101"); assert.equal(bug.description, "Clicking login does nothing");
  assert.ok(bug.createdAt instanceof Date); assert.ok(bug.updatedAt instanceof Date);
  assert.equal(bug.fixDetails, undefined); assert.equal(bug.qaVerification, undefined);
  assert.equal(bug.affectedReleaseVersion, "v2.4"); assert.equal(bug.component, undefined);
  assert.equal(String(bug.sourceTestCaseId), String(testCaseId)); assert.equal(bug.sourceTestExecutionAttempt, 1);
  assert.equal(String(f.data.test_cases[0].executions[0].linkedBugId), String(bug._id));
  assert.equal(f.data.audit_logs.at(-1).executionStatus, "SUCCEEDED");
});

test("QA and Developer bug creation does not require a reporting lead", async (t) => {
  const f = fixture(t);
  for (const user of f.data.users) delete user.reportsToUserId;
  for (const who of [qa, developer]) {
    const payload = insert(); payload.fieldsJson = JSON.stringify(fields({ title: "Reported issue", severity: "LOW", ...(who.role === "QA" ? { sourceTestCase: "TC-106" } : {}) }));
    const result = await f.invoke(who, payload);
    assert.equal(result.ok, true, result.error);
    assert.equal(Object.hasOwn(result.result.document, "teamLeadId"), false);
    assert.equal(result.result.document.status, "NEW");
    assert.equal(result.result.document.assigneeId, null);
  }
});

test("Missing severity or title produces a plain clarification without asking for a lead", async (t) => {
  const f = fixture(t);
  for (const [values, code, question] of [
    [{ title: "Login broken" }, "BUG_SEVERITY_REQUIRED", /impact/],
    [{ title: "", severity: "LOW" }, "BUG_DETAILS_REQUIRED", /title/],
  ]) {
    const result = await f.invoke(qa, { ...insert(), fieldsJson: JSON.stringify(fields({ sourceTestCase: "TC-106", ...values })) });
    assert.equal(result.ok, false); assert.equal(result.code, code);
    assert.equal(result.retryable, false); assert.equal(result.executionStatus, "NOT_EXECUTED");
    assert.match(result.userMessage, question); assert.doesNotMatch(result.userMessage, /fieldsJson|ObjectId|Which Engineering Lead/);
  }
  assert.equal(f.writes.length, 0);
});

test("QA cannot assign on creation or update, through either alias or ID; developer cannot self-assign", async (t) => {
  const f = fixture(t); const bug = f.bug();
  for (const who of [qa, developer]) for (const name of ["assignee", "assigneeId"]) {
    for (const payload of [insert({ [name]: String(devId), ...(who.role === "DEVELOPER" ? { sourceTestCase: undefined } : {}) }), update(bug.bugKey, { [name]: String(devId) })]) {
      const result = await f.invoke(who, payload);
      assert.equal(result.ok, false); assert.match(result.error, /FIELD_NOT_MUTABLE:assignee/);
    }
  }
  assert.equal(f.writes.length, 0);
});

test("Creation rejects fabricated lifecycle values, keys, invalid fields and retired ownership fields", async (t) => {
  const f = fixture(t);
  for (const extra of [{ status: "ASSIGNED" }, { status: "VERIFIED_CLOSED" }, { bugKey: "BUG-999" }, { severity: "URGENT" },
    { teamLead: "QA" }, { teamLead: String(oid(90)) }, { qaVerificationResult: "PASS" }, { productId: String(oid(90)) },
    { stepsToReproduce: [""] }, { severity: 2 }]) {
    assert.equal((await f.invoke(qa, insert(extra))).ok, false, JSON.stringify(extra));
  }
  const payload = insert(); payload.fieldsJson = JSON.stringify([...fields({ title: "Bug", severity: "LOW" }), { field: "title", stringValue: "Duplicate" }]);
  assert.equal((await f.invoke(qa, payload)).code, "BUG_INVALID_FIELDS");
  assert.equal(f.writes.length, 0);
});

test("Every EL sees and counts all bugs, including unassigned and legacy ownership records, through BUG and RELEASE", async (t) => {
  const f = fixture(t);
  const unassigned = f.bug();
  f.bug({ assigneeId: devId });
  f.bug({ teamLeadId: otherLeadId, assigneeId: devId }); // legacy ownership has no effect
  f.bug({ teamLeadId: null, assigneeId: null });
  f.bug({ teamLeadId: otherLeadId, assigneeId: otherDevId });
  for (const who of [lead, otherLead]) for (const agent of ["BUG", "RELEASE"]) {
    const read = await f.invoke(who, { collection: "bugs", operation: "find", filter: {}, projection: { bugKey: 1 } }, agent);
    assert.equal(read.ok, true, read.error);
    assert.deepEqual(read.result.items.map((b) => b.bugKey), f.data.bugs.map((b) => b.bugKey));
    assert.equal((await f.invoke(who, { collection: "bugs", operation: "countDocuments", filter: {} }, agent)).result.count, 5);
  }
  assert.equal((await f.invoke(qa, { collection: "bugs", operation: "countDocuments", filter: {} })).result.count, 5);
  assert.equal((await f.invoke(otherLead, { collection: "bugs", operation: "findOne", filter: { bugKey: unassigned.bugKey } })).result.bugKey, unassigned.bugKey);
});

test("EL assigns an unassigned bug by developer name, persists ASSIGNED without teamLeadId and cannot override status", async (t) => {
  const f = fixture(t), bug = f.bug();
  const result = await f.invoke(lead, update(bug.bugKey, { assignee: "Dev" }));
  assert.equal(result.ok, true, result.error);
  assert.equal(bug.status, "ASSIGNED"); assert.equal(String(bug.assigneeId), String(devId));
  assert.equal(Object.hasOwn(bug, "teamLeadId"), false);
  assert.equal(result.result.bugKey, bug.bugKey); assert.equal(result.result.status, "ASSIGNED");
  assert.equal((await f.invoke(lead, update(bug.bugKey, { assignee: "Dev", status: "VERIFIED_CLOSED" }))).ok, false);
  assert.equal(f.writes.length, 1);
});

test("EL rejects inactive, non-developer and nonexistent assignees, including raw IDs", async (t) => {
  const f = fixture(t), bug = f.bug();
  f.data.users.push({ _id: oid(10), name: "Inactive", role: "DEVELOPER", active: false, reportsToUserId: leadId });
  f.data.users.find((u) => equal(u._id, qaId)).reportsToUserId = leadId;
  for (const identity of ["Inactive", String(oid(10)), "QA", String(qaId), "Lead", String(leadId), String(oid(99))]) {
    const result = await f.invoke(lead, update(bug.bugKey, { assigneeId: identity }));
    assert.equal(result.code, "BUG_PERSON_NOT_AVAILABLE", identity);
  }
  assert.equal(f.writes.length, 0); assert.equal(bug.assigneeId, null);
});

test("Ambiguous developer names across reporting groups require clarification; exact IDs remain usable", async (t) => {
  const f = fixture(t), bug = f.bug();
  f.data.users.push({ _id: oid(13), name: "Dev", role: "DEVELOPER", active: true, reportsToUserId: otherLeadId });
  assert.equal((await f.invoke(lead, update(bug.bugKey, { assignee: "Dev" }))).code, "BUG_PERSON_AMBIGUOUS");
  assert.equal((await f.invoke(lead, update(bug.bugKey, { assigneeId: String(devId) }))).ok, true);
});

test("Any EL can assign or reassign a shared bug to an active developer regardless of reporting relationship", async (t) => {
  const f = fixture(t);
  const legacy = f.bug({ teamLeadId: otherLeadId }), unassigned = f.bug();
  for (const bug of [legacy, unassigned]) {
    assert.equal((await f.invoke(lead, update(bug.bugKey, { assignee: "Other Dev" }))).ok, true);
    assert.equal(String(bug.assigneeId), String(otherDevId));
    assert.equal((await f.invoke(otherLead, update(bug.bugKey, { assigneeId: String(devId) }))).ok, true);
    assert.equal(String(bug.assigneeId), String(devId));
  }
  assert.equal(Object.hasOwn(unassigned, "teamLeadId"), false);
  assert.equal(f.writes.length, 4);
});

test("Retired lead ownership fields cannot be written by any role", async (t) => {
  const f = fixture(t), bug = f.bug();
  for (const who of [qa, lead, developer]) for (const field of ["teamLead", "teamLeadId"]) {
    const result = await f.invoke(who, update(bug.bugKey, { [field]: String(leadId) }));
    assert.match(result.error, /FIELD_NOT_MUTABLE:teamLead/);
  }
  assert.equal(f.writes.length, 0); assert.equal(Object.hasOwn(bug, "teamLeadId"), false);
});

test("The complete QA report -> EL assign -> Developer fix -> QA verify lifecycle is enforced", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(qa, insert())).ok, true);
  const bug = f.data.bugs[0];
  assert.equal((await f.invoke(qa, update(bug.bugKey, { qaVerificationResult: "PASS" }))).code, "BUG_VERIFICATION_STATE");
  assert.equal((await f.invoke(developer, update(bug.bugKey, { fixSummary: "Fixed click handler" }))).code, "BUG_SELECTION_REQUIRED");
  assert.equal((await f.invoke(lead, update(bug.bugKey, { assignee: "Dev" }))).ok, true);
  assert.equal((await f.invoke(developer, update(bug.bugKey, { status: "FIX_READY" }))).code, "BUG_DETAILS_REQUIRED");
  assert.equal((await f.invoke(developer, update(bug.bugKey, { fixSummary: "Fixed click handler" }))).ok, true);
  assert.equal(bug.status, "FIX_READY"); assert.equal(String(bug.fixDetails.fixedBy), String(devId));
  assert.equal((await f.invoke(lead, update(bug.bugKey, { assignee: "Dev" }))).code, "BUG_ASSIGNMENT_STATE");
  assert.equal((await f.invoke(qa, update(bug.bugKey, { status: "VERIFIED_CLOSED" }))).code, "BUG_QA_STATUS");
  assert.equal((await f.invoke(qa, update(bug.bugKey, { qaVerificationResult: "PASS" }))).ok, true);
  assert.equal(bug.status, "VERIFIED_CLOSED"); assert.equal(String(bug.qaVerification.verifiedBy), String(qaId));
  assert.equal((await f.invoke(qa, update(bug.bugKey, { qaVerificationResult: "FAIL" }))).ok, true);
  assert.equal(bug.status, "REOPENED");
  assert.equal((await f.invoke(developer, update(bug.bugKey, { fixSummary: "Corrected regression" }))).ok, true);
  assert.equal((await f.invoke(qa, update(bug.bugKey, { qaVerificationResult: "FAIL" }))).ok, true);
  assert.equal(bug.status, "REOPENED");
});

test("Direct executor calls cannot bypass required QA details or developer transition rules", async (t) => {
  const f = fixture(t), bug = f.bug({ assigneeId: devId, status: "ASSIGNED" });
  await assert.rejects(executeDatabaseAction("BUG", qa, { collection: "bugs", operation: "insert_one", reason: "Report", fields: fields({ title: "Bug", sourceTestCase: "TC-106" }) }), /BUG_SEVERITY_REQUIRED/);
  await assert.rejects(executeDatabaseAction("BUG", developer, { collection: "bugs", operation: "update_one", reason: "Edit", conditions: [{ field: "bugKey", operator: "eq", stringValue: bug.bugKey }], fields: fields({ teamLead: "Other Lead" }) }), /FIELD_NOT_MUTABLE:teamLead/);
  await assert.rejects(executeDatabaseAction("BUG", developer, { collection: "bugs", operation: "update_one", reason: "Edit", conditions: [{ field: "bugKey", operator: "eq", stringValue: bug.bugKey }], fields: fields({ status: "VERIFIED_CLOSED", fixSummary: "Done" }) }), /BUG_DEVELOPER_STATUS/);
  assert.equal(f.writes.length, 0);
});

test("Concurrent lifecycle changes cause a zero-match refusal rather than a stale overwrite", async (t) => {
  const f = fixture(t), bug = f.bug({ assigneeId: devId, status: "ASSIGNED" });
  f.state.race = true;
  const result = await f.invoke(lead, update(bug.bugKey, { assignee: "Dev" }));
  assert.equal(result.ok, false); assert.equal(result.code, "BUG_CHANGED"); assert.equal(result.retryable, false);
  assert.equal(bug.status, "FIX_READY"); assert.equal(f.writes.length, 0);
});

test("Bug references are checked, and conflicting product/test-case links are rejected", async (t) => {
  const f = fixture(t);
  f.data.test_cases.push({ _id: oid(20), productId: oid(21) });
  const result = await f.invoke(qa, insert({ productId: String(productId), sourceTestCaseId: String(oid(20)) }));
  assert.equal(result.code, "BUG_PRODUCT_MISMATCH"); assert.equal(f.writes.length, 0);
});

test("Unfiltered bug counts name the effective scope and preserve filtered/compound requests for the model", async (t) => {
  const f = fixture(t); f.bug(); f.bug({ assigneeId: devId }); f.bug({ teamLeadId: otherLeadId });
  for (const [who, count, phrase] of [[qa, 3, /across the workspace/], [lead, 3, /across the workspace/], [otherLead, 3, /across the workspace/], [developer, 1, /assigned to you/]]) {
    const answer = await readBugCount(who, (action) => makeDatabaseTool("BUG", who, []).invoke(action));
    assert.match(answer, new RegExp(`\\*\\*${count} bugs?\\*\\*`)); assert.match(answer, phrase); assert.match(answer, /all statuses/);
  }
  for (const message of ["how many bugs are there", "How many bugs are there?", "count all bugs", "total number of bugs in the system"]) assert.equal(isBugCountRequest(message), true, message);
  for (const message of ["how many open bugs are there", "count bugs and assign them", "how many bugs in release v2.3", "how many bugs does Rahul have"]) assert.equal(isBugCountRequest(message), false, message);
});

function graph(t) {
  const paths = [require.resolve("@langchain/langgraph-checkpoint-mongodb"), require.resolve("../src/agent/specialist-agent.ts")];
  const previous = paths.map((path) => require.cache[path]);
  class TestSaver extends MemorySaver { constructor() { super(); } async setup() {} }
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { MongoDBSaver: TestSaver } };
  delete require.cache[paths[1]];
  t.after(() => paths.forEach((path, i) => { if (previous[i]) require.cache[path] = previous[i]; else delete require.cache[path]; }));
  return require("../src/agent/specialist-agent.ts").runSpecialistAgent;
}

test("Bug creation chat replaces a malformed model table with the confirmed plain receipt", async (t) => {
  const f = fixture(t), run = graph(t); let calls = 0;
  t.mock.method(models, "getModel", () => ({ bindTools() { return this; }, async invoke() {
    return ++calls === 1 ? new AIMessage({ content: "", tool_calls: [{ id: "report", name: "bug_database_action", type: "tool_call", args: insert() }] })
      : new AIMessage("| Bug KeyTitleComponentSeverityStatus | |\n| --- | --- |\n<br><br>raw document");
  } }));
  const result = await run({ caller: qa, agent: "BUG", threadId: "bug-report", message: "Report the login button bug as HIGH from TC-106" });
  assert.match(result.response, /Created \*\*BUG-101/); assert.match(result.response, /Unassigned/);
  assert.doesNotMatch(result.response, /\||<br>|raw document|ObjectId/); assert.equal(f.writes.length, 1);
});

test("QA chat creates without a lead question, every EL can see it, and any EL can assign its developer", async (t) => {
  const f = fixture(t), run = graph(t); let calls = 0;
  t.mock.method(models, "getModel", () => ({ bindTools() { return this; }, async invoke() {
    calls++;
    if (calls === 1) return new AIMessage({ content: "", tool_calls: [{ id: "report", name: "bug_database_action", type: "tool_call", args: insert() }] });
    return new AIMessage("Finished.");
  } }));
  const created = await run({ caller: qa, agent: "BUG", threadId: "shared-bug-backlog", message: "Report HIGH login bug from TC-106" });
  assert.match(created.response, /Created \*\*BUG-101/); assert.match(created.response, /visible to all Engineering Leads/);
  assert.doesNotMatch(created.response, /Which Engineering Lead|owning lead|team backlog/);
  assert.equal(f.writes.length, 1); assert.equal(Object.hasOwn(f.data.bugs[0], "teamLeadId"), false);
  for (const who of [lead, otherLead]) {
    const read = await f.invoke(who, { collection: "bugs", operation: "find", filter: { assigneeId: null } });
    assert.equal(read.result.items.length, 1); assert.equal(read.result.items[0].bugKey, "BUG-101");
  }
  assert.equal((await f.invoke(otherLead, update("BUG-101", { assignee: "Dev" }))).ok, true);
  assert.equal(f.data.bugs[0].status, "ASSIGNED"); assert.equal(String(f.data.bugs[0].assigneeId), String(devId));
  const assigned = await f.invoke(developer, { collection: "bugs", operation: "find", filter: {} });
  assert.equal(assigned.result.items.length, 1);
});

test("Simple bug counts run through the scoped tool without a model call", async (t) => {
  const f = fixture(t), run = graph(t); f.bug(); f.bug({ teamLeadId: otherLeadId });
  t.mock.method(models, "getModel", () => { throw Error("No model call expected"); });
  const result = await run({ caller: lead, agent: "BUG", threadId: "bug-count", message: "how many bugs are there" });
  assert.match(result.response, /\*\*2 bugs\*\*/); assert.match(result.response, /across the workspace/);
  assert.equal(result.trace[0].generatedAction.operation, "countDocuments");
});

test("QA must identify a test case before creation, including direct executor calls", async (t) => {
  const f = fixture(t);
  const result = await f.invoke(qa, insert({ sourceTestCase: undefined }));
  assert.equal(result.code, "BUG_TEST_CASE_REQUIRED"); assert.equal(result.retryable, false);
  assert.match(result.userMessage, /Which test case/);
  await assert.rejects(executeDatabaseAction("BUG", qa, { collection: "bugs", operation: "insert_one", reason: "Report", fields: fields({ title: "Bug", severity: "HIGH" }) }), /BUG_TEST_CASE_REQUIRED/);
  assert.equal(f.data.bugs.length, 0); assert.equal(f.testWrites.length, 0);
});

test("QA test-case references support keys and IDs with exact, active and unambiguous resolution", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(qa, insert({ sourceTestCase: "TC-1060" }))).code, "BUG_TEST_CASE_NOT_AVAILABLE");
  f.data.test_cases[0].active = false;
  assert.equal((await f.invoke(qa, insert())).code, "BUG_TEST_CASE_NOT_AVAILABLE");
  f.data.test_cases[0].active = true;
  f.data.test_cases.push({ ...clone(f.data.test_cases[0]), _id: oid(80) });
  assert.equal((await f.invoke(qa, insert())).code, "BUG_TEST_CASE_NOT_AVAILABLE");
  const result = await f.invoke(qa, insert({ sourceTestCaseId: String(testCaseId) }));
  assert.equal(result.ok, true, result.error);
  assert.equal(String(f.data.test_cases[0].executions[0].linkedBugId), result.result.insertedId);
  assert.equal(f.data.test_cases[1].executions[0].linkedBugId, null);
});

test("Bug creation links both directions and preserves the recorded PASS result, tester and execution timestamp", async (t) => {
  const f = fixture(t), before = clone(f.data.test_cases[0].executions[0]);
  const result = await f.invoke(qa, insert({ sourceTestCase: "tc-106" }));
  assert.equal(result.ok, true, result.error);
  const bug = f.data.bugs[0], execution = f.data.test_cases[0].executions[0];
  assert.deepEqual(execution, { ...before, linkedBugId: bug._id });
  assert.equal(String(bug.sourceTestCaseId), String(testCaseId));
  assert.equal(String(bug.productId), String(productId));
  assert.equal(bug.affectedReleaseVersion, before.releaseVersion);
  assert.equal(bug.sourceTestExecutionAttempt, before.attempt);
  assert.deepEqual(result.result.linkedTestExecution, { testCaseKey: "TC-106", releaseVersion: "v2.4", attempt: 1 });
  assert.equal(f.testWrites.length, 1); assert.equal(f.writes.length, 1);
  assert.ok(f.data.test_cases[0].updatedAt instanceof Date);
  assert.ok(f.testWrites[0].filter.executions, "execution array must be guarded against concurrent changes");
});

test("Multiple executions require release/attempt selection and only the selected run is linked", async (t) => {
  const f = fixture(t);
  const first = clone(f.data.test_cases[0].executions[0]);
  f.data.test_cases[0].executions.push({ ...clone(first), attempt: 2, result: "FAIL" }, { ...clone(first), releaseVersion: "v2.5" });
  assert.equal((await f.invoke(qa, insert())).code, "BUG_TEST_EXECUTION_SELECTION");
  assert.equal((await f.invoke(qa, insert({ affectedReleaseVersion: "v2.4" }))).code, "BUG_TEST_EXECUTION_SELECTION");
  assert.equal((await f.invoke(qa, insert({ testExecutionAttempt: 1 }))).code, "BUG_TEST_EXECUTION_SELECTION");
  const result = await f.invoke(qa, insert({ affectedReleaseVersion: "v2.4", testExecutionAttempt: 2 }));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(f.data.test_cases[0].executions[0], first);
  assert.equal(String(f.data.test_cases[0].executions[1].linkedBugId), result.result.insertedId);
  assert.equal(f.data.test_cases[0].executions[2].linkedBugId, null);
  assert.equal(f.data.bugs[0].sourceTestExecutionAttempt, 2);
});

test("Absent, malformed, mismatched or duplicate execution identifiers never cause an invented run", async (t) => {
  const f = fixture(t), record = f.data.test_cases[0];
  for (const values of [{ affectedReleaseVersion: "v99" }, { testExecutionAttempt: 9 }, { testExecutionAttempt: 0 }, { testExecutionAttempt: "1" }, { testExecutionAttempt: 1.5 }]) {
    assert.equal((await f.invoke(qa, insert(values))).ok, false);
  }
  record.executions.push(clone(record.executions[0]));
  assert.equal((await f.invoke(qa, insert({ affectedReleaseVersion: "v2.4", testExecutionAttempt: 1 }))).code, "BUG_TEST_EXECUTION_SELECTION");
  record.executions = [{ result: "FAIL", linkedBugId: null }];
  assert.equal((await f.invoke(qa, insert())).code, "BUG_TEST_EXECUTION_INVALID");
  record.executions = [];
  assert.equal((await f.invoke(qa, insert())).code, "BUG_TEST_EXECUTION_REQUIRED");
  assert.equal(f.data.bugs.length, 0); assert.equal(f.testWrites.length, 0);
});

test("Existing execution links are never overwritten and a repeated creation cannot duplicate the bug", async (t) => {
  const f = fixture(t);
  const created = await f.invoke(qa, insert());
  const again = await f.invoke(qa, insert());
  assert.equal(again.code, "BUG_TEST_ALREADY_LINKED"); assert.equal(again.retryable, false);
  assert.equal(f.data.bugs.length, 1); assert.equal(f.testWrites.length, 1);
  assert.equal(String(f.data.test_cases[0].executions[0].linkedBugId), created.result.insertedId);
});

test("Bug insertion, execution linking and audit failures roll back the entire QA creation", async (t) => {
  const f = fixture(t);
  for (const stage of ["failInsert", "failLink", "failAudit", "staleLink"]) {
    f.state[stage] = true;
    const result = await f.invoke(qa, insert());
    assert.equal(result.ok, false, stage);
    assert.equal(f.data.bugs.length, 0, `${stage}: no orphan bug`);
    assert.equal(f.data.test_cases[0].executions[0].linkedBugId, null, `${stage}: no dangling link`);
    assert.equal(f.writes.length, 0); assert.equal(f.testWrites.length, 0);
    assert.ok(f.data.audit_logs.every((entry) => entry.executionStatus !== "SUCCEEDED"));
    if (stage === "staleLink") { assert.equal(result.code, "BUG_TEST_EXECUTION_CHANGED"); assert.equal(result.retryable, false); }
    f.state[stage] = false;
  }
});

test("A transaction callback retry commits one bug and one matching execution link", async (t) => {
  const f = fixture(t); f.state.retryTransaction = true;
  const result = await f.invoke(qa, insert());
  assert.equal(result.ok, true, result.error);
  assert.equal(f.data.bugs.length, 1); assert.equal(f.writes.length, 1); assert.equal(f.testWrites.length, 1);
  assert.equal(String(f.data.bugs[0]._id), result.result.insertedId);
  assert.equal(String(f.data.test_cases[0].executions[0].linkedBugId), result.result.insertedId);
  assert.equal(f.data.audit_logs.filter((entry) => entry.executionStatus === "SUCCEEDED").length, 1);
});

test("Generic updates cannot break a linked bug's execution identity or write arbitrary test history", async (t) => {
  const f = fixture(t); await f.invoke(qa, insert()); const bug = f.data.bugs[0];
  for (const values of [{ sourceTestCase: "TC-107" }, { sourceTestCaseId: String(oid(99)) }, { testExecutionAttempt: 2 }, { affectedReleaseVersion: "v2.5" }, { productId: String(oid(99)) }]) {
    assert.equal((await f.invoke(qa, update(bug.bugKey, values))).code, "BUG_TEST_LINK_MANAGED");
  }
  const bypass = await f.invoke(qa, { collection: "test_cases", operation: "update_one", reason: "Bypass service", conditionsJson: JSON.stringify([{ field: "testCaseKey", operator: "eq", stringValue: "TC-106" }]), fieldsJson: JSON.stringify(fields({ "executions.0.linkedBugId": String(oid(99)) })) });
  assert.match(bypass.error, /FIELD_NOT_MUTABLE/);
  assert.equal(f.data.bugs[0].affectedReleaseVersion, "v2.4"); assert.equal(f.testWrites.length, 1);
});

test("Developer reports do not acquire QA execution-write privileges", async (t) => {
  const f = fixture(t);
  assert.match((await f.invoke(developer, insert())).error, /FIELD_NOT_MUTABLE:sourceTestCase/);
  const result = await f.invoke(developer, insert({ sourceTestCase: undefined }));
  assert.equal(result.ok, true, result.error); assert.equal(f.testWrites.length, 0);
  assert.equal(f.data.test_cases[0].executions[0].linkedBugId, null);
});

test("Chat asks QA for a test case, then links the selected run exactly once after clarification", async (t) => {
  const f = fixture(t), run = graph(t); let calls = 0;
  t.mock.method(models, "getModel", () => ({ bindTools() { return this; }, async invoke() {
    calls++;
    if (calls === 1 || calls === 3) return new AIMessage({ content: "", tool_calls: [{ id: `report-${calls}`, name: "bug_database_action", type: "tool_call", args: insert(calls === 1 ? { sourceTestCase: undefined } : {}) }] });
    return new AIMessage("Done.");
  } }));
  const first = await run({ caller: qa, agent: "BUG", threadId: "test-case-clarification", message: "Create HIGH login bug" });
  assert.match(first.response, /Which test case/); assert.equal(f.data.bugs.length, 0);
  const second = await run({ caller: qa, agent: "BUG", threadId: "test-case-clarification", message: "TC-106" });
  assert.match(second.response, /Created \*\*BUG-101/); assert.match(second.response, /Linked to \*\*TC-106\*\*, release \*\*v2.4\*\*, attempt \*\*1\*\*/);
  assert.equal(f.data.bugs.length, 1); assert.equal(f.testWrites.length, 1);
});
