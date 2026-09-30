const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId, BSON } = require("mongodb");
const { RequirementsReviewService } = require("../src/services/requirements-review.service.ts");
const { authorize } = require("../src/security/guardrails.ts");

const pm = { mongoUserId: "aaaaaaaaaaaaaaaaaaaaaaaa", userKey: "pm", name: "PM", role: "PRODUCT_MANAGER", active: true };
const thread = `user_${pm.mongoUserId}_session_review`;
const featureId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const draft = () => ({
  featureRequestId: featureId,
  epic: { title: "CSV import", description: "Allow users to import records from CSV files." },
  stories: [{ title: "Validate uploaded data", userStory: "As a PM I want invalid rows explained so I can fix them.", acceptanceCriteria: ["Show row numbers for invalid values."], storyPoints: 3, priority: "HIGH" }],
});
const clone = (value) => BSON.deserialize(BSON.serialize({ value })).value;

function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((branch) => matches(row, branch));
    if (key === "$and") return value.every((branch) => matches(row, branch));
    if (value && typeof value === "object" && "$regex" in value) return new RegExp(value.$regex, value.$options).test(String(row[key] ?? ""));
    if (value && typeof value === "object" && "$in" in value) return value.$in.includes(row[key]);
    if (value && typeof value === "object" && "$gt" in value) return row[key] > value.$gt;
    if (value instanceof ObjectId) return String(row[key]) === String(value);
    return row[key] === value;
  });
}

function fixture() {
  let data = { feature_requests: [{ _id: new ObjectId(featureId), featureRequestKey: "FR-113", title: "Bulk CSV upload" }] };
  let failCollection;
  const queries = [];
  const rows = (name) => data[name] ??= [];
  const db = { collection(name) {
    const assertWrite = (options) => {
      if (["epics", "user_stories", "audit_logs"].includes(name)) assert.ok(options?.session, "business writes must use the transaction");
      if (failCollection === name) throw new Error("SIMULATED_WRITE_FAILURE");
    };
    return {
      async findOne(filter) { const found = rows(name).find((row) => matches(row, filter)); return found ? clone(found) : null; },
      find(filter, options) {
        const query = { collection: name, filter, projection: options?.projection, sort: {}, offset: 0, limit: Infinity };
        queries.push(query);
        return {
          sort(value) { query.sort = value; return this; },
          skip(value) { query.offset = value; return this; },
          limit(value) { query.limit = value; return this; },
          async toArray() {
            const found = rows(name).filter((row) => matches(row, filter)).sort((a, b) => {
              for (const [field, direction] of Object.entries(query.sort)) {
                const left = a[field] instanceof ObjectId ? String(a[field]) : a[field];
                const right = b[field] instanceof ObjectId ? String(b[field]) : b[field];
                if (left < right) return -direction;
                if (left > right) return direction;
              }
              return 0;
            }).slice(query.offset, query.offset + query.limit);
            return clone(found.map((row) => query.projection
              ? Object.fromEntries(Object.entries(row).filter(([key]) => query.projection[key])) : row));
          },
        };
      },
      async replaceOne(filter, replacement, options) {
        const index = rows(name).findIndex((row) => matches(row, filter));
        if (index >= 0) rows(name)[index] = { _id: rows(name)[index]._id, ...clone(replacement) };
        else if (options?.upsert) rows(name).push({ ...filter, ...clone(replacement) });
        return { matchedCount: index >= 0 ? 1 : 0 };
      },
      async updateOne(filter, update) {
        const row = rows(name).find((item) => matches(item, filter));
        if (!row) return { matchedCount: 0 };
        Object.assign(row, clone(update.$set ?? {}));
        for (const key of Object.keys(update.$unset ?? {})) delete row[key];
        return { matchedCount: 1 };
      },
      async insertOne(document, options) { assertWrite(options); rows(name).push(clone(document)); },
      async insertMany(documents, options) { assertWrite(options); rows(name).push(...clone(documents)); },
    };
  } };
  let queue = Promise.resolve();
  const transaction = (work) => {
    const result = queue.then(async () => {
      const snapshot = clone(data);
      try { return await work({ testSession: true }); }
      catch (error) { data = snapshot; throw error; }
    });
    queue = result.catch(() => {});
    return result;
  };
  const service = new RequirementsReviewService(db, transaction);
  return {
    service, db, rows, queries, fail: (name) => { failCollection = name; },
    async preview(value = draft()) {
      const revision = await service.begin(pm, thread);
      return service.propose(pm, thread, revision, value);
    },
  };
}

