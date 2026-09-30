import { MongoClient, ObjectId } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "product_engineering";
if (!uri) throw new Error("MONGODB_URI is missing");

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);

async function upsertUser({ userKey, name, email, role, reportsToUserId = null, defaultCapacity = null }) {
  await db.collection("users").updateOne(
    { email },
    {
      $set: { userKey, name, email, role, reportsToUserId, defaultCapacity, active: true, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  return db.collection("users").findOne({ email });
}

const pm = await upsertUser({ userKey: "u-pm-1", name: "Priya Raman", email: "priya.pm@example.com", role: "PRODUCT_MANAGER" });
const el = await upsertUser({ userKey: "u-el-1", name: "Rahul Kumar", email: "rahul.el@example.com", role: "ENGINEERING_LEAD" });
const dev = await upsertUser({ userKey: "u-dev-1", name: "Aditya Rao", email: "aditya.dev@example.com", role: "DEVELOPER", reportsToUserId: el._id, defaultCapacity: 8 });
const qa = await upsertUser({ userKey: "u-qa-1", name: "Meena S", email: "meena.qa@example.com", role: "QA", reportsToUserId: el._id });

let product = await db.collection("products").findOne({ name: "Pepagora Seller App" });
if (!product) {
  const result = await db.collection("products").insertOne({
    name: "Pepagora Seller App",
    description: "Demo product for the guarded five-agent chatbot.",
    createdBy: pm._id,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  product = { _id: result.insertedId };
}

let fr = await db.collection("feature_requests").findOne({ featureRequestKey: "FR-101" });
if (!fr) {
  const result = await db.collection("feature_requests").insertOne({
    featureRequestKey: "FR-101",
    productId: product._id,
    requestedBy: pm._id,
    title: "Bulk CSV Product Upload",
    description: "Allow sellers to upload many products using CSV.",
    source: "PRODUCT",
    sourceDetail: "Demo request",
    priority: "HIGH",
    status: "APPROVED",
    submittedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  fr = { _id: result.insertedId };
}

let epic = await db.collection("epics").findOne({ epicKey: "EPIC-101" });
if (!epic) {
  const result = await db.collection("epics").insertOne({
    epicKey: "EPIC-101",
    featureRequestId: fr._id,
    title: "Bulk Catalogue Management",
    description: "CSV upload and validation engineering work.",
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  epic = { _id: result.insertedId };
}

let story = await db.collection("user_stories").findOne({ storyKey: "US-101" });
if (!story) {
  const result = await db.collection("user_stories").insertOne({
    storyKey: "US-101",
    epicId: epic._id,
    title: "Upload CSV File",
    userStory: "As a seller, I want to upload a CSV so that I can add many products at once.",
    acceptanceCriteria: ["CSV only", "File size validated", "Upload result is visible"],
    storyPoints: 5,
    priority: "HIGH",
    status: "APPROVED",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  story = { _id: result.insertedId };
}

let sprint = await db.collection("sprints").findOne({ sprintNumber: 14 });
if (!sprint) {
  const result = await db.collection("sprints").insertOne({
    sprintNumber: 14,
    name: "Sprint 14",
    status: "ACTIVE",
    startDate: new Date(),
    endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    capacities: [{ developerId: dev._id, capacity: 8 }],
    createdAt: new Date(),
  });
  sprint = { _id: result.insertedId };
}

await db.collection("tasks").updateOne(
  { taskKey: "TASK-101" },
  {
    $set: {
      taskKey: "TASK-101",
      storyId: story._id,
      sprintId: sprint._id,
      assigneeId: dev._id,
      createdBy: el._id,
      releaseVersion: "v2.4",
      type: "DEVELOPMENT",
      title: "Build CSV upload API",
      description: "Create the CSV upload endpoint.",
      storyPoints: 5,
      priority: "HIGH",
      status: "IN_PROGRESS",
      blocker: { blocked: false, reason: null, blockedAt: null },
      dependencies: [],
      updatedAt: new Date(),
    },
    $setOnInsert: { createdAt: new Date() },
  },
  { upsert: true },
);

await db.collection("bugs").updateOne(
  { bugKey: "BUG-118" },
  {
    $set: {
      bugKey: "BUG-118",
      productId: product._id,
      reportedBy: qa._id,
      assigneeId: dev._id,
      affectedReleaseVersion: "v2.4",
      title: "Empty CSV causes application crash",
      description: "Uploading an empty CSV crashes parsing.",
      severity: "CRITICAL",
      status: "ASSIGNED",
      updatedAt: new Date(),
    },
    $setOnInsert: { createdAt: new Date() },
  },
  { upsert: true },
);

await db.collection("releases").updateOne(
  { version: "v2.4" },
  {
    $set: {
      productId: product._id,
      version: "v2.4",
      status: "TESTING",
      signoffs: {
        pm: { approved: false, approvedBy: null, approvedAt: null },
        qa: { approved: false, approvedBy: null, approvedAt: null },
      },
      updatedAt: new Date(),
    },
    $setOnInsert: { createdAt: new Date(), scope: { taskIds: [], testCaseIds: [] }, deployments: [] },
  },
  { upsert: true },
);

await db.collection("documents").updateOne(
  { title: "Definition of Done" },
  {
    $set: {
      ownerId: pm._id,
      title: "Definition of Done",
      type: "PROCESS",
      version: "1.0",
      content: "Required tests must pass before work is complete.",
      status: "APPROVED",
      metadata: { tags: ["process", "done"] },
      updatedAt: new Date(),
    },
    $setOnInsert: { createdAt: new Date() },
  },
  { upsert: true },
);

console.log(`Demo data is ready in database: ${dbName}`);
console.log("Users:");
console.log("  priya.pm@example.com  PRODUCT_MANAGER");
console.log("  rahul.el@example.com  ENGINEERING_LEAD");
console.log("  aditya.dev@example.com DEVELOPER");
console.log("  meena.qa@example.com   QA");

await client.close();
