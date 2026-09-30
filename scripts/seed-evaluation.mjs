import { MongoClient, ObjectId } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "product_engineering";
if (!uri) throw new Error("MONGODB_URI is required");

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);

const collections = [
  "users", "products", "feature_requests", "epics", "user_stories", "sprints", "tasks",
  "test_cases", "bugs", "releases", "documents", "document_chunks", "audit_logs", "notifications",
  "chat_sessions", "checkpoints", "checkpoint_writes",
];
for (const name of collections) await db.collection(name).deleteMany({});

const now = new Date("2026-09-28T06:00:00.000Z");
const daysAgo = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
const oid = () => new ObjectId();

// -------------------- USERS --------------------
const admin = { _id: oid(), userKey: "u-admin-1", name: "Admin User", email: "admin@example.local", role: "ADMIN", active: true };
const pms = [
  { _id: oid(), userKey: "u-pm-1", name: "Priya Nair", email: "priya.pm@example.local", role: "PM", active: true },
  { _id: oid(), userKey: "u-pm-2", name: "Meera Shah", email: "meera.pm@example.local", role: "PM", active: true },
  { _id: oid(), userKey: "u-pm-3", name: "Kavin Raj", email: "kavin.pm@example.local", role: "PM", active: true },
];
const els = [
  { _id: oid(), userKey: "u-el-1", name: "Arjun Menon", email: "arjun.el@example.local", role: "EL", active: true },
  { _id: oid(), userKey: "u-el-2", name: "Divya Rao", email: "divya.el@example.local", role: "EL", active: true },
];
const devNames = ["Aditya Rao", "Rahul Kumar", "Nisha Patel", "Vikram Sen", "Asha Iyer", "Manoj Das", "Sara Ali", "Kiran Bose", "Deepa Nair", "Rohit Jain"];
const devs = devNames.map((name, i) => ({
  _id: oid(), userKey: `u-dev-${i + 1}`, name, email: `dev${i + 1}@example.local`, role: "DEVELOPER",
  reportsToUserId: i < 5 ? els[0]._id : els[1]._id, defaultCapacity: 8, active: true,
}));
const qas = Array.from({ length: 5 }, (_, i) => ({
  _id: oid(), userKey: `u-qa-${i + 1}`, name: ["Meena QA", "Farah QA", "John QA", "Keerthi QA", "Vijay QA"][i],
  email: `qa${i + 1}@example.local`, role: "QA", active: true,
}));
await db.collection("users").insertMany([admin, ...pms, ...els, ...devs, ...qas].map(u => ({ ...u, createdAt: now, updatedAt: now })));

// -------------------- PRODUCTS --------------------
const productNames = ["Pepagora Marketplace Web", "Pepagora Seller App", "Pepagora Buyer App"];
const products = productNames.map((name, i) => ({
  _id: oid(), productKey: `PROD-${101 + i}`, name,
  description: `${name} synthetic product for the internship prototype.`,
  activeFeatures: Array.from({ length: 8 }, (_, j) => `Feature ${j + 1}`), active: true,
  createdAt: now, updatedAt: now,
}));
await db.collection("products").insertMany(products);

// -------------------- FEATURE REQUESTS (40; exactly 6 overdue UNDER_REVIEW) --------------------
const frs = [];
frs.push({
  _id: oid(), featureRequestKey: "FR-101", productId: products[1]._id, requestedBy: pms[0]._id,
  title: "Bulk CSV upload for listings", description: "Sellers want bulk CSV upload for listings.", source: "PRODUCT",
  sourceDetail: "PM request", priority: "HIGH", status: "UNDER_REVIEW", submittedAt: daysAgo(12), createdAt: daysAgo(12), updatedAt: now,
});
for (let i = 2; i <= 40; i++) {
  const overdue = i <= 6; // plus FR-101 = exactly six overdue
  const status = overdue ? "UNDER_REVIEW" : ["NEW", "APPROVED", "REJECTED", "DEFERRED", "STORIES_DRAFTED"][i % 5];
  frs.push({
    _id: oid(), featureRequestKey: `FR-${100 + i}`, productId: products[i % 3]._id, requestedBy: pms[i % 3]._id,
    title: i === 7 ? "Advanced Product Search" : `Synthetic Feature Request ${i}`,
    description: i === 7 ? "Improve product discovery with keyword and semantic search." : `Synthetic requirement ${i}.`,
    source: ["PRODUCT", "ENGINEERING", "QA"][i % 3], sourceDetail: "Synthetic seed", priority: ["LOW", "MEDIUM", "HIGH"][i % 3],
    status, submittedAt: overdue ? daysAgo(10 + i) : daysAgo(i % 6), createdAt: overdue ? daysAgo(10 + i) : daysAgo(i % 6), updatedAt: now,
  });
}
await db.collection("feature_requests").insertMany(frs);

