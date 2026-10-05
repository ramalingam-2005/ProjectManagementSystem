const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { validateMongoAction } = require("../src/security/mongo-validator.ts");
const { executeDatabaseAction } = require("../src/services/database-action.service.ts");
const { makeDatabaseTool } = require("../src/agent/db-tool.ts");
const { MONGO_LIMITS } = require("../src/security/mongo-policy.ts");
const pm = { mongoUserId: "aaaaaaaaaaaaaaaaaaaaaaaa", userKey: "pm", name: "PM", role: "PRODUCT_MANAGER", active: true };
const ownId = new ObjectId(pm.mongoUserId), otherId = new ObjectId("cccccccccccccccccccccccc");
const action = (collection, operation = "find", rest = {}) => ({ collection, operation, ...rest });
const eq = (a, b) => a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a === b;
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$and") return value.every((part) => matches(row, part));
    if (key === "$or") return value.some((part) => matches(row, part));
    const stored = key.split(".").reduce((obj, part) => obj?.[part], row);
    if (value && typeof value === "object" && !(value instanceof ObjectId) && !(value instanceof Date)) {
      return Object.entries(value).every(([op, arg]) => {
        if (op === "$eq") return eq(stored, arg);
        if (op === "$ne") return !eq(stored, arg);
        if (op === "$gt") return stored > arg;
        if (op === "$gte") return stored >= arg;
        if (op === "$lt") return stored < arg;
        if (op === "$lte") return stored <= arg;
        if (op === "$in") return arg.some((item) => eq(stored, item));
        if (op === "$nin") return !arg.some((item) => eq(stored, item));
        if (op === "$exists") return (stored !== undefined) === arg;
        if (op === "$not") return !matches(row, { [key]: arg });
        if (op === "$regex") return new RegExp(arg, value.$options).test(stored ?? "");
        if (op === "$options") return true;
        throw Error(`Unhandled mock operator ${op}`);
      });
    }
    return eq(stored, value);
  });
}
function fixture() {
  const data = {
    feature_requests: [{ _id: new ObjectId(), title: "Platform sourcing assistant", description: "Synthetic requirement 37.", featureRequestKey: "feature-313", status: "APPROVED", requestedBy: ownId, secret: "hidden" }],
    bugs: [{ _id: new ObjectId(), severity: "CRITICAL", status: "NEW", affectedReleaseVersion: "v1", assigneeId: ownId }],
    tasks: [{ _id: new ObjectId(), title: "Own task", storyPoints: 8, assigneeId: ownId, status: "IN_PROGRESS" },
      { _id: new ObjectId(), title: "Other task", storyPoints: 3, assigneeId: otherId, status: "TODO" }],
    documents: [{ _id: new ObjectId(), title: "Release guide", type: "PROCESS" }],
  };
  const calls = [], audits = [];
  const state = { aggregateRows: [], failAudit: false, failRead: false, closed: 0 };
  function cursor(rows, projection) {
    let skip = 0, limit = Infinity, sort = {};
    const values = () => {
      let result = [...rows].sort((a, b) => {
        for (const [field, dir] of Object.entries(sort)) {
          if (String(a[field]) < String(b[field])) return -dir;
          if (String(a[field]) > String(b[field])) return dir;
        }
        return 0;
      }).slice(skip, skip + limit);
      if (projection) result = result.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => projection[key] === 1)));
      return result;
    };
    return { sort(value) { sort = value; return this; }, skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; },
      map(fn) { this.transform = fn; return this; },
      async toArray() { return this.transform ? values().map(this.transform) : values(); },
      async *[Symbol.asyncIterator]() { if (state.failRead) throw Error("mongodb://secret:password@host"); yield* values(); },
      async close() { state.closed++; } };
  }
  const db = { collection(name) {
    const rows = data[name] ?? [];
    return {
      find(filter, options) { calls.push({ name, op: "find", filter, options }); return cursor(rows.filter((row) => matches(row, filter)), options?.projection); },
      async findOne(filter, options) { calls.push({ name, op: "findOne", filter, options }); return (await cursor(rows.filter((row) => matches(row, filter)), options?.projection).toArray())[0] ?? null; },
      async countDocuments(filter, options) { calls.push({ name, op: "countDocuments", filter, options }); return rows.filter((row) => matches(row, filter)).length; },
      aggregate(pipeline, options) { calls.push({ name, op: "aggregate", pipeline, options }); return cursor(state.aggregateRows); },
      async distinct(key, filter) { calls.push({ name, op: "distinct", filter }); return rows.filter((row) => matches(row, filter)).map((row) => row[key]); },
      async insertOne(doc) { assert.equal(name, "audit_logs", "native read engine must never write business records"); if (state.failAudit) throw Error("audit unavailable"); audits.push(doc); },
    };
  } };
  return { db, data, calls, audits, state };
}
async function withFixture(work) {
  const database = require("../src/db/mongodb.ts");
  const original = database.getDb;
  const f = fixture(); database.getDb = async () => f.db;
  try { await work(f); } finally { database.getDb = original; }
}