test("preview creates approval metadata, with no epic, story or audit insert", async () => {
  const f = fixture();
  const review = await f.preview();
  assert.equal(review.featureTitle, "Bulk CSV upload");
  for (const name of ["epics", "user_stories", "audit_logs"]) assert.equal(f.rows(name).length, 0);
  const metadata = JSON.stringify(f.rows("requirements_reviews"));
  assert.ok(!metadata.includes("CSV import"));
  assert.ok(!metadata.includes("acceptanceCriteria"));
});

test("the generic action guard blocks direct PM inserts, including invented approval flags", () => {
  for (const collection of ["epics", "user_stories"]) for (const operation of ["insert_one", "insert_many"]) {
    assert.throws(() => authorize("REQUIREMENTS", pm, {
      collection, operation, fields: [{ field: "title", stringValue: "Skip review" }],
      reason: "PM said approved", approved: true,
    }), /PM_REVIEW_REQUIRED|OPERATION_NOT_ALLOWED/);
  }
  assert.doesNotThrow(() => authorize("REQUIREMENTS", pm, { collection: "epics", operation: "find", reason: "Read existing epic" }));
});

test("approval saves exactly the reviewed data as DRAFT and links stories to the new epic", async () => {
  const f = fixture();
  const review = await f.preview();
  const result = await f.service.approve(pm, thread, review);
  const epic = f.rows("epics")[0];
  const story = f.rows("user_stories")[0];
  assert.equal(epic.title, review.draft.epic.title);
  assert.equal(epic.description, review.draft.epic.description);
  assert.equal(String(epic.featureRequestId), featureId);
  assert.equal(epic.status, "DRAFT");
  assert.equal(story.status, "DRAFT");
  assert.deepEqual(story.acceptanceCriteria, review.draft.stories[0].acceptanceCriteria);
  assert.equal(String(story.epicId), result.epic.id);
  assert.equal(String(story.createdBy), pm.mongoUserId);
  assert.equal(story.generatedByAI, true);
  assert.equal(f.rows("tasks").length, 0);
  assert.equal(f.rows("audit_logs").length, 1);
});

test("editing immediately invalidates approval; only the replacement can be saved", async () => {
  const f = fixture();
  const old = await f.preview();
  const revision = await f.service.begin(pm, thread, old);
  await assert.rejects(f.service.approve(pm, thread, old), /REVIEW_STALE/);
  const revised = draft();
  revised.stories[0].storyPoints = 5;
  const current = await f.service.propose(pm, thread, revision, revised);
  await assert.rejects(f.service.approve(pm, thread, old), /REVIEW_STALE/);
  await f.service.approve(pm, thread, current);
  assert.equal(f.rows("user_stories")[0].storyPoints, 5);
});

test("a failed revision can be retried without making the old draft approvable", async () => {
  const f = fixture();
  const old = await f.preview();
  await f.service.begin(pm, thread, old);
  const retry = await f.service.begin(pm, thread, old);
  const current = await f.service.propose(pm, thread, retry, draft());
  await f.service.approve(pm, thread, current);
  assert.equal(f.rows("epics").length, 1);
});

test("changed payloads, other PMs, other sessions, non-PMs and inactive callers cannot approve", async () => {
  const f = fixture();
  const review = await f.preview();
  const changed = clone(review);
  changed.draft.epic.title = "Unreviewed replacement";
  await assert.rejects(f.service.approve(pm, thread, changed), /REVIEW_STALE/);
  await assert.rejects(f.service.approve({ ...pm, mongoUserId: "cccccccccccccccccccccccc" }, thread, review), /REVIEW_STALE/);
  await assert.rejects(f.service.approve(pm, thread + "other", review), /REVIEW_STALE/);
  for (const role of ["DEVELOPER", "QA", "ENGINEERING_LEAD"]) {
    await assert.rejects(f.service.approve({ ...pm, role }, thread, review), /REVIEW_PM_ONLY/);
  }
  await assert.rejects(f.service.approve({ ...pm, active: false }, thread, review), /REVIEW_PM_ONLY/);
  assert.equal(f.rows("epics").length, 0);
});