// -------------------- EPICS / STORIES --------------------
const sellerEpic = { _id: oid(), epicKey: "EPIC-101", featureRequestId: frs[0]._id, title: "Seller Onboarding Revamp", description: "Seller onboarding and bulk listing workflow.", generatedByAI: true, status: "ACTIVE", createdAt: now, updatedAt: now };
const extraEpics = Array.from({ length: 5 }, (_, i) => ({
  _id: oid(), epicKey: `EPIC-${102 + i}`, featureRequestId: frs[6 + i]._id, title: `Engineering Epic ${i + 1}`,
  description: `Synthetic engineering epic ${i + 1}.`, generatedByAI: true, status: "ACTIVE", createdAt: now, updatedAt: now,
}));
await db.collection("epics").insertMany([sellerEpic, ...extraEpics]);

const stories = [];
for (let i = 0; i < 18; i++) {
  stories.push({
    _id: oid(), storyKey: `US-${101 + i}`, epicId: sellerEpic._id, title: `Seller onboarding story ${i + 1}`,
    userStory: `As a seller, I want onboarding capability ${i + 1} so that I can complete setup efficiently.`,
    acceptanceCriteria: [`Criterion A for story ${i + 1}`, `Criterion B for story ${i + 1}`], storyPoints: [2, 3, 5][i % 3],
    priority: i < 5 ? "HIGH" : "MEDIUM", status: "APPROVED", approval: { approvedBy: pms[0]._id, approvedAt: now }, createdAt: now, updatedAt: now,
  });
}
for (let e = 0; e < extraEpics.length; e++) {
  for (let j = 0; j < 10; j++) {
    stories.push({
      _id: oid(), storyKey: `US-${200 + e * 10 + j}`, epicId: extraEpics[e]._id, title: `Epic ${e + 1} story ${j + 1}`,
      userStory: `As a user, I want capability ${e + 1}.${j + 1} so that the product improves.`,
      acceptanceCriteria: ["Works as specified", "Validation is present"], storyPoints: [2, 3, 5][j % 3], priority: "MEDIUM",
      status: "APPROVED", approval: { approvedBy: pms[e % pms.length]._id, approvedAt: now }, createdAt: now, updatedAt: now,
    });
  }
}
// explicit unapproved story for negative test T7
stories.push({
  _id: oid(), storyKey: "US-DRAFT-1", epicId: extraEpics[0]._id, title: "Unapproved draft story",
  userStory: "As a user, I want a draft capability so that approval can be tested.", acceptanceCriteria: ["Draft only"],
  storyPoints: 3, priority: "LOW", status: "DRAFT", approval: { approvedBy: null, approvedAt: null }, createdAt: now, updatedAt: now,
});
await db.collection("user_stories").insertMany(stories);

// -------------------- SPRINTS --------------------
const closedSprints = [8, 9, 10, 11, 12, 13].map((num, i) => ({
  _id: oid(), sprintNumber: num, name: `Sprint ${num}`, status: "CLOSED", startDate: daysAgo(98 - i * 14), endDate: daysAgo(84 - i * 14),
  velocity: 30 + i * 2, capacities: devs.map(d => ({ developerId: d._id, capacity: 8 })), createdAt: now,
}));
const sprint14 = {
  _id: oid(), sprintNumber: 14, name: "Sprint 14", status: "ACTIVE", startDate: new Date("2026-09-21T00:00:00.000Z"), endDate: new Date("2026-10-04T23:59:59.000Z"),
  velocity: null, capacities: devs.map(d => ({ developerId: d._id, capacity: 8 })), createdAt: now,
};
await db.collection("sprints").insertMany([...closedSprints, sprint14]);