test("all five agents share the native tool and preserve their real collection grants", async () => {
  await withFixture(async (f) => {
    const inputs = [
      ["REQUIREMENTS", action("feature_requests", "find", { filter: { status: "APPROVED" } })],
      ["BUG", action("bugs", "find", { filter: { status: "NEW", severity: "CRITICAL" } })],
      ["SPRINT_TASK", action("tasks", "find", { filter: { storyPoints: { $gt: 5 } } })],
      ["RELEASE", action("bugs", "find", { filter: { affectedReleaseVersion: "v1", severity: "CRITICAL", status: { $ne: "VERIFIED_CLOSED" } } })],
      ["DOCUMENTATION", action("documents", "find", { filter: { title: { $regex: "guide", $options: "i" } } })],
    ];
    for (const [agent, input] of inputs) {
      const result = JSON.parse(await makeDatabaseTool(agent, pm, []).invoke(input));
      assert.equal(result.ok, true, result.error);
      assert.equal(result.result.returned, 1);
    }
    assert.equal(f.audits.length, 5);
    assert.ok(f.audits.every((entry) => entry.validationResult === "ALLOWED" && entry.executionStatus === "SUCCEEDED"));
    assert.ok(f.calls.every((call) => call.options.maxTimeMS === MONGO_LIMITS.maxTimeMS));
  });
});

test("find/findOne/countDocuments use native filters, projections and bounded pagination", async () => {
  await withFixture(async (f) => {
    f.data.feature_requests = Array.from({ length: 37 }, (_, index) => ({ _id: new ObjectId(), title: `Feature ${index}`, status: "APPROVED", secret: "hidden" }));
    const first = await executeDatabaseAction("REQUIREMENTS", pm, action("feature_requests", "find", { limit: 25, projection: { title: 1, _id: 0 } }));
    assert.equal(first.result.returned, 25); assert.equal(first.result.nextSkip, 25);
    assert.deepEqual(Object.keys(first.result.items[0]), ["title"]);
    const second = await executeDatabaseAction("REQUIREMENTS", pm, action("feature_requests", "find", { limit: 25, skip: 25 }));
    assert.equal(second.result.returned, 12); assert.equal(second.result.hasMore, false);
    const one = await executeDatabaseAction("REQUIREMENTS", pm, action("feature_requests", "findOne", { filter: { title: "Feature 3" } }));
    assert.equal(one.result.title, "Feature 3"); assert.equal(one.result.secret, undefined);
    assert.equal((await executeDatabaseAction("REQUIREMENTS", pm, action("feature_requests", "countDocuments"))).result.count, 37);
    assert.equal(f.state.closed, 2);
  });
});

test("native nested text and numeric predicates preserve user text without invented ID mappings", async () => {
  await withFixture(async () => {
    const result = await executeDatabaseAction("REQUIREMENTS", pm, action("feature_requests", "find", {
      filter: { $or: [{ title: { $regex: "Synthetic requirement 37", $options: "i" } }, { description: { $regex: "Synthetic requirement 37", $options: "i" } }] },
    }));
    assert.equal(result.result.items[0].featureRequestKey, "feature-313");
  });
  const input = action("tasks", "find", { filter: { $and: [{ storyPoints: { $gte: 3, $lte: 8 } },
    { $or: [{ status: { $in: ["TODO", "IN_PROGRESS"] } }, { priority: { $not: { $eq: "LOW" } } }] }, { releaseVersion: { $exists: false } }] } });
  assert.doesNotThrow(() => validateMongoAction("SPRINT_TASK", pm, input));
});

test("ObjectId/date values convert only in typed literal positions", () => {
  const result = validateMongoAction("REQUIREMENTS", pm, action("feature_requests", "find", {
    filter: { _id: { $in: [pm.mongoUserId, { $oid: pm.mongoUserId }] }, createdAt: { $gte: { $date: "2026-01-01T00:00:00Z" } } },
  }));
  assert.ok(result.filter._id.$in.every((value) => value instanceof ObjectId));
  assert.ok(result.filter.createdAt.$gte instanceof Date);
  assert.throws(() => validateMongoAction("SPRINT_TASK", pm, action("tasks", "find", { filter: { storyPoints: "5" } })), /INVALID_NUMBER/);
});

