import { ObjectId, type Document, type Filter } from "mongodb";
import { getDb } from "@/src/db/mongodb";
import { normalizeRole } from "@/src/repositories/user.repository";
import { buildScopeFilter } from "@/src/services/scope.service";
import { MONGO_LIMITS } from "@/src/security/mongo-policy";
import { BugWorkflowError } from "@/src/utils/business-action-errors";
import { prepareQaBugTestLink } from "@/src/services/bug-test-link.service";
import type { Caller, FieldChange } from "@/src/types";

const options = { maxTimeMS: MONGO_LIMITS.maxTimeMS };
const severities = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const fail = (code: string, message: string): never => { throw new BugWorkflowError(code, message); };

function fieldsObject(fields: FieldChange[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of fields) {
    const values = [entry.stringValue, entry.numberValue, entry.booleanValue, entry.stringListValue].filter((v) => v !== undefined);
    if (values.length !== 1 || Object.hasOwn(result, entry.field)) fail("BUG_INVALID_FIELDS", "The bug action contains conflicting fields. No bug was changed.");
    result[entry.field] = values[0];
  }
  for (const [a, b] of [["assignee", "assigneeId"], ["sourceTestCase", "sourceTestCaseId"]]) {
    if (a in result && b in result) fail("BUG_CONFLICTING_IDENTITY", "Specify one reference for each assignee or test case.");
  }
  return result;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail("BUG_DETAILS_REQUIRED", `What ${label} should I use for this bug?`);
  return (value as string).trim();
}

async function resolveDeveloper(value: unknown): Promise<Document> {
  const identity = text(value, "developer");
  const literal = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter: Filter<Document> = ObjectId.isValid(identity) ? { _id: new ObjectId(identity) } : {
    $or: ["userKey", "email", "username", "name", "fullName"].map((field) => ({ [field]: { $regex: `^${literal}$`, $options: "i" } })),
  };
  // Any Engineering Lead can assign any active developer in the shared backlog.
  // Detect ambiguous names rather than choosing the first match; DEV aliases work.
  const candidates = await (await getDb()).collection("users").find({
    $and: [filter, { active: { $ne: false } }],
  }, { ...options, projection: { _id: 1, name: 1, role: 1, roleName: 1 } }).limit(100).toArray();
  const matches = candidates.filter((user) => normalizeRole(user.role ?? user.roleName) === "DEVELOPER");
  if (candidates.length === 100 || matches.length > 1) fail("BUG_PERSON_AMBIGUOUS", "More than one person matches. Please provide their email or user key.");
  if (matches.length !== 1) fail("BUG_PERSON_NOT_AVAILABLE", "Choose an existing active developer. No bug was assigned.");
  return matches[0];
}

async function reportFields(fields: Record<string, unknown>, caller: Caller): Promise<Record<string, unknown>> {
  const set: Record<string, unknown> = {};
  for (const name of ["title", "description", "component", "affectedReleaseVersion"]) {
    if (name in fields) set[name] = text(fields[name], name === "affectedReleaseVersion" ? "affected release version" : name);
  }
  if ("logs" in fields) {
    if (typeof fields.logs !== "string") fail("BUG_INVALID_LOGS", "Bug logs must be text.");
    set.logs = fields.logs;
  }
  if ("severity" in fields) {
    if (!severities.has(String(fields.severity))) fail("BUG_INVALID_SEVERITY", "Choose a bug severity: LOW, MEDIUM, HIGH or CRITICAL.");
    set.severity = fields.severity;
  }
  if ("stepsToReproduce" in fields) {
    if (!Array.isArray(fields.stepsToReproduce) || fields.stepsToReproduce.some((step) => typeof step !== "string" || !step.trim())) fail("BUG_INVALID_STEPS", "Provide the reproduction steps as a list of non-empty instructions.");
    set.stepsToReproduce = fields.stepsToReproduce;
  }
  const db = await getDb();
  for (const field of ["productId", "sourceTestCaseId"]) {
    if (!(field in fields)) continue;
    if (typeof fields[field] !== "string" || !ObjectId.isValid(fields[field] as string)) fail("BUG_INVALID_REFERENCE", "Select an existing product or test case for this bug.");
    const id = new ObjectId(fields[field] as string);
    const collection = field === "productId" ? "products" : "test_cases";
    const scope = collection === "test_cases" ? await buildScopeFilter(collection, caller.role === "DEVELOPER" ? "ASSIGNED" : "ALL", caller) : { active: { $ne: false } };
    const record = await db.collection(collection).findOne({ $and: [{ _id: id }, scope] }, { ...options, projection: { _id: 1, productId: 1 } });
    if (!record) fail("BUG_REFERENCE_NOT_FOUND", "The selected product or test case was not found within your access.");
    set[field] = id;
    if (field === "sourceTestCaseId" && record?.productId instanceof ObjectId) {
      if (set.productId && String(set.productId) !== String(record.productId)) fail("BUG_PRODUCT_MISMATCH", "The selected test case belongs to a different product.");
      set.productId ??= record.productId;
    }
  }
  return set;
}