// -------------------- TASKS --------------------
const tasks = [];
const sellerStatuses = [...Array(12).fill("DONE"), ...Array(4).fill("IN_PROGRESS"), ...Array(2).fill("BLOCKED")];
for (let i = 0; i < 18; i++) {
  let assignee = devs[(i + 2) % devs.length];
  let points = [2, 3, 5][i % 3];
  let status = sellerStatuses[i];
  // Aditya has exactly 14 active points in Sprint 14: 5 + 5 + 4.
  if (i === 12) { assignee = devs[0]; points = 5; status = "IN_PROGRESS"; }
  if (i === 13) { assignee = devs[0]; points = 5; status = "IN_PROGRESS"; }
  if (i === 14) { assignee = devs[0]; points = 4; status = "IN_PROGRESS"; }
  tasks.push({
    _id: oid(), taskKey: `TASK-${101 + i}`, storyId: stories[i]._id, sprintId: sprint14._id, assigneeId: assignee._id, createdBy: els[0]._id,
    type: "DEVELOPMENT", title: `Seller onboarding task ${i + 1}`, description: `Implementation task ${i + 1}`,
    storyPoints: points, priority: i >= 12 && i <= 14 ? ["HIGH", "MEDIUM", "LOW"][i - 12] : "MEDIUM", status,
    blocker: { blocked: status === "BLOCKED", reason: status === "BLOCKED" ? `Dependency blocker ${i + 1}` : null, blockedAt: status === "BLOCKED" ? now : null },
    dependencies: [], releaseVersion: i < 10 ? "v2.4" : null, createdAt: now, updatedAt: now,
  });
}
for (let e = 0; e < extraEpics.length; e++) {
  for (let j = 0; j < 10; j++) {
    const story = stories[18 + e * 10 + j];
    tasks.push({
      _id: oid(), taskKey: `TASK-${200 + e * 10 + j}`, storyId: story._id, sprintId: sprint14._id, assigneeId: devs[(e + j + 1) % devs.length]._id,
      createdBy: els[e < 3 ? 0 : 1]._id, type: "DEVELOPMENT", title: `Epic ${e + 1} task ${j + 1}`, description: "Synthetic task",
      storyPoints: j % 3 === 0 ? 2 : 1, priority: "LOW", status: j < 7 ? "DONE" : "TODO", blocker: { blocked: false, reason: null, blockedAt: null },
      dependencies: [], releaseVersion: null, createdAt: now, updatedAt: now,
    });
  }
}
await db.collection("tasks").insertMany(tasks);

// -------------------- TEST CASES (150; v2.4 exactly 40 = 36 pass / 4 fail) --------------------
const testCases = [];
const v24TestIds = [];
for (let i = 1; i <= 150; i++) {
  const id = oid();
  const inV24 = i <= 40;
  const result = inV24 ? (i <= 36 ? "PASS" : "FAIL") : (i % 5 === 0 ? "FAIL" : "PASS");
  if (inV24) v24TestIds.push(id);
  testCases.push({
    _id: id, testCaseKey: `TC-${100 + i}`, productId: products[i % 3]._id, title: `Synthetic test case ${i}`, module: i <= 40 ? "Checkout" : `Module ${i % 8}`,
    active: true, targetVersions: inV24 ? ["v2.4"] : ["v2.3"],
    executions: [{ attempt: 1, releaseVersion: inV24 ? "v2.4" : "v2.3", result, testedBy: qas[i % qas.length]._id, linkedBugId: null, executedAt: now }],
    createdAt: now, updatedAt: now,
  });
}
await db.collection("test_cases").insertMany(testCases);

