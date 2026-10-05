import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getAllowedCollections } from "@/src/security/policy";
import { executeDatabaseAction } from "@/src/services/database-action.service";
import { auditDatabaseAction, redactDatabaseAction } from "@/src/services/database-audit.service";
import { READ_OPERATIONS } from "@/src/security/mongo-policy";
import { databaseErrorResponse } from "@/src/utils/database-errors";
import { INSERT_ONE_PAYLOAD_ERROR, INSERT_MANY_PAYLOAD_ERROR, SprintCreationError, BugWorkflowError } from "@/src/utils/business-action-errors";
import type { MongoReadAction } from "@/src/db/mongo-action";
import type { AgentName, AgentTrace, Caller, DatabaseAction } from "@/src/types";

const ConditionSchema = z.object({
  field: z.string().min(1), operator: z.enum(["eq", "ne", "in", "nin", "contains", "starts_with", "gt", "gte", "lt", "lte"]),
  stringValue: z.string().optional(), numberValue: z.number().optional(),
  booleanValue: z.boolean().optional(), valueList: z.array(z.string()).max(20).optional(),
}).strict();
const FieldSchema = z.object({
  field: z.string().min(1), stringValue: z.string().optional(), numberValue: z.number().optional(),
  booleanValue: z.boolean().optional(), stringListValue: z.array(z.string()).max(30).optional(),
}).strict();
function json<T>(value: string | undefined, schema: z.ZodType<T>, label: string): T | undefined {
  if (value === undefined) return undefined;
  try { return schema.parse(JSON.parse(value)); } catch (error) {
    const details = error instanceof z.ZodError
      ? error.issues.slice(0, 3).map((issue) => `${label}.${issue.path.join(".")}: ${issue.code}`).join("; ")
      : `${label}: malformed JSON`;
    throw new Error(`INVALID_BUSINESS_ACTION_JSON:${details}`);
  }
}