test("simultaneous approval retries return the same receipt and create one bundle", async () => {
  const f = fixture();
  const review = await f.preview();
  const [first, second] = await Promise.all([f.service.approve(pm, thread, review), f.service.approve(pm, thread, review)]);
  assert.deepEqual(first, second);
  assert.equal(f.rows("epics").length, 1);
  assert.equal(f.rows("user_stories").length, 1);
  assert.equal(f.rows("audit_logs").length, 1);
});

test("discarded and expired reviews cannot create records", async () => {
  const f = fixture();
  const discarded = await f.preview();
  await f.service.discard(pm, thread, discarded);
  await assert.rejects(f.service.approve(pm, thread, discarded), /REVIEW_STALE/);
  const expired = await f.preview();
  f.rows("requirements_reviews")[0].expiresAt = new Date(0);
  await assert.rejects(f.service.approve(pm, thread, expired), /REVIEW_STALE/);
  assert.equal(f.rows("epics").length, 0);
});

test("a story write failure rolls back the epic, approval and audit so the same review can retry", async () => {
  const f = fixture();
  const review = await f.preview();
  f.fail("user_stories");
  await assert.rejects(f.service.approve(pm, thread, review), /SIMULATED_WRITE_FAILURE/);
  assert.equal(f.rows("epics").length, 0);
  assert.equal(f.rows("audit_logs").length, 0);
  assert.equal(f.rows("requirements_reviews")[0].status, "pending");
  f.fail(undefined);
  await f.service.approve(pm, thread, review);
  assert.equal(f.rows("epics").length, 1);
});

test("existing epics are reused only for the referenced feature and are not changed", async () => {
  const f = fixture();
  const epicId = new ObjectId();
  f.rows("epics").push({ _id: epicId, featureRequestId: new ObjectId(featureId), epicKey: "EPIC-101", title: "Existing epic", status: "APPROVED" });
  const input = draft();
  delete input.epic;
  input.existingEpicId = String(epicId);
  const review = await f.preview(input);
  await f.service.approve(pm, thread, review);
  assert.equal(f.rows("epics").length, 1);
  assert.equal(f.rows("epics")[0].status, "APPROVED");
  assert.equal(String(f.rows("user_stories")[0].epicId), String(epicId));
  input.featureRequestId = String(new ObjectId());
  await assert.rejects(f.preview(input), /REVIEW_FEATURE_NOT_FOUND/);
});

test("source records are checked again at approval time", async () => {
  const f = fixture();
  const review = await f.preview();
  f.rows("feature_requests").splice(0);
  await assert.rejects(f.service.approve(pm, thread, review), /REVIEW_FEATURE_NOT_FOUND/);
  assert.equal(f.rows("epics").length, 0);
  assert.equal(f.rows("requirements_reviews")[0].status, "pending");
});

test("an older generation cannot replace a newer preview", async () => {
  const f = fixture();
  const first = await f.service.begin(pm, thread);
  const second = await f.service.begin(pm, thread);
  await assert.rejects(f.service.propose(pm, thread, first, draft()), /REVIEW_STALE/);
  await f.service.propose(pm, thread, second, draft());
  await assert.rejects(f.service.propose(pm, thread, second, draft()), /REVIEW_STALE/);
});

test("draft validation rejects model-supplied status and invalid story points", async () => {
  const f = fixture();
  const input = draft();
  input.stories[0].status = "APPROVED";
  await assert.rejects(f.preview(input));
  delete input.stories[0].status;
  input.stories[0].storyPoints = -1;
  await assert.rejects(f.preview(input));
  assert.equal(f.rows("epics").length, 0);
});

test("the draft tool produces a review and does not insert business records", async () => {
  const { makeRequirementsDraftTool } = require("../src/agent/requirements-draft-tool.ts");
  const f = fixture();
  let review;
  const revision = await f.service.begin(pm, thread);
  const tool = makeRequirementsDraftTool({ caller: pm, threadId: thread, revision, service: f.service, onReview: (value) => { review = value; } });
  const result = JSON.parse(await tool.invoke({ draftJson: JSON.stringify(draft()) }));
  assert.equal(result.status, "AWAITING_PM_REVIEW");
  assert.equal(review.draft.epic.title, draft().epic.title);
  assert.equal(f.rows("epics").length, 0);
  const invalid = JSON.parse(await tool.invoke({ draftJson: "not json" }));
  assert.equal(invalid.ok, false);
});

