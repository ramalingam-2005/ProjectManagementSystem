import { ObjectId, type Document, type Filter } from "mongodb";
import { getDb } from "@/src/db/mongodb";
import { MONGO_LIMITS } from "@/src/security/mongo-policy";
import { BugWorkflowError } from "@/src/utils/business-action-errors";

export interface BugTestLink {
  testCaseId: ObjectId;
  testCaseKey: string;
  productId: ObjectId;
  releaseVersion: string;
  attempt: number;
  executionIndex: number;
  // Entire array is a compare-and-set snapshot. Never overwrite a concurrent
  // execution change or another bug link, even if array indexes have moved.
  executions: Document[];
}

export async function prepareQaBugTestLink(fields: Record<string, unknown>): Promise<BugTestLink> {
  const reference = fields.sourceTestCase ?? fields.sourceTestCaseId;
  if (reference === undefined || reference === "") throw new BugWorkflowError("BUG_TEST_CASE_REQUIRED", "Which test case did you use to find this bug? Please provide its test-case key, such as TC-106.");
  if (typeof reference !== "string" || !reference.trim()) throw new BugWorkflowError("BUG_TEST_CASE_INVALID", "Please provide an existing test-case key or ID for this bug.");
  const value = reference.trim();
  const literal = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter: Filter<Document> = ObjectId.isValid(value) ? { _id: new ObjectId(value) } : { testCaseKey: { $regex: `^${literal}$`, $options: "i" } };
  const records = await (await getDb()).collection("test_cases").find(filter, {
    maxTimeMS: MONGO_LIMITS.maxTimeMS, projection: { _id: 1, testCaseKey: 1, productId: 1, active: 1, executions: 1 },
  }).limit(2).toArray();
  if (records.length !== 1 || records[0].active === false) throw new BugWorkflowError("BUG_TEST_CASE_NOT_AVAILABLE", records.length > 1
    ? "More than one test case has that key. Please select the exact test-case ID."
    : "That active test case was not found. Which test case should this bug be linked to?");
  const testCase = records[0];
  if (!(testCase.productId instanceof ObjectId)) throw new BugWorkflowError("BUG_TEST_PRODUCT_REQUIRED", "The selected test case needs a valid product before a bug can be linked to it.");
  if (fields.productId !== undefined && String(fields.productId) !== String(testCase.productId)) throw new BugWorkflowError("BUG_PRODUCT_MISMATCH", "The selected test case belongs to a different product.");
  if (fields.affectedReleaseVersion !== undefined && (typeof fields.affectedReleaseVersion !== "string" || !fields.affectedReleaseVersion.trim())) throw new BugWorkflowError("BUG_TEST_RELEASE_REQUIRED", "Which release version was tested for this bug?");
  if (fields.testExecutionAttempt !== undefined && (typeof fields.testExecutionAttempt !== "number" || !Number.isSafeInteger(fields.testExecutionAttempt) || fields.testExecutionAttempt < 1)) throw new BugWorkflowError("BUG_TEST_ATTEMPT_INVALID", "Which positive whole-number execution attempt found this bug?");
  const executions: Document[] = Array.isArray(testCase.executions) ? testCase.executions : [];
  if (!executions.length) throw new BugWorkflowError("BUG_TEST_EXECUTION_REQUIRED", "This test case has no recorded executions. Record the relevant test run before linking a new bug.");
  const release = typeof fields.affectedReleaseVersion === "string" ? fields.affectedReleaseVersion.trim() : undefined;
  const matches = executions.map((execution, index) => ({ execution, index })).filter(({ execution }) => execution && typeof execution === "object"
    && (release === undefined || execution.releaseVersion === release)
    && (fields.testExecutionAttempt === undefined || execution.attempt === fields.testExecutionAttempt));
  if (matches.length !== 1) throw new BugWorkflowError("BUG_TEST_EXECUTION_SELECTION", matches.length
    ? "This test case has multiple matching executions. Which release version and attempt found the bug?"
    : "No recorded execution matches that release and attempt. Please select the test run that found the bug.");
  const { execution, index } = matches[0];
  if (typeof execution.releaseVersion !== "string" || !execution.releaseVersion.trim() || !Number.isSafeInteger(execution.attempt) || execution.attempt < 1) throw new BugWorkflowError("BUG_TEST_EXECUTION_INVALID", "The selected execution needs a valid release version and attempt number before a bug can be linked.");
  if (execution.linkedBugId != null) throw new BugWorkflowError("BUG_TEST_ALREADY_LINKED", "This execution is already linked to a bug. Review the existing bug or select another execution; its link will not be replaced.");
  return { testCaseId: testCase._id, testCaseKey: String(testCase.testCaseKey ?? value), productId: testCase.productId,
    releaseVersion: execution.releaseVersion, attempt: execution.attempt, executionIndex: index, executions };
}