const epicLookup = { $lookup: { from: "epics", localField: "_id", foreignField: "featureRequestId", as: "epics" } };
const storyLookup = { $lookup: { from: "user_stories", localField: "epics._id", foreignField: "epicId", as: "stories" } };
test("feature -> epic -> story pipeline validates each changing field context and reaches the driver as native stages", async () => {
  await withFixture(async (f) => {
    const input = action("feature_requests", "aggregate", { pipeline: [{ $match: { status: "APPROVED" } }, epicLookup, { $unwind: "$epics" }, storyLookup,
      { $project: { title: 1, epics: 1, stories: 1 } }, { $sort: { title: 1 } }] });
    f.state.aggregateRows = [{ title: "Feature", epics: { title: "Epic" }, stories: [{ title: "Story" }] }];
    const result = await executeDatabaseAction("REQUIREMENTS", pm, input);
    assert.equal(result.result.items[0].stories[0].title, "Story");
    const call = f.calls.find((entry) => entry.op === "aggregate");
    assert.equal(call.pipeline[1].$lookup.from, "epics");
    assert.equal(call.pipeline[3].$lookup.localField, "epics._id");
    assert.ok(call.pipeline[1].$lookup.pipeline.at(-1).$project);
    assert.deepEqual(call.pipeline.at(-1), { $limit: 26 });
    assert.equal(call.options.allowDiskUse, false);
    assert.equal(input.pipeline[1].$lookup.pipeline, undefined, "validator must not mutate caller input");
  });
});

test("nested authorized lookups validate and every foreign array gets a safe projection", () => {
  const result = validateMongoAction("REQUIREMENTS", pm, action("feature_requests", "aggregate", { pipeline: [
    { $lookup: { ...epicLookup.$lookup, pipeline: [{ $lookup: { from: "user_stories", localField: "_id", foreignField: "epicId", as: "stories" } }] } },
  ] }));
  const outer = result.pipeline[0].$lookup;
  assert.ok(outer.pipeline[0].$lookup.pipeline.at(-1).$project.storyKey);
  assert.equal(outer.pipeline.at(-1).$project.stories, 1);
});

test("base and foreign OWN scopes are injected before user stages; OR cannot bypass scope", async () => {
  await withFixture(async (f) => {
    const developer = { ...pm, role: "DEVELOPER" };
    const rows = await executeDatabaseAction("SPRINT_TASK", developer, action("tasks", "find", { filter: { $or: [{ status: "TODO" }, {}] } }));
    assert.equal(rows.result.returned, 1); assert.equal(rows.result.items[0].title, "Own task");
    await executeDatabaseAction("SPRINT_TASK", developer, action("tasks", "aggregate", { pipeline: [
      { $lookup: { from: "tasks", localField: "storyId", foreignField: "storyId", as: "related", pipeline: [{ $match: { $or: [{ status: "TODO" }, {}] } }] } },
    ] }));
    const call = f.calls.find((entry) => entry.op === "aggregate");
    assert.equal(String(call.pipeline[0].$match.assigneeId), pm.mongoUserId);
    assert.equal(String(call.pipeline[1].$lookup.pipeline[0].$match.assigneeId), pm.mongoUserId);
    assert.ok(call.pipeline[1].$lookup.pipeline[1].$match.$or);
  });
});

test("group/count/project aliases have validated shapes and unknown post-project fields are rejected", () => {
  const result = validateMongoAction("SPRINT_TASK", pm, action("tasks", "aggregate", { pipeline: [
    { $group: { _id: "$status", points: { $sum: "$storyPoints" }, total: { $sum: 1 } } },
    { $match: { total: { $gt: 0 } } }, { $sort: { points: -1 } }, { $project: { _id: 1, total: 1, points: 1 } },
  ] }));
  assert.equal(result.pipeline.at(-1).$project.total, 1);
  assert.doesNotThrow(() => validateMongoAction("BUG", pm, action("bugs", "aggregate", { pipeline: [{ $count: "openCount" }] })));
  assert.throws(() => validateMongoAction("SPRINT_TASK", pm, action("tasks", "aggregate", { pipeline: [{ $project: { title: 1, _id: 0 } }, { $match: { status: "TODO" } }] })), /FIELD_NOT_QUERYABLE/);
});