test("review API validates the request, checks the caller and saves only on explicit approve", async () => {
  const users = require("../src/repositories/user.repository.ts");
  const services = require("../src/services/requirements-review.service.ts");
  const originalCaller = users.resolveCaller;
  const originalService = services.getRequirementsReviewService;
  const f = fixture();
  const review = await f.preview();
  let caller = pm;
  users.resolveCaller = async () => caller;
  services.getRequirementsReviewService = async () => f.service;
  try {
    const { POST } = require("../app/api/requirements/review/route.ts");
    const request = (body) => new Request("http://localhost/api/requirements/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const body = { userId: "pm", sessionId: "review", review };
    assert.equal((await POST(request(body))).status, 400);
    caller = { ...pm, role: "DEVELOPER" };
    assert.equal((await POST(request({ ...body, action: "approve" }))).status, 403);
    caller = pm;
    const response = await POST(request({ ...body, action: "approve" }));
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.result.stories.length, 1);
    assert.equal(f.rows("epics").length, 1);
    assert.deepEqual(await f.service.savedResult(pm, thread), json.result);
    const repeat = await POST(request({ ...body, action: "approve" }));
    assert.deepEqual((await repeat.json()).result, json.result);
    assert.equal(f.rows("epics").length, 1);
  } finally {
    users.resolveCaller = originalCaller;
    services.getRequirementsReviewService = originalService;
  }
});

test("the review card displays the proposed fields and disables approval during revision", async () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { RequirementsReviewCard } = require("../app/components/requirements-review.tsx");
  const f = fixture();
  const review = await f.preview();
  const props = { review, active: true, busy: false, needsRefresh: false, onApprove() {}, onDiscard() {}, onEdit() {} };
  const html = renderToStaticMarkup(React.createElement(RequirementsReviewCard, props));
  for (const text of [review.featureTitle, review.draft.epic.title, review.draft.epic.description,
    review.draft.stories[0].userStory, review.draft.stories[0].acceptanceCriteria[0], "3 story points", "HIGH priority"]) {
    assert.ok(html.includes(text));
  }
  assert.match(html, /<button class="primary">Approve and save<\/button>/);
  const editing = renderToStaticMarkup(React.createElement(RequirementsReviewCard, { ...props, needsRefresh: true }));
  assert.match(editing, /<button class="primary" disabled="">Approve and save<\/button>/);
  const closed = renderToStaticMarkup(React.createElement(RequirementsReviewCard, { ...props, active: false }));
  assert.ok(!closed.includes("Approve and save"));
});

test("the provider-facing schema permits the reported read without reason", () => {
  const { makeDatabaseTool } = require("../src/agent/db-tool.ts");
  const { convertToOpenAITool } = require("@langchain/core/utils/function_calling");
  const tool = makeDatabaseTool("REQUIREMENTS", pm, []);
  const parameters = convertToOpenAITool(tool).function.parameters;
  assert.ok(parameters.required.includes("collection"));
  assert.ok(parameters.required.includes("operation"));
  assert.ok(!parameters.required.includes("reason"));
  assert.equal(parameters.properties.limit.maximum, undefined);
  assert.equal(parameters.properties.limit.type, "number");
  assert.equal(parameters.properties.offset.type, "number");
  assert.ok(!parameters.required.includes("offset"));
});

function addFeatures(f, count) {
  f.rows("feature_requests").splice(0);
  for (let index = count; index > 0; index--) {
    f.rows("feature_requests").push({
      _id: new ObjectId(index.toString(16).padStart(24, "0")),
      featureRequestKey: `FR-${index}`, title: `Feature ${index}`,
      description: "Detailed feature description", status: "NEW", priority: "HIGH",
    });
  }
}