export function makeDatabaseTool(agent: AgentName, caller: Caller, traces: AgentTrace[], reviewInProgress = false) {
  const collections = getAllowedCollections(agent, caller.role);
  if (!collections.length) throw new Error(`NO_COLLECTIONS_ALLOWED:${agent}:${caller.role}`);
  const schema = z.object({
    collection: z.string().describe(`Permitted collections: ${collections.join(", ")}.`),
    operation: z.string().describe("Reads: find, findOne, countDocuments, aggregate. Business services only: insert_one, insert_many, update_one, update_many, calculate."),
    filter: z.record(z.unknown()).optional().describe("Native MongoDB filter object; never JavaScript."),
    projection: z.record(z.unknown()).optional(), sort: z.record(z.unknown()).optional(),
    limit: z.number().optional(), skip: z.number().optional(), pipeline: z.array(z.record(z.unknown())).optional(),
    reason: z.string().max(180).optional(),
    conditionsJson: z.string().optional().describe('Business actions only: JSON array of {field,operator,stringValue?|numberValue?|booleanValue?|valueList?}. operator is required: eq/ne/in/nin/contains/starts_with/gt/gte/lt/lte. Example: [{"field":"taskKey","operator":"eq","stringValue":"TASK-207"}].'),
    logic: z.enum(["AND", "OR"]).optional(),
    fieldsJson: z.string().optional().describe('Required for insert_one/update_one/update_many: JSON string encoding an array of FieldChange objects {field,stringValue?|numberValue?|booleanValue?|stringListValue?}. Example: [{"field":"sprintNumber","numberValue":15}]. Never use documentsJson for insert_one.'),
    documentsJson: z.string().optional().describe("Required for insert_many only: JSON string encoding an array of {fields:[FieldChange,...]} (max 5). Never use for insert_one; do not combine with fieldsJson."),
    metric: z.enum(["developer_workload", "sprint_overload_summary", "release_readiness"]).optional().describe("Required when operation=calculate. Use conditionsJson to select the requested records; native filter/sort/projection/limit fields are not valid for calculations."),
  }).strict();

  return tool(async (input) => {
    let dispatched = false;
    let action: MongoReadAction | DatabaseAction | undefined;
    try {
      const read = READ_OPERATIONS.includes(input.operation as MongoReadAction["operation"]);
      if (reviewInProgress && !read) throw new Error("PENDING_DRAFT_REQUIRES_PREVIEW:Revise the unsaved draft using preview_requirements_draft.");
      if (read || !["insert_one", "insert_many", "update_one", "update_many", "calculate"].includes(input.operation)) {
        action = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as unknown as MongoReadAction;
      } else {
        if (input.operation === "insert_one" && (input.fieldsJson === undefined || input.documentsJson !== undefined)) throw new Error(INSERT_ONE_PAYLOAD_ERROR);
        if (input.operation === "insert_many" && (input.documentsJson === undefined || input.fieldsJson !== undefined)) throw new Error(INSERT_MANY_PAYLOAD_ERROR);
        if (["filter", "projection", "sort", "skip", "pipeline", "limit"].some((key) => input[key as keyof typeof input] !== undefined)) {
          throw new Error("NATIVE_MUTATIONS_NOT_ALLOWED:Business actions use conditionsJson for selection. Calculations require metric; mutations use fieldsJson/documentsJson. Do not send native filter/sort/projection/limit/skip/pipeline fields.");
        }
        const fields = json(input.fieldsJson, z.array(FieldSchema).max(15), "fieldsJson");
        if (input.operation === "insert_one" && !fields?.length) throw new Error(INSERT_ONE_PAYLOAD_ERROR);
        const documents = json(input.documentsJson, z.array(z.object({ fields: z.array(FieldSchema).min(1).max(15) }).strict()).min(1).max(5), "documentsJson");
        action = {
          collection: input.collection, operation: input.operation as DatabaseAction["operation"],
          conditions: json(input.conditionsJson, z.array(ConditionSchema).max(12), "conditionsJson"), logic: input.logic,
          fields: fields?.map((entry) => ({ ...entry, field: entry.field === "blocker.blocked" ? "blocked"
            : ["blocker.reason", "blocker.blockerReason"].includes(entry.field) ? "blockerReason" : entry.field })),
          documents,
          metric: input.metric, reason: input.reason ?? "",
        };
      }
      dispatched = true;
      const result = await executeDatabaseAction(agent, caller, action);
      traces.push({ agent, generatedAction: redactDatabaseAction(action), guardrail: "ALLOWED", result });
      return JSON.stringify(result);
    } catch (error) {
      const unavailable = databaseErrorResponse(error);
      const message = unavailable?.message ?? (error instanceof Error ? String(redactDatabaseAction(error.message)) : "ACTION_REJECTED");
      const invalidPayload = !dispatched && /^(INVALID_INSERT_PAYLOAD|INVALID_BUSINESS_ACTION_JSON):/.test(message);
      const sprintError = error instanceof SprintCreationError ? error : undefined;
      const bugError = error instanceof BugWorkflowError ? error : undefined;
      const result = {
        ok: false, ...(unavailable ? { code: unavailable.code } : {}), error: message,
        ...(invalidPayload || sprintError || bugError ? {
          code: message.split(":")[0], executionStatus: "NOT_EXECUTED",
          retryable: invalidPayload || Boolean(sprintError?.correction),
          userMessage: bugError?.userMessage ?? sprintError?.userMessage ?? (input.collection === "sprints" && input.operation === "insert_one"
            ? "I couldn't create the sprint because the internal sprint-creation action failed validation."
            : "I couldn't complete the request because the internal action failed validation."),
        } : {}),
      };
      traces.push({ agent, generatedAction: redactDatabaseAction(action ?? input), guardrail: "REJECTED", result });
      if (!dispatched) {
        try { await auditDatabaseAction(agent, caller, input, "REJECTED", "NOT_EXECUTED", result.error.split(":")[0]); } catch { /* Retain refusal. */ }
      }
      return JSON.stringify(result);
    }
  }, {
    name: `${agent.toLowerCase()}_database_action`, schema,
    description: [
      "Shared guarded MongoDB tool. Generate structured MongoDB objects only, never JavaScript, db.collection(...), or executable code.",
      "Use find for normal reads, findOne for an exact record, countDocuments for totals, and aggregate only when needed.",
      "Use native $match/$lookup/$unwind/$group/$project/$sort/$limit/$skip/$count stages. Every lookup collection must be permitted for this agent and caller.",
      "Use only stored registry fields; virtual fields are reserved for business services. ObjectId fields accept 24-hex strings or {$oid:string}; dates accept ISO timestamps or {$date:string}.",
      "Maximum result size is 25. Nested filters use approved $and/$or and field operators. Text $regex accepts literal patterns with optional anchors, escaped punctuation and $options:'i'.",
      "Never invent IDs from descriptive text. Search stored title/description fields, retry partial keywords, and present ambiguous matches before taking action.",
      "No destructive operations or arbitrary native mutations. Existing insert/update services require explicit reason and their typed fieldsJson/documentsJson/conditionsJson contracts.",
      "Use calculate for business metrics and preview_requirements_draft for PM approval. Prefer the simplest valid operation; all parts of the action are validated before database reads.",
    ].join(" "),
  });
}