// -------------------- BUGS (60; exact critical/high counts; >=10 duplicates) --------------------
const bugs = [];
for (let n = 101; n <= 160; n++) {
  const index = n - 101;
  let severity = "MEDIUM";
  let status = index % 3 === 0 ? "ASSIGNED" : "VERIFIED_CLOSED";
  if ([118, 121, 127, 133, 141].includes(n)) severity = "CRITICAL";
  if ([118, 121, 127].includes(n)) status = "ASSIGNED";
  if ([133, 141].includes(n)) status = "VERIFIED_CLOSED";
  if (n >= 142 && n <= 153) severity = "HIGH"; // exactly 12 High
  const isDuplicate = n >= 151 && n <= 160;
  bugs.push({
    _id: oid(), bugKey: `BUG-${n}`, productId: products[0]._id, sourceTestCaseId: testCases[index % testCases.length]._id,
    reportedBy: qas[index % qas.length]._id, assigneeId: devs[index % devs.length]._id,
    affectedReleaseVersion: n === 118 || (n >= 142 && n <= 145) ? "v2.4" : "v2.3",
    title: n === 118 ? "Checkout crash" : n === 110 ? "Checkout button unresponsive on Safari mobile" : `Synthetic bug ${n}`,
    description: n === 118 ? "Checkout crashes during payment confirmation." : n === 110 ? "Checkout button does not respond on mobile Safari." : `Synthetic bug description ${n}`,
    component: n === 118 || n === 110 ? "Checkout" : `Component ${index % 7}`,
    stepsToReproduce: ["Open affected module", "Perform action", "Observe issue"], logs: `Synthetic log ${n}`,
    severity, status, duplicateOfBugId: isDuplicate ? bugs[0]?._id ?? null : null,
    fixDetails: { fixSummary: status === "VERIFIED_CLOSED" ? "Synthetic fix" : null, fixedBy: null, fixReadyAt: null },
    qaVerification: { result: status === "VERIFIED_CLOSED" ? "PASS" : null, verifiedBy: status === "VERIFIED_CLOSED" ? qas[0]._id : null, verifiedAt: status === "VERIFIED_CLOSED" ? now : null },
    createdAt: now, updatedAt: now,
  });
}
await db.collection("bugs").insertMany(bugs);

// Link four failed v2.4 tests to synthetic bugs, including BUG-118.
const bug118 = bugs.find(b => b.bugKey === "BUG-118");
for (let i = 36; i < 40; i++) {
  await db.collection("test_cases").updateOne({ _id: testCases[i]._id }, { $set: { "executions.0.linkedBugId": i === 36 ? bug118._id : bugs[i]._id } });
}

// -------------------- RELEASES --------------------
const v24TaskIds = tasks.slice(0, 10).map(t => t._id);
await db.collection("releases").insertMany([
  {
    _id: oid(), productId: products[0]._id, version: "v2.4", status: "TESTING",
    scope: { taskIds: v24TaskIds, testCaseIds: v24TestIds },
    signoffs: { pm: { approved: false, approvedBy: null, approvedAt: null }, qa: { approved: false, approvedBy: null, approvedAt: null } },
    releaseNotes: { status: "DRAFT", content: "Synthetic draft release notes for v2.4." },
    documentation: { apiDocsUpdated: true },
    evaluationFixture: { blockedScore: 42, clearedScore: 87 },
    deployments: [], createdAt: now, updatedAt: now,
  },
  {
    _id: oid(), productId: products[0]._id, version: "v2.3", status: "RELEASED",
    scope: { taskIds: tasks.slice(10, 20).map(t => t._id), testCaseIds: testCases.slice(40, 80).map(t => t._id) },
    signoffs: { pm: { approved: true, approvedBy: pms[0]._id, approvedAt: daysAgo(20) }, qa: { approved: true, approvedBy: qas[0]._id, approvedAt: daysAgo(20) } },
    releaseNotes: { status: "PUBLISHED", content: "v2.3 released successfully." }, documentation: { apiDocsUpdated: true },
    deployments: [{ environment: "production", version: "v2.3", timestamp: daysAgo(19), status: "SUCCESS" }], createdAt: daysAgo(22), updatedAt: daysAgo(19),
  },
]);

