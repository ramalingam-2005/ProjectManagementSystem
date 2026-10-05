const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { RequirementsDraftSchema } = require("../src/requirements-review.ts");
const { safeSessionId, chatThreadId } = require("../src/utils/chat-session.ts");
const { authorize } = require("../src/security/guardrails.ts");
const { validateMongoAction } = require("../src/security/mongo-validator.ts");
const { executeMongoRead } = require("../src/services/mongo-read.service.ts");
const database = require("../src/db/mongodb.ts");
const users = require("../src/repositories/user.repository.ts");
const reviews = require("../src/services/requirements-review.service.ts");
const { POST: reviewPost } = require("../app/api/requirements/review/route.ts");

// Node runs these top-level tests sequentially. Test-context mocks are restored
// after each case, including failures; no fixture connects to MongoDB or Groq.
const pm = { mongoUserId: "aaaaaaaaaaaaaaaaaaaaaaaa", userKey: "pm", name: "PM", role: "PRODUCT_MANAGER", active: true };
const developer = { ...pm, role: "DEVELOPER" };
const qa = { ...pm, role: "QA" };
const lead = { ...pm, role: "ENGINEERING_LEAD" };
const featureId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const epicId = "cccccccccccccccccccccccc";
const story = () => ({
  title: "Validate CSV rows",
  userStory: "As a PM I want invalid rows identified so I can correct the upload.",
  acceptanceCriteria: ["Each invalid row displays its row number and error."],
  storyPoints: 3,
  priority: "HIGH",
});
const draft = () => ({
  featureRequestId: featureId,
  epic: { title: "CSV import", description: "Import validated CSV records." },
  stories: [story()],
});
const read = (collection, extra = {}) => ({ collection, operation: "find", ...extra });
const mutation = (collection, field, extra = {}) => ({
  collection, operation: "update_one",
  conditions: [{ field: "_id", operator: "eq", stringValue: epicId }],
  fields: [field], reason: "Apply the requested change", ...extra,
});
const checkRead = (input, agent = "SPRINT_TASK", caller = pm) => validateMongoAction(agent, caller, input);

test("TC01 - New epic drafts trim surrounding text and preserve review content", () => {
  const input = draft();
  input.epic.title = "  CSV import  ";
  input.stories[0].acceptanceCriteria[0] = "  Report invalid rows.  ";
  const result = RequirementsDraftSchema.parse(input);
  assert.equal(result.epic.title, "CSV import");
  assert.deepEqual(result.stories[0].acceptanceCriteria, ["Report invalid rows."]);
  assert.equal(input.epic.title, "  CSV import  ", "parsing must not edit the submitted draft");
});

test("TC02 - Stories can target an existing epic without creating another epic", () => {
  const input = { featureRequestId: featureId, existingEpicId: epicId, stories: [story()] };
  assert.deepEqual(RequirementsDraftSchema.parse(input), input);
});

test("TC03 - An epic-only preview is valid with no new stories", () => {
  const input = { ...draft(), stories: [] };
  assert.deepEqual(RequirementsDraftSchema.parse(input), input);
});

test("TC04 - A draft cannot name both a new epic and an existing epic", () => {
  assert.equal(RequirementsDraftSchema.safeParse({ ...draft(), existingEpicId: epicId }).success, false);
});

test("TC05 - Stories without a new or existing epic are rejected", () => {
  assert.equal(RequirementsDraftSchema.safeParse({ featureRequestId: featureId, stories: [story()] }).success, false);
});

test("TC06 - Selecting an existing epic without adding stories is rejected", () => {
  assert.equal(RequirementsDraftSchema.safeParse({ featureRequestId: featureId, existingEpicId: epicId, stories: [] }).success, false);
});

test("TC07 - A preview accepts five stories and rejects a sixth", () => {
  const input = { ...draft(), stories: Array.from({ length: 5 }, story) };
  assert.equal(RequirementsDraftSchema.parse(input).stories.length, 5);
  input.stories.push(story());
  assert.equal(RequirementsDraftSchema.safeParse(input).success, false);
});

test("TC08 - Each story requires at least one nonblank acceptance criterion", () => {
  const input = draft();
  input.stories[0].acceptanceCriteria = [];
  assert.equal(RequirementsDraftSchema.safeParse(input).success, false);
  input.stories[0].acceptanceCriteria = ["   "];
  assert.equal(RequirementsDraftSchema.safeParse(input).success, false);
});