test("ASSIGNED/TEAM scopes and feature ownership use the existing caller relationships", async () => {
  await withFixture(async (f) => {
    const developer = { ...pm, role: "DEVELOPER" };
    f.data.bugs.push({ _id: new ObjectId(), assigneeId: otherId, title: "Other bug" });
    const assigned = await executeDatabaseAction("BUG", developer, action("bugs"));
    assert.equal(assigned.result.returned, 1);
    f.data.users = [{ _id: otherId, reportsToUserId: ownId, active: true }];
    const lead = { ...pm, role: "ENGINEERING_LEAD" };
    const team = await executeDatabaseAction("SPRINT_TASK", lead, action("tasks"));
    assert.equal(team.result.returned, 2);
    f.data.feature_requests.push({ _id: new ObjectId(), requestedBy: otherId, title: "Other request" });
    const features = await executeDatabaseAction("REQUIREMENTS", developer, action("feature_requests"));
    assert.equal(features.result.returned, 1);
    await assert.rejects(executeDatabaseAction("SPRINT_TASK", developer, action("tasks", "find", { filter: { $or: [{ assigneeId: pm.mongoUserId }] } })), /DEVELOPER_CAN_ONLY/);
  });
});

test("lookup depth, count, skip and response limits are enforced independently", () => {
  const check = (input) => validateMongoAction("REQUIREMENTS", pm, input);
  let nested = [];
  for (let index = 0; index < 4; index++) nested = [{ $lookup: { from: "epics", pipeline: nested, as: "children" } }];
  assert.throws(() => check(action("feature_requests", "aggregate", { pipeline: nested })), /LOOKUP_DEPTH|QUERY_TOO_DEEP/);
  assert.throws(() => check(action("feature_requests", "aggregate", { pipeline: Array.from({ length: 7 }, (_, index) => ({ $lookup: { ...epicLookup.$lookup, as: `epics${index}` } })) })), /LOOKUP_COUNT/);
  for (const skip of [-1, 1.5, 10001]) assert.throws(() => check(action("feature_requests", "find", { skip })), /SKIP_EXCEEDED/);
  assert.throws(() => check(action("feature_requests", "aggregate", { pipeline: [{ $limit: 100 }] })), /limit_EXCEEDED/);
  assert.throws(() => check(action("feature_requests", "find", { filter: { title: /evil/ } })), /INVALID_MONGO_OBJECT/);
});

test("security rejections never execute target reads, including nested unauthorized lookups", async () => {
  await withFixture(async (f) => {
    const bad = [
      ["BUG", action("feature_requests"), /COLLECTION_NOT_ALLOWED/],
      ["BUG", action("bugs", "deleteMany"), /OPERATION_NOT_ALLOWED/],
      ["BUG", action("bugs", "find", { filter: { fakeField: "x" } }), /FIELD_NOT_QUERYABLE/],
      ["BUG", action("bugs", "find", { filter: { $and: [{ $or: [{ $where: "return true" }] }] } }), /OPERATOR_NOT_ALLOWED/],
      ["BUG", action("bugs", "aggregate", { pipeline: [{ $lookup: { from: "users", localField: "assigneeId", foreignField: "_id", as: "users" } }] }), /COLLECTION_NOT_ALLOWED:users/],
      ["REQUIREMENTS", action("feature_requests", "aggregate", { pipeline: [{ $lookup: { ...epicLookup.$lookup, pipeline: [{ $lookup: { from: "users", pipeline: [], as: "owners" } }] } }] }), /COLLECTION_NOT_ALLOWED:users/],
      ["BUG", action("bugs", "find", { limit: 100 }), /LIMIT_EXCEEDED/],
      ["BUG", action("bugs", "aggregate", { pipeline: [{ $out: "bugs" }] }), /STAGE_NOT_ALLOWED/],
      ["BUG", action("bugs", "aggregate", { pipeline: [{ $match: {}, $limit: 1 }] }), /INVALID_AGGREGATION_STAGE/],
      ["BUG", action("bugs", "aggregate", { pipeline: [{ $project: { stolen: "$$ROOT" } }] }), /EXPRESSION_VARIABLE/],
      ["BUG", action("bugs", "aggregate", { pipeline: [{ $group: { _id: null, secret: { $accumulator: { init: "function(){}" } } } }] }), /ACCUMULATOR_NOT_ALLOWED/],
      ["BUG", action("bugs", "find", { filter: { title: { $regex: "(a+)+$" } } }), /UNSAFE_REGEX/],
      ["BUG", action("bugs", "find", { filter: { title: { $in: [{ $function: "evil" }] } } }), /INVALID_STRING/],
      ["BUG", action("bugs", "find", { filter: { title: { $in: Array(21).fill("x") } } }), /IN_ARRAY_LIMIT/],
      ["BUG", action("bugs", "find", { projection: { password: 1 } }), /FIELD_NOT_SELECTABLE/],
      ["BUG", action("bugs", "find", { sort: { fake: 1 } }), /FIELD_NOT_QUERYABLE/],
      ["BUG", action("bugs", "find", { filter: { title: { $not: { $where: "evil" } } } }), /OPERATOR_NOT_ALLOWED/],
    ];
    for (const [agent, input, error] of bad) await assert.rejects(executeDatabaseAction(agent, pm, input), error);
    assert.equal(f.calls.length, 0);
    assert.equal(f.audits.length, bad.length);
    assert.ok(f.audits.every((row) => row.executionStatus === "NOT_EXECUTED"));
  });
});