// -------------------- DOCUMENTATION (10 docs, 300+ words each, deliberate gaps preserved) --------------------
function longDoc(title, type, core) {
  const sections = [
    `# ${title}\n\n## Purpose\n${core}`,
    `## Scope\nThis synthetic document describes the approved internal process for the prototype. It is intentionally grounded in the product engineering workflow and is written for demonstration and retrieval testing. The content explains responsibilities, boundaries, expected records, audit behaviour, and the relationship between screens, chat, services, and stored data.`,
    `## Procedure\nTeams should use the application service path for both UI actions and chat actions. Identity is provided by the server. Every mutation must pass permission checks, record-scope checks, business rules, and audit logging. Human approvals remain human decisions even when an AI agent drafts or explains information.`,
    `## Verification\nA user should verify the relevant record after an action. Developers verify only their own work, QA verifies test and bug outcomes, Product Managers verify requirement scope, and Engineering Leads verify sprint and release engineering state. The audit log is the system evidence for who performed each operation.`,
    `## Notes\nThis document is synthetic and contains no real customer or production information. It exists to make documentation retrieval deterministic for the evaluation suite. The assistant should cite this document when answering questions covered here and should say Not documented when a requested process is intentionally absent.`,
  ];
  let text = sections.join("\n\n");
  while (text.split(/\s+/).length < 320) text += `\n\nAdditional guidance: ${core} The same controlled workflow and audit principles apply consistently across the prototype.`;
  return { _id: oid(), title, type, version: "1.0", content: text, status: "active", ownerId: els[0]._id, metadata: { tags: [type, "synthetic"] }, createdAt: now, updatedAt: now };
}
const docs = [
  longDoc("Definition of Done", "process", "A task is done when implementation, review, testing, and required documentation are complete and no known critical blocker remains for that work."),
  longDoc("Definition of Ready", "process", "A story is ready when its intent, acceptance criteria, dependencies, and estimate are clear enough for engineering planning."),
  longDoc("Release Checklist", "process", "Release preparation checks scope completion, test results, bugs, documentation, and both PM and QA sign-offs."),
  longDoc("New Developer Onboarding", "process", "New developers learn the product, repository conventions, task workflow, testing expectations, and documentation practices."),
  longDoc("Architecture Overview", "technical", "The system uses a frontend, backend APIs, MongoDB data, a guarded AI tool layer, and shared application services."),
  longDoc("Core API Reference", "API", "The prototype exposes authenticated endpoints for feature requests, stories, tasks, sprints, bugs, tests, releases, documentation, audit, and assistant messages."),
  longDoc("Database Entity Overview", "technical", "Core entities include products, feature requests, epics, user stories, sprints, tasks, test cases, bugs, releases, documents, users, and audit records."),
  longDoc("Product Modules", "product", "The product engineering system supports requirements, engineering execution, QA, release management, documentation, and grounded chat assistance."),
  longDoc("Bug Verification Process", "process", "QA verifies bugs marked FIX_READY. A passing retest closes the bug; a failed retest reopens it and returns it to assigned work."),
  longDoc("Sprint Planning Guide", "technical", "Engineering Leads plan fixed two-week sprints, assign tasks, inspect capacity, and rebalance work when assigned points exceed a developer's capacity."),
];
await db.collection("documents").insertMany(docs);

// -------------------- INDEXES --------------------
await db.collection("users").createIndex({ userKey: 1 }, { unique: true });
await db.collection("users").createIndex({ email: 1 }, { unique: true });
await db.collection("feature_requests").createIndex({ featureRequestKey: 1 }, { unique: true });
await db.collection("epics").createIndex({ epicKey: 1 }, { unique: true });
await db.collection("user_stories").createIndex({ storyKey: 1 }, { unique: true });
await db.collection("tasks").createIndex({ taskKey: 1 }, { unique: true });
await db.collection("bugs").createIndex({ bugKey: 1 }, { unique: true });
await db.collection("test_cases").createIndex({ testCaseKey: 1 }, { unique: true });
await db.collection("releases").createIndex({ version: 1 }, { unique: true });
await db.collection("tasks").createIndex({ sprintId: 1, assigneeId: 1 });
await db.collection("bugs").createIndex({ affectedReleaseVersion: 1, severity: 1, status: 1 });

console.log(`Seeded ${dbName}`);
console.log({
  users: await db.collection("users").countDocuments(),
  products: await db.collection("products").countDocuments(),
  feature_requests: await db.collection("feature_requests").countDocuments(),
  epics: await db.collection("epics").countDocuments(),
  user_stories: await db.collection("user_stories").countDocuments(),
  sprints: await db.collection("sprints").countDocuments(),
  tasks: await db.collection("tasks").countDocuments(),
  test_cases: await db.collection("test_cases").countDocuments(),
  bugs: await db.collection("bugs").countDocuments(),
  releases: await db.collection("releases").countDocuments(),
  documents: await db.collection("documents").countDocuments(),
});
console.log("Demo users: u-pm-1, u-el-1, u-dev-1 (Aditya Rao), u-dev-2 (Rahul Kumar), u-qa-1");
console.log("Sprint 14: Aditya Rao capacity=8; active assigned points=14.");
console.log("Feature requests: exactly 6 UNDER_REVIEW older than 7 days.");
console.log("Release v2.4: 40 tests (36 PASS, 4 FAIL), BUG-118 is open CRITICAL.");

await client.close();