test("TC09 - A story accepts fifteen acceptance criteria and rejects sixteen", () => {
  const input = draft();
  input.stories[0].acceptanceCriteria = Array.from({ length: 15 }, (_, i) => `Validate row ${i + 1}.`);
  assert.equal(RequirementsDraftSchema.parse(input).stories[0].acceptanceCriteria.length, 15);
  input.stories[0].acceptanceCriteria.push("One more requirement.");
  assert.equal(RequirementsDraftSchema.safeParse(input).success, false);
});

test("TC10 - Story points accept integer boundaries and reject fractional estimates", () => {
  const input = draft();
  for (const points of [0, 100]) {
    input.stories[0].storyPoints = points;
    assert.equal(RequirementsDraftSchema.parse(input).stories[0].storyPoints, points);
  }
  input.stories[0].storyPoints = 2.5;
  assert.equal(RequirementsDraftSchema.safeParse(input).success, false);
});

test("TC11 - Session IDs trim whitespace and accept the eighty-character boundary", () => {
  const session = "a".repeat(78) + "_-";
  assert.equal(safeSessionId(`  ${session}  `), session);
});

test("TC12 - Session IDs longer than eighty characters are rejected", () => {
  assert.throws(() => safeSessionId("a".repeat(81)), /INVALID_SESSION_ID/);
});

test("TC13 - Path-like session IDs cannot become conversation identifiers", () => {
  assert.throws(() => chatThreadId(pm, "../another-user"), /INVALID_SESSION_ID/);
});

test("TC14 - Identical session names produce separate threads for different callers", () => {
  const other = { ...pm, mongoUserId: epicId };
  assert.equal(chatThreadId(pm, "shared"), `user_${pm.mongoUserId}_session_shared`);
  assert.notEqual(chatThreadId(pm, "shared"), chatThreadId(other, "shared"));
});

test("TC15 - Developers may update task status and blocker details within OWN scope", () => {
  const input = mutation("tasks", { field: "status", stringValue: "IN_PROGRESS" });
  input.fields.push({ field: "blocked", booleanValue: true }, { field: "blockerReason", stringValue: "Waiting for review" });
  assert.equal(authorize("SPRINT_TASK", developer, input).rule.scope, "OWN");
});

test("TC16 - Developers cannot reassign tasks through mutable fields", () => {
  assert.throws(() => authorize("SPRINT_TASK", developer,
    mutation("tasks", { field: "assigneeId", stringValue: epicId })), /FIELD_NOT_MUTABLE:assigneeId/);
});

test("TC17 - QA cannot overwrite a developer's bug fix summary", () => {
  assert.throws(() => authorize("BUG", qa,
    mutation("bugs", { field: "fixSummary", stringValue: "Pretend this was fixed" })), /FIELD_NOT_MUTABLE:fixSummary/);
});

test("TC18 - Product Managers cannot submit the QA release signoff", () => {
  assert.throws(() => authorize("RELEASE", pm,
    mutation("releases", { field: "qaSignoff", booleanValue: true })), /FIELD_NOT_MUTABLE:qaSignoff/);
});

test("TC19 - QA cannot submit the Product Manager release signoff", () => {
  assert.throws(() => authorize("RELEASE", qa,
    mutation("releases", { field: "pmSignoff", booleanValue: true })), /FIELD_NOT_MUTABLE:pmSignoff/);
});

test("TC20 - Engineering Leads cannot forge system-controlled epic metadata", () => {
  assert.throws(() => authorize("REQUIREMENTS", lead,
    mutation("epics", { field: "generatedByAI", booleanValue: false })), /FIELD_NOT_MUTABLE:generatedByAI/);
});

test("TC21 - Mutations require a record filter even for an authorized field", () => {
  assert.throws(() => authorize("RELEASE", pm,
    mutation("releases", { field: "pmSignoff", booleanValue: true }, { conditions: [] })), /UPDATE_REQUIRES_FILTER/);
});

test("TC22 - Inactive accounts cannot read documents or modify tasks", () => {
  const inactive = { ...developer, active: false };
  assert.throws(() => checkRead(read("documents"), "DOCUMENTATION", inactive), /USER_INACTIVE/);
  assert.throws(() => authorize("SPRINT_TASK", inactive,
    mutation("tasks", { field: "status", stringValue: "DONE" })), /USER_INACTIVE/);
});