test("prototype/code input, malformed shapes, excessive depth and unsupported lookup forms fail closed", () => {
  const check = (input) => validateMongoAction("REQUIREMENTS", pm, input);
  assert.throws(() => check('db.collection("users").find({})'), /INVALID_MONGO_ACTION_SCHEMA/);
  assert.throws(() => check({ collection: "feature_requests", operation: "find", filter: { title: () => true } }), /INVALID_MONGO_OBJECT/);
  assert.throws(() => check(JSON.parse('{"collection":"feature_requests","operation":"find","filter":{"__proto__":{"polluted":true}}}')), /UNSAFE_FIELD/);
  let filter = { title: "x" }; for (let i = 0; i < 20; i++) filter = { $and: [filter] };
  assert.throws(() => check(action("feature_requests", "find", { filter })), /QUERY_TOO_DEEP/);
  assert.throws(() => check(action("feature_requests", "aggregate", { pipeline: Array.from({ length: 21 }, () => ({ $match: {} })) })), /PIPELINE_LENGTH/);
  for (const lookup of [ { ...epicLookup.$lookup, let: { id: "$_id" } }, { ...epicLookup.$lookup, localField: "fake" },
    { ...epicLookup.$lookup, foreignField: "fake" }, { ...epicLookup.$lookup, as: "title" } ]) {
    assert.throws(() => check(action("feature_requests", "aggregate", { pipeline: [{ $lookup: lookup }] })), /LOOKUP_FORM|FIELD_NOT_QUERYABLE|OUTPUT_FIELD_COLLISION/);
  }
  assert.throws(() => check(action("feature_requests", "find", { conditionsJson: "[]" })), /INVALID_MONGO_ACTION_SCHEMA/);
});

test("resource budgets, cursor cleanup, audit failure, redaction and mutation bypass protection", async () => {
  await withFixture(async (f) => {
    f.state.aggregateRows = Array.from({ length: 100 }, () => ({ title: "x" }));
    const result = await executeDatabaseAction("BUG", pm, action("bugs", "aggregate", { pipeline: [] }));
    assert.equal(result.result.returned, 25); assert.equal(result.result.hasMore, true); assert.equal(f.state.closed, 1);
    f.state.aggregateRows = [{ title: "x".repeat(MONGO_LIMITS.responseBytes + 1) }];
    await assert.rejects(executeDatabaseAction("BUG", pm, action("bugs", "aggregate", { pipeline: [] })), /RESULT_TOO_LARGE/);
    assert.equal(f.state.closed, 2);
    f.state.failAudit = true;
    await assert.rejects(executeDatabaseAction("BUG", pm, action("bugs")), /DATABASE_READ_FAILED/);
    f.state.failAudit = false;
    const traces = [];
    const refused = JSON.parse(await makeDatabaseTool("REQUIREMENTS", pm, traces).invoke({ collection: "epics", operation: "update_one", filter: {}, reason: "bypass" }));
    assert.match(refused.error, /NATIVE_MUTATIONS_NOT_ALLOWED/);
    await executeDatabaseAction("BUG", pm, action("bugs", "find", { filter: { title: "mongodb://user:secret@host" } }));
    assert.ok(!JSON.stringify(f.audits).includes("user:secret"));
    assert.equal(f.audits.at(-1).generatedAction.filter.title, "[redacted MongoDB URI]");
  });
});