test("the reported limit=100 call returns bounded pages without duplicates or missing records", async () => {
  const { makeDatabaseTool } = require("../src/agent/db-tool.ts");
  const database = require("../src/db/mongodb.ts");
  const originalDb = database.getDb;
  const f = fixture();
  addFeatures(f, 37);
  database.getDb = async () => f.db;
  const tool = makeDatabaseTool("REQUIREMENTS", pm, []);
  const input = {
    collection: "feature_requests", operation: "find", limit: 100,
    selectFieldsCsv: "_id,featureRequestKey,productId,requestedBy,title,description,source,sourceDetail,priority,status,submittedAt,createdAt,updatedAt",
  };
  try {
    const first = JSON.parse(await tool.invoke(input));
    assert.equal(first.ok, true, first.error);
    assert.equal(first.result.returned, 25);
    assert.equal(first.result.limit, 25);
    assert.equal(first.result.offset, 0);
    assert.equal(first.result.hasMore, true);
    assert.equal(first.result.nextOffset, 25);
    assert.equal(first.result.items[0].description, "Detailed feature description");
    const second = JSON.parse(await tool.invoke({ ...input, offset: first.result.nextOffset }));
    assert.equal(second.ok, true, second.error);
    assert.equal(second.result.returned, 12);
    assert.equal(second.result.offset, 25);
    assert.equal(second.result.hasMore, false);
    assert.equal(second.result.nextOffset, null);
    assert.deepEqual([...first.result.items, ...second.result.items].map((row) => row.featureRequestKey),
      Array.from({ length: 37 }, (_, i) => `FR-${i + 1}`));
    assert.deepEqual(f.queries.map((query) => query.limit), [26, 26]);
    assert.equal(f.rows("epics").length, 0);
    assert.equal(f.rows("user_stories").length, 0);
  } finally { database.getDb = originalDb; }
});

test("pagination honors filters, projections, smaller page sizes and tied sort values", async () => {
  const { executeDatabaseAction } = require("../src/services/database-action.service.ts");
  const database = require("../src/db/mongodb.ts");
  const originalDb = database.getDb;
  const f = fixture();
  addFeatures(f, 26);
  f.rows("feature_requests")[0].status = "REJECTED";
  database.getDb = async () => f.db;
  const action = {
    collection: "feature_requests", operation: "find", reason: "Read feature list",
    conditions: [{ field: "status", operator: "eq", stringValue: "NEW" }],
    sortField: "priority", sortDirection: "desc",
  };
  try {
    const defaultPage = (await executeDatabaseAction("REQUIREMENTS", pm, action)).result;
    assert.equal(defaultPage.returned, 10);
    assert.equal(defaultPage.nextOffset, 10);
    assert.equal(defaultPage.items[0].description, undefined);
    const smallerPage = (await executeDatabaseAction("REQUIREMENTS", pm, { ...action, offset: 10, limit: 5 })).result;
    assert.deepEqual(smallerPage.items.map((row) => row.featureRequestKey), ["FR-11", "FR-12", "FR-13", "FR-14", "FR-15"]);
    assert.equal(smallerPage.nextOffset, 15);
    const exactPage = (await executeDatabaseAction("REQUIREMENTS", pm, { ...action, limit: 25 })).result;
    assert.equal(exactPage.returned, 25);
    assert.equal(exactPage.hasMore, false);
    assert.equal(exactPage.nextOffset, null);
    const emptyPage = (await executeDatabaseAction("REQUIREMENTS", pm, { ...action, offset: 25 })).result;
    assert.equal(emptyPage.returned, 0);
    assert.equal(emptyPage.hasMore, false);
    assert.equal(emptyPage.nextOffset, null);
    assert.ok(f.queries.every((query) => query.sort.priority === -1 && query.sort._id === 1));
  } finally { database.getDb = originalDb; }
});

test("every page applies the caller's record scope before the offset", async () => {
  const { executeDatabaseAction } = require("../src/services/database-action.service.ts");
  const database = require("../src/db/mongodb.ts");
  const originalDb = database.getDb;
  const f = fixture();
  const developer = { ...pm, role: "DEVELOPER" };
  for (let index = 1; index <= 60; index++) f.rows("tasks").push({
    _id: new ObjectId(index.toString(16).padStart(24, "0")), taskKey: `TASK-${index}`,
    assigneeId: new ObjectId(index % 2 ? pm.mongoUserId : "cccccccccccccccccccccccc"),
  });
  database.getDb = async () => f.db;
  const action = { collection: "tasks", operation: "find", limit: 100, reason: "Read my tasks" };
  try {
    const first = (await executeDatabaseAction("SPRINT_TASK", developer, action)).result;
    const second = (await executeDatabaseAction("SPRINT_TASK", developer, { ...action, offset: first.nextOffset })).result;
    assert.equal(first.returned, 25);
    assert.equal(second.returned, 5);
    assert.equal(second.hasMore, false);
    const items = [...first.items, ...second.items];
    assert.ok(items.every((row) => String(row.assigneeId) === pm.mongoUserId));
    assert.equal(new Set(items.map((row) => row.taskKey)).size, 30);
  } finally { database.getDb = originalDb; }
});

