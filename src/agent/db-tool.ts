import { tool } from "@langchain/core/tools";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { getAllowedCollections } from "@/src/security/policy";
import { executeDatabaseAction } from "@/src/services/database-action.service";
import { getDb } from "@/src/db/mongodb";
import type {
  AgentName,
  AgentTrace,
  Caller,
  DatabaseAction,
  DbOperation,
  FieldChange,
  InsertDocument,
  SafeCondition,
} from "@/src/types";

const ConditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["eq", "ne", "in", "nin", "contains", "starts_with", "gt", "gte", "lt", "lte"]),
  stringValue: z.string().optional(),
  numberValue: z.number().optional(),
  booleanValue: z.boolean().optional(),
  valueList: z.array(z.string()).max(20).optional(),
});

const FieldSchema = z.object({
  field: z.string().min(1),
  stringValue: z.string().optional(),
  numberValue: z.number().optional(),
  booleanValue: z.boolean().optional(),
  stringListValue: z.array(z.string()).max(30).optional(),
});

const InsertDocumentSchema = z.object({
  fields: z.array(FieldSchema).min(1).max(15),
});

function parseJsonArray<T>(raw: string | undefined, schema: z.ZodType<T>, label: string): T | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label}_INVALID_JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${label}_INVALID:${result.error.issues.map((issue) => issue.message).join(";")}`);
  }
  return result.data;
}

function normalizeFieldChange(field: FieldChange): FieldChange {
  const aliases = new Map([
    ["blocker.blocked", "blocked"],
    ["blocker.reason", "blockerReason"],
    ["blocker.blockerReason", "blockerReason"],
  ]);
  return { ...field, field: aliases.get(field.field) ?? field.field };
}

function csvList(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  const values = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

async function auditRefusal(agent: AgentName, caller: Caller, generatedAction: unknown, error: string) {
  const db = await getDb();
  await db.collection("audit_logs").insertOne({
    userId: new ObjectId(caller.mongoUserId),
    role: caller.role,
    action: `${agent}_REFUSED`,
    entityType: "AI_TOOL",
    channel: "CHAT",
    generatedAction,
    resultSummary: { ok: false, error },
    timestamp: new Date(),
  });
}

export function makeDatabaseTool(agent: AgentName, caller: Caller, traces: AgentTrace[]) {
  const collections = getAllowedCollections(agent, caller.role);
  if (!collections.length) throw new Error(`NO_COLLECTIONS_ALLOWED:${agent}:${caller.role}`);

  const CollectionEnum = z.enum(collections as [string, ...string[]]);

  // IMPORTANT: Keep the LLM-facing tool schema flat. Groq function calling is much more reliable
  // with primitive fields. Nested conditions/fields are passed as JSON strings and validated again
  // in application code before reaching MongoDB.
  const ToolInputSchema = z.object({
    collection: CollectionEnum,
    operation: z.enum(["find", "find_one", "count", "insert_one", "insert_many", "update_one", "update_many", "calculate"]),
    conditionsJson: z.string().optional().describe(
      'JSON array of safe conditions, e.g. [{"field":"status","operator":"eq","stringValue":"APPROVED"}]. Use numberValue for numeric fields.',
    ),
    logic: z.enum(["AND", "OR"]).optional(),
    limit: z.number().int().min(1).max(25).optional(),
    sortField: z.string().optional(),
    sortDirection: z.enum(["asc", "desc"]).optional(),
    selectFieldsCsv: z.string().optional().describe("For find/find_one only. Comma-separated names from selectableFields. Omit for mutations. To read task blocker details select blocker, not blocked, blockerReason or dotted blocker paths."),
    fieldsJson: z.string().optional().describe(
      'For insert_one/update operations only. JSON array, e.g. [{"field":"status","stringValue":"APPROVED"}]. To block a task use [{"field":"blocked","booleanValue":true},{"field":"blockerReason","stringValue":"API unavailable"}]. These virtual mutation fields are accepted and translated by the backend.',
    ),
    documentsJson: z.string().optional().describe(
      'For insert_many only. JSON array of objects shaped like {"fields":[...]}. Maximum 5 documents.',
    ),
    metric: z.enum(["developer_workload", "sprint_overload_summary", "release_readiness"]).optional(),
    reason: z.string().min(3).max(180),
  });

  return tool(
    async (input) => {
      try {
        const conditions = parseJsonArray(
          input.conditionsJson,
          z.array(ConditionSchema).max(12),
          "CONDITIONS",
        ) as SafeCondition[] | undefined;

        const parsedFields = parseJsonArray(
          input.fieldsJson,
          z.array(FieldSchema).max(15),
          "FIELDS",
        ) as FieldChange[] | undefined;

        const fields = parsedFields?.map(normalizeFieldChange);

        const parsedDocuments = parseJsonArray(
          input.documentsJson,
          z.array(InsertDocumentSchema).max(5),
          "DOCUMENTS",
        ) as InsertDocument[] | undefined;

        const documents = parsedDocuments?.map((document) => ({
          ...document,
          fields: document.fields.map(normalizeFieldChange),
        }));

        const action: DatabaseAction = {
          collection: input.collection,
          operation: input.operation as DbOperation,
          conditions,
          logic: input.logic,
          limit: input.limit,
          sortField: input.sortField,
          sortDirection: input.sortDirection,
          // Only reads use projections; model-supplied selections cannot affect mutations.
          selectFields: input.operation === "find" || input.operation === "find_one"
            ? csvList(input.selectFieldsCsv)
            : undefined,
          fields,
          documents,
          metric: input.metric,
          reason: input.reason,
        };

        const result = await executeDatabaseAction(agent, caller, action);
        traces.push({ agent, generatedAction: action, guardrail: "ALLOWED", result });
        return JSON.stringify(result);
      } catch (error) {
        const result = {
          ok: false,
          error: error instanceof Error ? error.message : "ACTION_REJECTED",
        };
        traces.push({ agent, generatedAction: input, guardrail: "REJECTED", result });
        try { await auditRefusal(agent, caller, input, result.error); } catch { /* audit must not hide refusal */ }
        return JSON.stringify(result);
      }
    },
    {
      name: `${agent.toLowerCase()}_database_action`,
      description: [
        `Single guarded database action tool for the ${agent} agent.`,
        "The tool schema is intentionally flat for reliable Groq function calling.",
        "Never emit raw MongoDB syntax.",
        "Use conditionsJson, fieldsJson and documentsJson only as JSON strings matching the examples in their descriptions.",
        "Use numberValue for numeric fields (for example sprintNumber and storyPoints), never stringValue.",
        "For public identifiers use condition field=key with operator=eq.",
        "For developer identity use virtual condition field=assignee with operator=eq. Developers should not provide an assignee filter for their own records because OWN scope is injected by the backend.",
        "Deletes, drops, raw aggregation and unrestricted queries are not available.",
        "The backend independently validates role, collection, operation, field, record scope, business rules and mutation limits.",
      ].join(" "),
      schema: ToolInputSchema,
    },
  );
}