test("TC23 - Extended ObjectId literals reject additional operator keys", () => {
  assert.throws(() => checkRead(read("tasks", { filter: { _id: { $oid: epicId, $ne: featureId } } })), /INVALID_OBJECT_ID/);
});

test("TC24 - Invalid ISO dates are rejected before database execution", () => {
  assert.throws(() => checkRead(read("tasks", { filter: { createdAt: { $gte: { $date: "2026-13-01T00:00:00Z" } } } })), /INVALID_DATE/);
});

test("TC25 - String values cannot masquerade as boolean task flags", () => {
  assert.throws(() => checkRead(read("tasks", { filter: { "blocker.blocked": "false" } })), /INVALID_BOOLEAN_VALUE/);
});

test("TC26 - Inclusion projections can suppress the MongoDB identifier", () => {
  const result = checkRead(read("tasks", { projection: { title: 1, _id: 0 } }));
  assert.deepEqual(result.projection, { _id: 0, title: 1 });
});

test("TC27 - Exclusion projections can explicitly retain the MongoDB identifier", () => {
  const result = checkRead(read("tasks", { projection: { description: 0, _id: 1 } }));
  assert.equal(result.projection._id, 1);
  assert.equal(result.projection.title, 1);
  assert.equal(result.projection.description, undefined);
  assert.equal(result.projection.password, undefined);
  const aggregation = checkRead(read("tasks", { operation: "aggregate", pipeline: [
    { $project: { description: 0, _id: 1 } },
  ] }));
  assert.deepEqual(aggregation.pipeline.at(-1).$project, result.projection);
});

test("TC28 - Mixing inclusion and exclusion of ordinary fields is rejected", () => {
  assert.throws(() => checkRead(read("tasks", { projection: { title: 1, description: 0 } })), /MIXED_PROJECTION/);
});

test("TC29 - Counts reject paging arguments instead of silently counting a page", () => {
  assert.throws(() => checkRead(read("tasks", { operation: "countDocuments", limit: 1 })), /COUNT_REQUIRES_FILTER_ONLY/);
});

test("TC30 - Single-record reads reject skip arguments", () => {
  assert.throws(() => checkRead(read("tasks", { operation: "findOne", skip: 1 })), /FIND_ONE_PAGING_NOT_ALLOWED/);
});

test("TC31 - Aggregations reject a separate top-level filter", () => {
  assert.throws(() => checkRead(read("tasks", { operation: "aggregate", pipeline: [], filter: { status: "TODO" } })), /AGGREGATE_REQUIRES_PIPELINE_ONLY/);
});

test("TC32 - Find requests cannot carry an aggregation pipeline", () => {
  assert.throws(() => checkRead(read("tasks", { pipeline: [{ $limit: 1 }] })), /PIPELINE_ONLY_FOR_AGGREGATE/);
});

test("TC33 - Regex options require a regex pattern", () => {
  assert.throws(() => checkRead(read("tasks", { filter: { title: { $options: "i" } } })), /REGEX_OPTIONS_NOT_ALLOWED/);
});

test("TC34 - Lookup aliases cannot overwrite stored task fields", () => {
  assert.throws(() => checkRead(read("tasks", { operation: "aggregate", pipeline: [
    { $lookup: { from: "user_stories", localField: "storyId", foreignField: "_id", as: "title" } },
  ] })), /OUTPUT_FIELD_COLLISION/);
});

test("TC35 - Unwind index aliases remain queryable numeric fields", () => {
  const result = checkRead(read("sprints", { operation: "aggregate", pipeline: [
    { $unwind: { path: "$capacities", includeArrayIndex: "capacityIndex", preserveNullAndEmptyArrays: true } },
    { $match: { capacityIndex: { $gte: 0 } } },
    { $project: { capacityIndex: 1, _id: 0 } },
  ] }));
  assert.deepEqual(result.pipeline[1], { $match: { capacityIndex: { $gte: 0 } } });
  assert.deepEqual(result.pipeline.at(-1), { $project: { _id: 0, capacityIndex: 1 } });
});

test("TC36 - Computed projections cannot read fields excluded from selection", () => {
  assert.throws(() => checkRead(read("sprints", { operation: "aggregate", pipeline: [
    { $project: { member: "$capacities.developerId" } },
  ] })), /FIELD_NOT_SELECTABLE:capacities.developerId/);
});