test("backend rejects invalid pagination and preserves the bulk mutation cap", async () => {
  const { executeDatabaseAction } = require("../src/services/database-action.service.ts");
  const database = require("../src/db/mongodb.ts");
  const originalDb = database.getDb;
  const f = fixture();
  database.getDb = async () => f.db;
  const action = { collection: "feature_requests", operation: "find", reason: "Read features" };
  try {
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      await assert.rejects(executeDatabaseAction("REQUIREMENTS", pm, { ...action, limit }), /INVALID_LIMIT/);
    }
    for (const offset of [-1, 0.5, NaN, Infinity]) {
      await assert.rejects(executeDatabaseAction("REQUIREMENTS", pm, { ...action, offset }), /INVALID_OFFSET/);
    }
    await assert.rejects(executeDatabaseAction("REQUIREMENTS", pm, { ...action, offset: 10001 }), /OFFSET_EXCEEDED/);
    const update = {
      collection: "user_stories", operation: "update_many", reason: "Approve selected stories",
      conditions: [{ field: "status", operator: "eq", stringValue: "DRAFT" }],
      fields: [{ field: "status", stringValue: "APPROVED" }],
    };
    await assert.rejects(executeDatabaseAction("REQUIREMENTS", pm, { ...update, offset: 0 }), /OFFSET_ONLY_ALLOWED_FOR_FIND/);
    await assert.rejects(executeDatabaseAction("REQUIREMENTS", pm, { ...update, limit: 100 }), /LIMIT_EXCEEDED:25/);
    for (let index = 0; index < 21; index++) f.rows("user_stories").push({ _id: new ObjectId(), status: "DRAFT" });
    await assert.rejects(executeDatabaseAction("REQUIREMENTS", pm, update), /BULK_UPDATE_LIMIT:20/);
    assert.ok(f.rows("user_stories").every((row) => row.status === "DRAFT"));
  } finally { database.getDb = originalDb; }
});

test("pagination reports when the offset budget requires narrower filters", async () => {
  const { executeDatabaseAction } = require("../src/services/database-action.service.ts");
  const database = require("../src/db/mongodb.ts");
  const originalDb = database.getDb;
  const f = fixture();
  addFeatures(f, 10027);
  database.getDb = async () => f.db;
  try {
    const { result } = await executeDatabaseAction("REQUIREMENTS", pm, {
      collection: "feature_requests", operation: "find", offset: 10000, limit: 25, reason: "Read features",
    });
    assert.equal(result.returned, 25);
    assert.equal(result.hasMore, true);
    assert.equal(result.nextOffset, null);
    assert.match(result.paginationNote, /Narrow the filters/);
  } finally { database.getDb = originalDb; }
});

test("the exact FR-113 read succeeds without reason and keeps a supplied reason", async () => {
  const { makeDatabaseTool } = require("../src/agent/db-tool.ts");
  const database = require("../src/db/mongodb.ts");
  const originalDb = database.getDb;
  const f = fixture();
  database.getDb = async () => f.db;
  const traces = [];
  const tool = makeDatabaseTool("REQUIREMENTS", pm, traces);
  const input = {
    collection: "feature_requests",
    conditionsJson: JSON.stringify([{ field: "featureRequestKey", operator: "eq", stringValue: "FR-113" }]),
    operation: "find_one",
    selectFieldsCsv: "_id,featureRequestKey,title,description,priority,status",
  };
  try {
    const result = JSON.parse(await tool.invoke(input));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.featureRequestKey, "FR-113");
    assert.equal(traces[0].generatedAction.reason, "Read feature_requests using find_one.");
    await tool.invoke({ ...input, reason: "Read feature details for PM review" });
    assert.equal(traces[1].generatedAction.reason, "Read feature details for PM review");
    assert.equal(f.rows("epics").length, 0);
    assert.equal(f.rows("user_stories").length, 0);
  } finally { database.getDb = originalDb; }
});

