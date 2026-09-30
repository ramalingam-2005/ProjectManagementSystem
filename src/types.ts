export type Role = "PRODUCT_MANAGER" | "ENGINEERING_LEAD" | "DEVELOPER" | "QA";

export type AgentName =
  | "REQUIREMENTS"
  | "SPRINT_TASK"
  | "BUG"
  | "RELEASE"
  | "DOCUMENTATION";

export type DbOperation =
  | "find"
  | "find_one"
  | "count"
  | "insert_one"
  | "insert_many"
  | "update_one"
  | "update_many"
  | "calculate";

export type Scope = "OWN" | "TEAM" | "ALL" | "ASSIGNED";

export interface Caller {
  mongoUserId: string;
  userKey: string;
  email?: string;
  name: string;
  role: Role;
  active: boolean;
}

export type ConditionOperator =
  | "eq"
  | "ne"
  | "in"
  | "nin"
  | "contains"
  | "starts_with"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export interface SafeCondition {
  field: string;
  operator: ConditionOperator;
  stringValue?: string;
  numberValue?: number;
  booleanValue?: boolean;
  valueList?: string[];
}

export interface FieldChange {
  field: string;
  stringValue?: string;
  numberValue?: number;
  booleanValue?: boolean;
  stringListValue?: string[];
}

export interface InsertDocument {
  fields: FieldChange[];
}

export type CalculationMetric =
  | "developer_workload"
  | "sprint_overload_summary"
  | "release_readiness";

export interface DatabaseAction {
  collection: string;
  operation: DbOperation;
  conditions?: SafeCondition[];
  logic?: "AND" | "OR";
  limit?: number;
  sortField?: string;
  sortDirection?: "asc" | "desc";
  selectFields?: string[];
  fields?: FieldChange[];
  documents?: InsertDocument[];
  metric?: CalculationMetric;
  reason: string;
}

export interface AgentTrace {
  agent: AgentName;
  generatedAction?: unknown;
  guardrail?: unknown;
  result?: unknown;
}

export interface SchemaField {
  type: string;
  description?: string;
  queryable?: boolean;
  selectable?: boolean;
}

export interface CollectionSchema {
  description: string;
  fields: Record<string, SchemaField>;
  virtualFields?: Record<string, SchemaField>;
  relationships?: Record<string, string>;
  defaultProjection: string[];
}