// A recording driver stub tests the executor contract without reimplementing
// MongoDB filtering, sorting, projection or aggregation semantics.
function readDriver(t, { rows = [], one = null, count = 0, readError } = {}) {
  const calls = [], audits = [];
  const state = { closed: 0 };
  const db = { collection(name) {
    return {
      find(filter, options) {
        const call = { collection: name, operation: "find", filter, options };
        calls.push(call);
        return {
          sort(value) { call.sort = value; return this; },
          skip(value) { call.skip = value; return this; },
          limit(value) { call.limit = value; return this; },
          async *[Symbol.asyncIterator]() { if (readError) throw readError; yield* rows; },
          async close() { state.closed++; },
        };
      },
      async findOne(filter, options) { calls.push({ collection: name, operation: "findOne", filter, options }); return one; },
      async countDocuments(filter, options) { calls.push({ collection: name, operation: "countDocuments", filter, options }); return count; },
      async insertOne(value) { assert.equal(name, "audit_logs", "reads may only write audit records"); audits.push(value); },
    };
  } };
  t.mock.method(database, "getDb", async () => db);
  return { calls, audits, state };
}

test("TC37 - Empty find results return a terminal page and a success audit", async (t) => {
  const f = readDriver(t);
  const result = await executeMongoRead("SPRINT_TASK", pm, read("tasks"));
  assert.deepEqual(result.result, { items: [], returned: 0, limit: 10, skip: 0, hasMore: false, nextSkip: null });
  assert.equal(f.state.closed, 1);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].executionStatus, "SUCCEEDED");
});

test("TC38 - Default pagination reads one extra row and adds a stable sort tie-breaker", async (t) => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ _id: new ObjectId(i.toString(16).padStart(24, "0")), title: "Same title" }));
  const f = readDriver(t, { rows });
  const result = await executeMongoRead("SPRINT_TASK", pm, read("tasks", { sort: { title: 1 } }));
  assert.deepEqual(result.result.items, rows.slice(0, 10));
  assert.equal(result.result.hasMore, true);
  assert.equal(result.result.nextSkip, 10);
  assert.equal(f.calls[0].limit, 11);
  assert.deepEqual(f.calls[0].sort, { title: 1, _id: 1 });
  assert.equal(f.calls[0].options.maxTimeMS, 5000);
  assert.equal(f.state.closed, 1);
});

test("TC39 - Missing single-record reads return null and remain audited", async (t) => {
  const f = readDriver(t);
  const result = await executeMongoRead("SPRINT_TASK", pm, read("tasks", { operation: "findOne", filter: { taskKey: "TASK-MISSING" } }));
  assert.equal(result.ok, true);
  assert.equal(result.result, null);
  assert.deepEqual(f.calls[0].filter, { taskKey: "TASK-MISSING" });
  assert.equal(f.calls[0].options.maxTimeMS, 5000);
  assert.equal(f.audits[0].executionStatus, "SUCCEEDED");
});

test("TC40 - Developer counts enforce ownership even with an empty OR branch", async (t) => {
  const f = readDriver(t, { count: 3 });
  const filter = { $or: [{ status: "TODO" }, {}] };
  const result = await executeMongoRead("SPRINT_TASK", developer, read("tasks", { operation: "countDocuments", filter }));
  assert.deepEqual(result.result, { count: 3 });
  assert.deepEqual(f.calls[0].filter, { $and: [filter, { assigneeId: new ObjectId(pm.mongoUserId) }] });
  assert.deepEqual(f.calls[0].options, { maxTimeMS: 5000 });
});

test("TC41 - Cursor failures close the cursor and hide driver connection details", async (t) => {
  const f = readDriver(t, { readError: new Error("DRIVER_FAILURE:mongodb://private-user:private-password@host") });
  await assert.rejects(executeMongoRead("SPRINT_TASK", pm, read("tasks")), {
    message: "DATABASE_READ_FAILED:Query execution or audit failed.",
  });
  assert.equal(f.state.closed, 1);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].validationResult, "ALLOWED");
  assert.equal(f.audits[0].executionStatus, "FAILED");
  assert.doesNotMatch(JSON.stringify(f.audits), /private-user|private-password/);
});

test("TC42 - Oversized single-record payloads are withheld and audited as failures", async (t) => {
  const f = readDriver(t, { one: { title: "Large task", description: "x".repeat(1_000_001) } });
  await assert.rejects(executeMongoRead("SPRINT_TASK", pm, read("tasks", { operation: "findOne" })), /RESULT_TOO_LARGE/);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].executionStatus, "FAILED");
  assert.equal(f.audits[0].resultSummary.code, "RESULT_TOO_LARGE");
  assert.ok(JSON.stringify(f.audits).length < 2000, "audit must not copy the oversized result");
});