test("feature lookups and linked epics accept stored feature-N keys without changing records", async () => {
  const { executeDatabaseAction } = require("../src/services/database-action.service.ts");
  const database = require("../src/db/mongodb.ts");
  const originalDb = database.getDb;
  const f = fixture();
  f.rows("feature_requests")[0].featureRequestKey = "feature-113";
  f.rows("feature_requests").push({ _id: new ObjectId(), featureRequestKey: "feature-1130" });
  f.rows("epics").push({ _id: new ObjectId(), featureRequestId: new ObjectId(featureId), epicKey: "EPIC-113" });
  database.getDb = async () => f.db;
  const read = (collection, field, value) => executeDatabaseAction("REQUIREMENTS", pm, {
    collection, operation: "find_one", conditions: [{ field, operator: "eq", stringValue: value }], reason: "Read feature",
  });
  try {
    for (const key of ["FR-113", "fr-113", "feature-113", "feature request 113", "FR 113"]) {
      for (const field of ["key", "featureRequestKey"]) {
        const result = await read("feature_requests", field, key);
        assert.equal(String(result.result._id), featureId);
        assert.equal(result.result.featureRequestKey, "feature-113");
      }
      assert.equal((await read("epics", "featureRequestKey", key)).result.epicKey, "EPIC-113");
    }
    assert.equal((await read("feature_requests", "key", "FR-999")).result, null);
    assert.equal((await read("feature_requests", "key", featureId)).result.featureRequestKey, "feature-113");
    f.rows("feature_requests").push({ _id: new ObjectId(), featureRequestKey: "FR-113" });
    assert.equal((await read("feature_requests", "key", "FR-113")).result.featureRequestKey, "FR-113");
    await assert.rejects(read("feature_requests", "key", "Feature request 113"), /AMBIGUOUS_FEATURE_KEY/);
    assert.equal(f.rows("feature_requests")[0].featureRequestKey, "feature-113");
  } finally { database.getDb = originalDb; }
});

test("empty feature reads return title matches for mistaken keys, spelling differences and partial names", async () => {
  const { executeDatabaseAction } = require("../src/services/database-action.service.ts");
  const database = require("../src/db/mongodb.ts");
  const originalDb = database.getDb;
  const f = fixture();
  f.rows("feature_requests").push(
    { _id: new ObjectId(), featureRequestKey: "FR-137", title: "Synthetic Feature Request 37" },
    { _id: new ObjectId(), featureRequestKey: "feature-313", title: "Platform sourcing assisstant" },
  );
  database.getDb = async () => f.db;
  const read = async (field, stringValue, operation = "find_one", caller = pm, extra = []) =>
    (await executeDatabaseAction("REQUIREMENTS", caller, {
      collection: "feature_requests", operation, conditions: [{ field, operator: "eq", stringValue }, ...extra],
      selectFields: ["_id"], reason: "Find feature ID by title",
    })).result;
  try {
    const exact = await read("key", "Synthetic Feature Request 37");
    assert.equal(exact.matchType, "exact_title");
    assert.equal(exact.matches[0].featureRequestKey, "FR-137");
    assert.equal(exact.requiresClarification, false);
    f.rows("feature_requests").push({ _id: new ObjectId(), featureRequestKey: "FR-850", title: "Invoice export dashboard" });
    const generic = await read("title", "invoice export workspace");
    assert.equal(generic.matches[0].featureRequestKey, "FR-850");
    assert.equal(generic.matchType, "partial_keywords");
    assert.equal(await read("title", "Synthetic Feature Request 38"), null, "numeric tokens must not be dropped");
    for (const title of ["platform sourcing agent", "Platform sourcing assistant", "platform sourcing"]) {
      for (const operation of ["find_one", "find"]) {
        const result = await read("title", title, operation);
        assert.equal(result.matches[0].featureRequestKey, "feature-313");
        assert.equal(result.matches[0].title, "Platform sourcing assisstant");
        assert.equal(result.requiresClarification, true);
      }
    }
    assert.equal(await read("title", ".*"), null, "regex syntax must remain literal");
    assert.equal(await read("key", "FR-999"), null, "missing identifiers must not trigger fuzzy title matching");
    assert.equal(await read("title", "platform sourcing agent", "find_one", { ...pm, role: "DEVELOPER" }), null,
      "suggestions must enforce record scope");
    assert.equal(await read("title", "platform sourcing agent", "find_one", pm,
      [{ field: "status", operator: "eq", stringValue: "APPROVED" }]), null, "never drop an extra filter");
    for (let i = 0; i < 6; i++) f.rows("feature_requests").push({ _id: new ObjectId(), title: `Platform sourcing option ${i}`, featureRequestKey: `FR-${400 + i}` });
    const ambiguous = await read("title", "platform sourcing agent");
    assert.equal(ambiguous.matches.length, 5);
    assert.equal(ambiguous.hasMore, true);
    assert.equal(ambiguous.requiresClarification, true);
    assert.equal(f.rows("feature_requests")[2].title, "Platform sourcing assisstant");
  } finally { database.getDb = originalDb; }
});

