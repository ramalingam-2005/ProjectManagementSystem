// Explicit opt-in integration check against the configured database. No seeding,
// business writes or persisted audit writes: the audit sink is captured in memory.
const assert = require("node:assert/strict");
const { executeDatabaseAction } = require("../src/services/database-action.service.ts");
const { resolveCaller } = require("../src/repositories/user.repository.ts");
const { getMongoClient } = require("../src/db/mongodb.ts");
const audit = require("../src/services/database-audit.service.ts");
const originalAudit = audit.auditDatabaseAction;
const recorded = [];
audit.auditDatabaseAction = async (...args) => recorded.push(args);
const deadline = setTimeout(() => { console.error("INTEGRATION_TIMEOUT"); process.exit(1); }, 30_000);
let client;

(async () => {
  try {
    console.log("Connecting for read-only integration checks...");
    client = await getMongoClient();
    const caller = await resolveCaller(process.env.TEST_USER_ID || "u-pm-1");
    const cases = [
      ["REQUIREMENTS", { collection: "feature_requests", operation: "find", filter: { status: "APPROVED" }, limit: 2 }],
      ["BUG", { collection: "bugs", operation: "find", filter: { severity: "CRITICAL", status: { $ne: "VERIFIED_CLOSED" } }, limit: 2 }],
      ["SPRINT_TASK", { collection: "tasks", operation: "find", filter: { storyPoints: { $gt: 5 } }, limit: 2 }],
      ["RELEASE", { collection: "bugs", operation: "countDocuments", filter: { severity: "CRITICAL", status: { $ne: "VERIFIED_CLOSED" } } }],
      ["DOCUMENTATION", { collection: "documents", operation: "find", filter: {}, limit: 2, projection: { title: 1 } }],
      ["REQUIREMENTS", { collection: "feature_requests", operation: "aggregate", limit: 2, pipeline: [
        { $lookup: { from: "epics", localField: "_id", foreignField: "featureRequestId", as: "epics" } },
        { $unwind: { path: "$epics", preserveNullAndEmptyArrays: true } },
        { $lookup: { from: "user_stories", localField: "epics._id", foreignField: "epicId", as: "stories" } },
        { $project: { featureRequestKey: 1, "epics.epicKey": 1, "stories.storyKey": 1 } },
      ] }],
      ["REQUIREMENTS", { collection: "feature_requests", operation: "aggregate", limit: 2, pipeline: [
        { $lookup: { from: "epics", localField: "_id", foreignField: "featureRequestId", as: "epics", pipeline: [
          { $lookup: { from: "user_stories", localField: "_id", foreignField: "epicId", as: "stories" } },
        ] } },
      ] }],
      ["SPRINT_TASK", { collection: "tasks", operation: "aggregate", pipeline: [
        { $group: { _id: "$status", total: { $sum: 1 }, points: { $sum: "$storyPoints" } } }, { $sort: { total: -1 } },
      ] }],
    ];
    for (const [agent, action] of cases) {
      const output = await executeDatabaseAction(agent, caller, action);
      assert.equal(output.ok, true);
      if (output.result.items) assert.ok(output.result.items.length <= (action.limit ?? 25));
      console.log(`PASS ${agent} ${action.operation}`);
    }
    assert.equal(recorded.length, cases.length);
    console.log(`PASS ${cases.length} live read checks; audits captured in memory; no database writes`);
  } catch (error) {
    console.error(error instanceof Error ? error.message.split(":")[0] : "INTEGRATION_FAILED");
    process.exitCode = 1;
  } finally {
    audit.auditDatabaseAction = originalAudit;
    if (client) await client.close();
    clearTimeout(deadline);
  }
})();