export async function prepareBugInsert(changes: FieldChange[] | undefined, caller: Caller) {
  const fields = fieldsObject(changes);
  if ("assignee" in fields || "assigneeId" in fields || "fixSummary" in fields || "qaVerificationResult" in fields) fail("BUG_NEW_REPORT_ONLY", "New bugs must be unassigned and unfixed. The Engineering Lead assigns a developer after reporting.");
  if (fields.status !== undefined && fields.status !== "NEW") fail("BUG_INITIAL_STATUS", "New bugs start as NEW and await Engineering Lead assignment.");
  text(fields.title, "title");
  const testLink = caller.role === "QA" ? await prepareQaBugTestLink(fields) : undefined;
  if (fields.severity === undefined) fail("BUG_SEVERITY_REQUIRED", "What is the impact of this bug, and should its severity be LOW, MEDIUM, HIGH or CRITICAL?");
  const details = await reportFields(testLink ? { ...fields, sourceTestCaseId: String(testLink.testCaseId), productId: String(testLink.productId), affectedReleaseVersion: testLink.releaseVersion } : fields, caller);
  return { document: { stepsToReproduce: [], ...details, assigneeId: null, status: "NEW",
    ...(testLink ? { sourceTestExecutionAttempt: testLink.attempt } : {}) }, testLink };
}

export async function prepareBugUpdate(changes: FieldChange[] | undefined, caller: Caller, scopeFilter: Filter<Document>) {
  const fields = fieldsObject(changes);
  const db = await getDb();
  const matches = await db.collection("bugs").find(scopeFilter, options).limit(2).toArray();
  if (matches.length !== 1) fail("BUG_SELECTION_REQUIRED", matches.length ? "More than one bug matches. Please specify its bug key." : "That bug was not found within your access. No bug was changed.");
  const bug = matches[0];
  // Source links cannot be edited as a one-sided generic update. A linked
  // report's product/release must continue to identify the recorded execution.
  if (["sourceTestCase", "sourceTestCaseId", "testExecutionAttempt"].some((key) => key in fields)
    || (bug.sourceTestExecutionAttempt !== undefined && ["productId", "affectedReleaseVersion"].some((key) => key in fields))) {
    fail("BUG_TEST_LINK_MANAGED", "The test-case execution link and its product/release are managed together during bug creation. They cannot be changed with a generic bug update.");
  }
  const set: Record<string, unknown> = {};
  const hasAssignee = "assignee" in fields || "assigneeId" in fields;
  if (caller.role === "ENGINEERING_LEAD") {
    if ("severity" in fields) Object.assign(set, await reportFields({ severity: fields.severity }, caller));
    if (hasAssignee) {
      if (!["NEW", "ASSIGNED", "REOPENED"].includes(String(bug.status))) fail("BUG_ASSIGNMENT_STATE", "Assign bugs that are NEW, ASSIGNED or REOPENED. QA must finish verification before a fixed or closed bug can be reassigned.");
      set.assigneeId = (await resolveDeveloper(fields.assignee ?? fields.assigneeId))._id;
      set.status = "ASSIGNED";
    }
    if (fields.status !== undefined && fields.status !== set.status) fail("BUG_LEAD_STATUS", "Assign a developer to set ASSIGNED. Fix-ready and verification transitions belong to Developer and QA.");
  } else if (caller.role === "DEVELOPER") {
    if (Object.keys(fields).some((key) => !["fixSummary", "status"].includes(key))) fail("BUG_DEVELOPER_FIX_ONLY", "Developers can submit a fix summary for their assigned bug. QA maintains the report and the Engineering Lead manages assignment.");
    if (!["NEW", "ASSIGNED", "REOPENED"].includes(String(bug.status))) fail("BUG_FIX_STATE", "Only an assigned bug awaiting a fix can be marked FIX_READY.");
    if (fields.status !== undefined && fields.status !== "FIX_READY") fail("BUG_DEVELOPER_STATUS", "Developers can mark an assigned bug FIX_READY; QA verifies or reopens it.");
    set["fixDetails.fixSummary"] = text(fields.fixSummary, "fix summary");
    set["fixDetails.fixedBy"] = new ObjectId(caller.mongoUserId);
    set["fixDetails.fixReadyAt"] = new Date();
    set.status = "FIX_READY";
  } else if (caller.role === "QA") {
    if (hasAssignee) fail("BUG_ASSIGNMENT_LEAD_ONLY", "Only an Engineering Lead can assign developers.");
    Object.assign(set, await reportFields(fields, caller));
    if ("qaVerificationResult" in fields) {
      const result = fields.qaVerificationResult;
      if (!["PASS", "FAIL"].includes(String(result))) fail("BUG_VERIFICATION_RESULT", "QA verification must be PASS or FAIL.");
      if (bug.status !== "FIX_READY" && !(bug.status === "VERIFIED_CLOSED" && result === "FAIL")) fail("BUG_VERIFICATION_STATE", "Verify a bug after its developer marks it FIX_READY. A failed retest may also reopen a previously verified bug.");
      set["qaVerification.result"] = result;
      set["qaVerification.verifiedBy"] = new ObjectId(caller.mongoUserId);
      set["qaVerification.verifiedAt"] = new Date();
      set.status = result === "PASS" ? "VERIFIED_CLOSED" : "REOPENED";
    }
    if (fields.status !== undefined && fields.status !== (set.status ?? bug.status)) fail("BUG_QA_STATUS", "Use QA verification PASS to close a fixed bug or FAIL to reopen it. Assignment belongs to the Engineering Lead.");
  }
  if (!Object.keys(set).length) fail("BUG_NO_CHANGE", "Specify the bug details or workflow action to update.");
  // Compare-and-set stops a stale fix, assignment or verification from silently
  // overwriting a concurrent transition. MongoDB null also matches absent fields.
  const snapshot: Filter<Document> = { _id: bug._id, status: bug.status, assigneeId: bug.assigneeId ?? null };
  if (bug.updatedAt !== undefined) snapshot.updatedAt = bug.updatedAt;
  return { filter: { $and: [scopeFilter, snapshot] }, set, bugKey: bug.bugKey, status: set.status ?? bug.status };
}