test("making reason optional at the provider boundary does not authorize mutations", async () => {
  const { makeDatabaseTool } = require("../src/agent/db-tool.ts");
  const database = require("../src/db/mongodb.ts");
  const originalDb = database.getDb;
  const f = fixture();
  database.getDb = async () => f.db;
  const tool = makeDatabaseTool("REQUIREMENTS", pm, []);
  try {
    const result = JSON.parse(await tool.invoke({
      collection: "feature_requests", operation: "update_one",
      conditionsJson: JSON.stringify([{ field: "featureRequestKey", operator: "eq", stringValue: "FR-113" }]),
      fieldsJson: JSON.stringify([{ field: "status", stringValue: "APPROVED" }]),
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, "MUTATION_REASON_REQUIRED");
    assert.equal(f.rows("feature_requests")[0].status, undefined);
    const direct = JSON.parse(await tool.invoke({
      collection: "epics", operation: "insert_one",
      fieldsJson: JSON.stringify([{ field: "title", stringValue: "Skip approval" }]),
    }));
    assert.equal(direct.ok, false);
    assert.match(direct.error, /PM_REVIEW_REQUIRED/);
    assert.equal(f.rows("epics").length, 0);
  } finally { database.getDb = originalDb; }
});

test("the agent reads FR-113 without reason, refuses a direct insert and stops at PM review", async () => {
  const { MemorySaver } = require("@langchain/langgraph");
  const { AIMessage } = require("@langchain/core/messages");
  const database = require("../src/db/mongodb.ts");
  const models = require("../src/agent/model.ts");
  const saverPath = require.resolve("@langchain/langgraph-checkpoint-mongodb");
  const originalSaver = require.cache[saverPath];
  const originalClient = database.getMongoClient;
  const originalDb = database.getDb;
  const originalModel = models.getModel;
  const f = fixture();
  const revision = await f.service.begin(pm, thread);
  let modelCalls = 0;
  class TestSaver extends MemorySaver { constructor() { super(); } async setup() { return []; } }
  require.cache[saverPath] = { id: saverPath, filename: saverPath, loaded: true, exports: { MongoDBSaver: TestSaver } };
  database.getMongoClient = async () => ({});
  database.getDb = async () => f.db;
  models.getModel = () => ({ bindTools: () => ({ invoke: async () => {
    modelCalls++;
    assert.ok(modelCalls <= 3, "a completed preview must not trigger another model call");
    const read = modelCalls === 1;
    const direct = modelCalls === 2;
    return new AIMessage({ content: "", tool_calls: [{
      id: `test_call_${modelCalls}`, type: "tool_call",
      name: read || direct ? "requirements_database_action" : "preview_requirements_draft",
      args: read ? {
        collection: "feature_requests", operation: "find_one",
        conditionsJson: JSON.stringify([{ field: "featureRequestKey", operator: "eq", stringValue: "FR-113" }]),
        selectFieldsCsv: "_id,featureRequestKey,title,description,priority,status",
      } : direct ? {
        collection: "epics", operation: "insert_one",
        fieldsJson: JSON.stringify([{ field: "title", stringValue: "Skip approval" }]),
      } : { draftJson: JSON.stringify(draft()) },
    }] });
  } }) });
  try {
    const { runSpecialistAgent } = require("../src/agent/specialist-agent.ts");
    const result = await runSpecialistAgent({
      agent: "REQUIREMENTS", caller: pm, threadId: thread, message: "For FR 113 create epics and user stories.",
      requirements: { service: f.service, revision },
    });
    assert.equal(modelCalls, 3);
    assert.equal(result.trace[0].guardrail, "ALLOWED", result.trace[0].result.error);
    assert.equal(result.trace[0].result.result.featureRequestKey, "FR-113");
    assert.equal(result.trace[1].guardrail, "REJECTED");
    assert.match(result.trace[1].result.error, /PM_REVIEW_REQUIRED/);
    assert.equal(result.requirementsReview.draft.epic.title, draft().epic.title);
    assert.match(result.response, /Approve and save/);
    assert.equal(f.rows("epics").length, 0);
    assert.equal(f.rows("user_stories").length, 0);
  } finally {
    if (originalSaver) require.cache[saverPath] = originalSaver;
    else delete require.cache[saverPath];
    database.getMongoClient = originalClient;
    database.getDb = originalDb;
    models.getModel = originalModel;
  }
});