function reviewRequest(extra = {}) {
  return {
    userId: "pm", sessionId: "acceptance", action: "approve",
    review: { id: "dddddddddddddddddddddddd", featureTitle: "CSV upload", draft: draft() },
    ...extra,
  };
}
function request(body, raw = false) {
  return new Request("http://localhost/api/requirements/review", {
    method: "POST", headers: { "content-type": "application/json" }, body: raw ? body : JSON.stringify(body),
  });
}
function reviewApi(t, { callerError, serviceError } = {}) {
  const calls = [];
  const service = {
    async approve(...args) { calls.push({ operation: "approve", args }); if (serviceError) throw serviceError; throw new Error("Unexpected approval in refusal/discard test"); },
    async discard(...args) { calls.push({ operation: "discard", args }); if (serviceError) throw serviceError; },
  };
  const callerMock = t.mock.method(users, "resolveCaller", async () => { if (callerError) throw callerError; return pm; });
  const serviceMock = t.mock.method(reviews, "getRequirementsReviewService", async () => service);
  // Any accidental database dependency is a test failure, even if credentials
  // happen to be present in the shell environment.
  const dbMock = t.mock.method(database, "getDb", async () => { throw new Error("Unexpected live database access"); });
  t.after(() => assert.equal(dbMock.mock.callCount(), 0));
  return { calls, callerMock, serviceMock };
}

test("TC43 - Malformed review JSON returns HTTP 400 before resolving a caller", async (t) => {
  const f = reviewApi(t);
  const response = await reviewPost(request('{"action":', true));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error: "Invalid review request." });
  assert.equal(f.callerMock.mock.callCount(), 0);
  assert.equal(f.serviceMock.mock.callCount(), 0);
});

test("TC44 - Missing explicit approval action returns HTTP 400 without service calls", async (t) => {
  const f = reviewApi(t);
  const body = reviewRequest();
  delete body.action;
  const response = await reviewPost(request(body));
  assert.equal(response.status, 400);
  assert.equal(f.callerMock.mock.callCount(), 0);
  assert.equal(f.serviceMock.mock.callCount(), 0);
});

test("TC45 - Client-supplied role overrides are rejected at the review API boundary", async (t) => {
  const f = reviewApi(t);
  const response = await reviewPost(request(reviewRequest({ role: "PRODUCT_MANAGER" })));
  assert.equal(response.status, 400);
  assert.equal(f.callerMock.mock.callCount(), 0);
  assert.equal(f.serviceMock.mock.callCount(), 0);
});

test("TC46 - Inactive review callers receive HTTP 403 before loading the service", async (t) => {
  const f = reviewApi(t, { callerError: new Error("USER_INACTIVE") });
  const response = await reviewPost(request(reviewRequest()));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).ok, false);
  assert.equal(f.serviceMock.mock.callCount(), 0);
});

test("TC47 - Unknown review accounts receive HTTP 404 without approval attempts", async (t) => {
  const f = reviewApi(t, { callerError: new Error("USER_NOT_FOUND") });
  const response = await reviewPost(request(reviewRequest()));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: "Account not found." });
  assert.equal(f.calls.length, 0);
});

test("TC48 - Stale reviews receive HTTP 409 with instructions for a fresh preview", async (t) => {
  const f = reviewApi(t, { serviceError: new Error("REVIEW_STALE") });
  const response = await reviewPost(request(reviewRequest()));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /fresh preview/i);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].operation, "approve");
});

test("TC49 - Save failures return HTTP 500 with retry guidance and no credentials", async (t) => {
  reviewApi(t, { serviceError: new Error("mongodb://private-user:private-password@host") });
  const response = await reviewPost(request(reviewRequest()));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /Retry this same review/);
  assert.doesNotMatch(JSON.stringify(body), /private-user|private-password/);
});

test("TC50 - Discard calls only the discard service with the caller's session thread", async (t) => {
  const f = reviewApi(t);
  const input = reviewRequest({ action: "discard" });
  const response = await reviewPost(request(input));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.match(body.response, /Draft discarded/);
  assert.equal(body.result, undefined);
  assert.deepEqual(f.calls, [{ operation: "discard", args: [pm, `user_${pm.mongoUserId}_session_acceptance`, input.review] }]);
});
