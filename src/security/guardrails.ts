import { getCollectionSchema, listQueryableFields, listSelectableFields } from "@/src/config/schema-registry";
import { getRolePolicy } from "@/src/security/policy";
import type { AgentName, Caller, DatabaseAction, FieldChange } from "@/src/types";

export const MAX_READ_LIMIT = 25;
const MAX_OFFSET = 10_000;
const MAX_BULK_UPDATE = 20;
const MAX_CONDITIONS = 12;
const MAX_FIELDS = 15;
const MAX_INSERT_MANY = 5;

function assertPlainFieldName(field: string) {
  if (!field || field.startsWith("$") || field.includes("\0")) {
    throw new Error(`UNSAFE_FIELD:${field}`);
  }
}

function assertMutationFields(fields: FieldChange[] | undefined, allowedFields: Set<string>) {
  if (!fields?.length) throw new Error("MUTATION_FIELDS_REQUIRED");
  if (fields.length > MAX_FIELDS) throw new Error(`TOO_MANY_FIELDS:${MAX_FIELDS}`);
  for (const field of fields) {
    assertPlainFieldName(field.field);
    if (!allowedFields.has(field.field)) throw new Error(`FIELD_NOT_MUTABLE:${field.field}`);
  }
}

export function authorize(agent: AgentName, caller: Caller, action: DatabaseAction) {
  const rolePolicy = getRolePolicy(agent, caller.role);
  const rule = rolePolicy[action.collection];

  if (!rule) throw new Error(`COLLECTION_NOT_ALLOWED:${action.collection}`);
  if (!getCollectionSchema(action.collection)) throw new Error(`UNKNOWN_COLLECTION_SCHEMA:${action.collection}`);
  if (!rule.ops.includes(action.operation)) throw new Error(`OPERATION_NOT_ALLOWED:${action.operation}`);

  if (caller.role === "PRODUCT_MANAGER" && ["epics", "user_stories"].includes(action.collection)
    && ["insert_one", "insert_many"].includes(action.operation)) {
    throw new Error("PM_REVIEW_REQUIRED:Use preview_requirements_draft. Only the PM's Approve and save action can insert reviewed epics and stories.");
  }

  if ((action.conditions?.length ?? 0) > MAX_CONDITIONS) throw new Error(`TOO_MANY_CONDITIONS:${MAX_CONDITIONS}`);
  if (action.limit !== undefined && (!Number.isSafeInteger(action.limit) || action.limit < 1)) {
    throw new Error("INVALID_LIMIT:Use a positive integer.");
  }
  if ((action.limit ?? 1) > MAX_READ_LIMIT) throw new Error(`LIMIT_EXCEEDED:${MAX_READ_LIMIT}`);
  if (action.offset !== undefined) {
    if (action.operation !== "find") throw new Error("OFFSET_ONLY_ALLOWED_FOR_FIND");
    if (!Number.isSafeInteger(action.offset) || action.offset < 0) throw new Error("INVALID_OFFSET:Use a non-negative integer.");
    if (action.offset > MAX_OFFSET) throw new Error(`OFFSET_EXCEEDED:${MAX_OFFSET}:Narrow the filters to continue.`);
  }

  // OWN/ASSIGNED scope is server-derived. A developer is never allowed to target another user
  // by adding an assignee condition. This makes requests such as "show Rahul's tasks" a refusal,
  // rather than a scoped query that happens to return zero rows.
  if (caller.role === "DEVELOPER" && (rule.scope === "OWN" || rule.scope === "ASSIGNED")) {
    const targetedOtherUser = (action.conditions ?? []).some(
      (condition) => condition.field === "assignee" || condition.field === "assigneeId",
    );
    if (targetedOtherUser) throw new Error("DEVELOPER_CAN_ONLY_ACCESS_OWN_OR_ASSIGNED_RECORDS");
  }

  const queryable = new Set(listQueryableFields(action.collection));
  for (const condition of action.conditions ?? []) {
    assertPlainFieldName(condition.field);
    if (!queryable.has(condition.field)) throw new Error(`FILTER_FIELD_NOT_ALLOWED:${condition.field}`);
  }

  if (action.sortField) {
    assertPlainFieldName(action.sortField);
    if (!queryable.has(action.sortField)) throw new Error(`SORT_FIELD_NOT_ALLOWED:${action.sortField}`);
  }

  if (action.selectFields?.length) {
    const selectable = new Set(listSelectableFields(action.collection));
    for (const field of action.selectFields) {
      assertPlainFieldName(field);
      if (!selectable.has(field)) throw new Error(`SELECT_FIELD_NOT_ALLOWED:${field}`);
    }
  }

  if (["insert_one", "insert_many", "update_one", "update_many"].includes(action.operation)) {
    if (!action.reason?.trim()) throw new Error("MUTATION_REASON_REQUIRED");
    const allowed = new Set(rule.mutableFields ?? []);

    if (action.operation === "insert_many") {
      if (!action.documents?.length) throw new Error("INSERT_MANY_DOCUMENTS_REQUIRED");
      if (action.documents.length > MAX_INSERT_MANY) throw new Error(`INSERT_MANY_LIMIT:${MAX_INSERT_MANY}`);
      for (const document of action.documents) assertMutationFields(document.fields, allowed);
    } else {
      assertMutationFields(action.fields, allowed);
    }

    if (["update_one", "update_many"].includes(action.operation) && !(action.conditions?.length)) {
      throw new Error("UPDATE_REQUIRES_FILTER");
    }
    if (action.operation === "update_many" && caller.role !== "PRODUCT_MANAGER" && caller.role !== "ENGINEERING_LEAD") {
      throw new Error("BULK_UPDATE_ROLE_NOT_ALLOWED");
    }
  }

  if (action.operation === "calculate") {
    if (!action.metric) throw new Error("CALCULATION_METRIC_REQUIRED");
    if (["developer_workload", "sprint_overload_summary"].includes(action.metric) && agent !== "SPRINT_TASK") {
      throw new Error("METRIC_NOT_ALLOWED_FOR_AGENT");
    }
    if (action.metric === "release_readiness" && agent !== "RELEASE") {
      throw new Error("METRIC_NOT_ALLOWED_FOR_AGENT");
    }
  }

  return {
    rule,
    maxLimit: MAX_READ_LIMIT,
    maxOffset: MAX_OFFSET,
    maxBulkUpdate: MAX_BULK_UPDATE,
    maxInsertMany: MAX_INSERT_MANY,
  };
}
