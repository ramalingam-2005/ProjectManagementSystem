import { ObjectId, type Document } from "mongodb";
import { MongoReadActionSchema, type MongoReadAction } from "@/src/db/mongo-action";
import { getCollectionSchema } from "@/src/config/schema-registry";
import { AGGREGATION_STAGES, EXPRESSION_OPERATORS, FILTER_OPERATORS, GROUP_OPERATORS, LOGICAL_OPERATORS, MONGO_LIMITS, authorizeMongoRead } from "@/src/security/mongo-policy";
import type { AgentName, Caller, SchemaField } from "@/src/types";
import { getRolePolicy } from "@/src/security/policy";

type Context = Map<string, SchemaField>;
type Budget = { stages: number; lookups: number };
export type ValidatedPipeline = { pipeline: Document[]; context: Context };

function fail(message: string): never { throw new Error(message); }
function object(value: unknown): Document {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("INVALID_MONGO_OBJECT");
  return value as Document;
}
function name(value: unknown, path = true): string {
  if (typeof value !== "string" || !value.length || value.length > 160
    || !(path ? /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/ : /^[A-Za-z_][\w]*$/).test(value)
    || value.split(".").some((part) => ["__proto__", "constructor", "prototype"].includes(part))) fail("UNSAFE_FIELD_NAME");
  return value;
}
export function assertJsonData(input: unknown) {
  let nodes = 0;
  const walk = (value: unknown, depth: number) => {
    if (++nodes > MONGO_LIMITS.nodes) fail("QUERY_TOO_COMPLEX");
    if (depth > MONGO_LIMITS.depth) fail("QUERY_TOO_DEEP");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (value.length > MONGO_LIMITS.stringLength || value.includes("\0")) fail("INVALID_STRING");
      return;
    }
    if (typeof value === "number") { if (!Number.isFinite(value)) fail("INVALID_NUMBER"); return; }
    if (Array.isArray(value)) { value.forEach((item) => walk(item, depth + 1)); return; }
    for (const [key, item] of Object.entries(object(value))) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail("UNSAFE_FIELD_NAME");
      walk(item, depth + 1);
    }
  };
  walk(input, 0);
  if (Buffer.byteLength(JSON.stringify(input)) > MONGO_LIMITS.actionBytes) fail("ACTION_TOO_LARGE");
}
function baseContext(collection: string): Context {
  const schema = getCollectionSchema(collection);
  if (!schema) fail(`UNKNOWN_COLLECTION_SCHEMA:${collection}`);
  return new Map(Object.entries(schema.fields));
}
function field(context: Context, value: unknown, use: "query" | "read" = "query"): SchemaField {
  const key = name(value);
  const config = context.get(key);
  if (!config || (use === "query" ? config.queryable === false : config.selectable === false)) {
    fail(`${use === "query" ? "FIELD_NOT_QUERYABLE" : "FIELD_NOT_SELECTABLE"}:${key}`);
  }
  return config;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(`${label}_EXCEEDED:${max}`);
  return value;
}
function scalar(value: unknown, info: SchemaField): unknown {
  if (value === null) return null;
  const kind = info.type.replace(/\[\]$/, "");
  if (kind === "ObjectId") {
    const text = typeof value === "string" ? value : object(value).$oid;
    if (typeof text !== "string" || !/^[a-f\d]{24}$/i.test(text)
      || (typeof value === "object" && Object.keys(object(value)).length !== 1)) fail("INVALID_OBJECT_ID");
    return new ObjectId(text);
  }
  if (kind === "date") {
    const text = typeof value === "string" ? value : object(value).$date;
    if (typeof text !== "string" || !/^\d{4}-\d\d-\d\dT/.test(text) || Number.isNaN(Date.parse(text))
      || (typeof value === "object" && Object.keys(object(value)).length !== 1)) fail("INVALID_DATE");
    return new Date(text);
  }
  if (kind === "number" && typeof value !== "number") fail("INVALID_NUMBER_VALUE");
  if (kind === "boolean" && typeof value !== "boolean") fail("INVALID_BOOLEAN_VALUE");
  if (kind === "string" && typeof value !== "string") fail("INVALID_STRING_VALUE");
  if (!["string", "number", "boolean"].includes(typeof value)) fail("UNSUPPORTED_LITERAL");
  return value;
}
function safeRegex(value: unknown) {
  if (typeof value !== "string" || !value.length || value.length > MONGO_LIMITS.regexLength) fail("INVALID_REGEX");
  // Literal text with optional anchors and escaped punctuation/word boundaries.
  // Arbitrary quantified patterns are intentionally excluded to bound regex work.
  const body = value.replace(/^\^/, "").replace(/\$$/, "").replace(/\\(?:[.*+?^${}()|[\]\\/\-]|b)/g, "");
  if (/[.*+?^${}()|[\]\\]/.test(body)) fail("UNSAFE_REGEX");
  return value;
}
function predicate(value: unknown, info: SchemaField): unknown {
  if (value === null || typeof value !== "object" || Object.hasOwn(object(value), "$oid") || Object.hasOwn(object(value), "$date")) return scalar(value, info);
  const operators = object(value);
  if (!Object.keys(operators).length) fail("EMPTY_PREDICATE");
  const result: Document = {};
  for (const [operator, operand] of Object.entries(operators)) {
    if (!FILTER_OPERATORS.has(operator)) fail(`OPERATOR_NOT_ALLOWED:${operator}`);
    if (operator === "$in" || operator === "$nin") {
      if (!Array.isArray(operand) || operand.length > MONGO_LIMITS.inValues) fail("IN_ARRAY_LIMIT");
      result[operator] = operand.map((item) => scalar(item, info));
    } else if (operator === "$exists") {
      if (typeof operand !== "boolean") fail("INVALID_EXISTS");
      result[operator] = operand;
    } else if (operator === "$not") {
      const nested = object(operand);
      if (!Object.keys(nested).length || "$not" in nested) fail("INVALID_NOT");
      result[operator] = predicate(nested, info);
    } else if (operator === "$regex") {
      if (!info.type.startsWith("string")) fail("REGEX_REQUIRES_STRING_FIELD");
      result[operator] = safeRegex(operand);
    } else if (operator === "$options") {
      if (!("$regex" in operators) || operand !== "i") fail("REGEX_OPTIONS_NOT_ALLOWED");
      result[operator] = operand;
    } else result[operator] = scalar(operand, info);
  }
  return result;
}
function filter(input: unknown, context: Context, forbidden: Set<string>): Document {
  const result: Document = {};
  for (const [key, value] of Object.entries(object(input))) {
    if (LOGICAL_OPERATORS.has(key)) {
      if (!Array.isArray(value) || !value.length || value.length > 20) fail("LOGICAL_ARRAY_LIMIT");
      result[key] = value.map((item) => filter(item, context, forbidden));
    } else {
      if (key.startsWith("$")) fail(`OPERATOR_NOT_ALLOWED:${key}`);
      if (forbidden.has(key)) fail("DEVELOPER_CAN_ONLY_ACCESS_OWN_OR_ASSIGNED_RECORDS");
      result[key] = predicate(value, field(context, key));
    }
  }
  return result;
}
function sort(input: unknown, context: Context): Document {
  const result: Document = {};
  for (const [key, value] of Object.entries(object(input))) {
    field(context, key);
    if (value !== 1 && value !== -1) fail("INVALID_SORT_DIRECTION");
    result[key] = value;
  }
  return result;
}
const derived: SchemaField = { type: "derived", selectable: true, queryable: true };
function expression(value: unknown, context: Context): SchemaField {
  if (typeof value === "string" && value.startsWith("$")) {
    if (value.startsWith("$$")) fail("EXPRESSION_VARIABLE_NOT_ALLOWED");
    return field(context, value.slice(1), "read");
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return derived;
  const spec = object(value);
  if (Object.keys(spec).length !== 1) fail("INVALID_EXPRESSION");
  const [operator, operand] = Object.entries(spec)[0];
  if (!EXPRESSION_OPERATORS.has(operator)) fail(`EXPRESSION_NOT_ALLOWED:${operator}`);
  if (operator === "$literal") { scalar(operand, derived); return derived; }
  if (operator === "$size") { expression(operand, context); return { ...derived, type: "number" }; }
  if (!Array.isArray(operand) || operand.length < 2 || operand.length > 10
    || (["$subtract", "$divide", "$ifNull"].includes(operator) && operand.length !== 2)) fail("INVALID_EXPRESSION_ARGUMENTS");
  operand.forEach((item) => expression(item, context));
  return derived;
}
function projection(input: unknown, context: Context, expressions: boolean): Context {
  const spec = object(input);
  if (!Object.keys(spec).length) fail("EMPTY_PROJECTION");
  const exclusion = Object.entries(spec).some(([key, value]) => key !== "_id" && value === 0)
    || (Object.keys(spec).length === 1 && spec._id === 0);
  const output = exclusion ? new Map(context) : new Map<string, SchemaField>();
  for (const [key, value] of Object.entries(spec)) {
    name(key);
    if (value === 0 || value === 1) {
      field(context, key, "read");
      // MongoDB permits explicitly retaining _id in an exclusion projection.
      if (exclusion && value !== 0 && key !== "_id") fail("MIXED_PROJECTION");
      if (value === 0) for (const path of output.keys()) { if (path === key || path.startsWith(key + ".")) output.delete(path); }
      if (value === 1) for (const [path, info] of context) { if (path === key || path.startsWith(key + ".")) output.set(path, info); }
    } else {
      if (!expressions || exclusion) fail("PROJECTION_EXPRESSION_NOT_ALLOWED");
      name(key, false);
      const info = expression(value, context);
      if (["object", "array"].includes(info.type) || info.type.endsWith("[]")) fail("COMPUTED_OBJECT_PROJECTION_NOT_ALLOWED");
      output.set(key, info);
    }
  }
  if (spec._id !== 0 && context.has("_id")) output.set("_id", context.get("_id")!);
  // Excluding descendants while retaining their parent would re-expose them.
  for (const key of Object.keys(spec).filter((key) => spec[key] === 0)) {
    for (const path of output.keys()) if (key.startsWith(path + ".")) output.delete(path);
  }
  return output;
}
export function readableProjection(context: Context): Document {
  const paths = [...context].filter(([, info]) => info.selectable !== false).map(([path]) => path);
  const spec: Document = { _id: 0 };
  for (const path of paths) if (!paths.some((parent) => parent !== path && path.startsWith(parent + "."))) spec[path] = 1;
  if (!paths.length) fail("EMPTY_RESULT_SHAPE");
  return spec;
}
function forbiddenFields(agent: AgentName, caller: Caller, collection: string) {
  const rule = getRolePolicy(agent, caller.role)[collection]!; // Collection permission was validated by the caller.
  return new Set(caller.role === "DEVELOPER" && ["OWN", "ASSIGNED"].includes(rule.scope) ? ["assigneeId"] : []);
}
function pipeline(input: unknown, collection: string, agent: AgentName, caller: Caller, budget: Budget, depth = 0): ValidatedPipeline {
  authorizeMongoRead(agent, caller, collection, "aggregate");
  if (!Array.isArray(input) || input.length > MONGO_LIMITS.pipelineStages) fail("PIPELINE_LENGTH_EXCEEDED");
  if (depth > MONGO_LIMITS.lookupDepth) fail("LOOKUP_DEPTH_EXCEEDED");
  let context = baseContext(collection);
  const forbidden = forbiddenFields(agent, caller, collection);
  const stages: Document[] = [];
  for (const raw of input) {
    if (++budget.stages > MONGO_LIMITS.totalStages) fail("TOTAL_STAGE_LIMIT");
    const stage = object(raw);
    if (Object.keys(stage).length !== 1) fail("INVALID_AGGREGATION_STAGE");
    const [operator, value] = Object.entries(stage)[0];
    if (!AGGREGATION_STAGES.has(operator)) fail(`STAGE_NOT_ALLOWED:${operator}`);
    if (operator === "$match") stages.push({ $match: filter(value, context, forbidden) });
    else if (operator === "$sort") stages.push({ $sort: sort(value, context) });
    else if (operator === "$limit" || operator === "$skip") stages.push({
      [operator]: integer(value, operator === "$limit" ? 1 : 0, operator === "$limit" ? MONGO_LIMITS.results : MONGO_LIMITS.skip, operator),
    });
    else if (operator === "$project") { context = projection(value, context, true); stages.push(stage); }
    else if (operator === "$count") { context = new Map([[name(value, false), { ...derived, type: "number" }]]); stages.push(stage); }
    else if (operator === "$unwind") {
      const options = typeof value === "string" ? { path: value } : object(value);
      if (Object.keys(options).some((key) => !["path", "preserveNullAndEmptyArrays", "includeArrayIndex"].includes(key))) fail("UNSUPPORTED_UNWIND_FORM");
      if (typeof options.path !== "string" || !options.path.startsWith("$") || options.path.startsWith("$$")) fail("INVALID_UNWIND_PATH");
      field(context, options.path.slice(1), "read");
      if (options.preserveNullAndEmptyArrays !== undefined && typeof options.preserveNullAndEmptyArrays !== "boolean") fail("INVALID_UNWIND_OPTION");
      if (options.includeArrayIndex !== undefined) {
        const alias = name(options.includeArrayIndex, false);
        if (context.has(alias)) fail("OUTPUT_FIELD_COLLISION");
        context.set(alias, { ...derived, type: "number" });
      }
      stages.push(stage);
    } else if (operator === "$group") {
      const group = object(value);
      if (!("_id" in group)) fail("GROUP_ID_REQUIRED");
      const next: Context = new Map();
      for (const [key, item] of Object.entries(group)) {
        name(key, false);
        if (key === "_id") {
          if (item && typeof item === "object" && !Object.keys(item).some((entry) => entry.startsWith("$"))) {
            for (const [part, expr] of Object.entries(object(item))) { name(part, false); next.set(`_id.${part}`, expression(expr, context)); }
            next.set("_id", { ...derived, type: "object" });
          } else next.set("_id", expression(item, context));
        } else {
          const accumulator = object(item);
          if (Object.keys(accumulator).length !== 1) fail("INVALID_GROUP_ACCUMULATOR");
          const [op, expr] = Object.entries(accumulator)[0];
          if (!GROUP_OPERATORS.has(op)) fail(`ACCUMULATOR_NOT_ALLOWED:${op}`);
          next.set(key, expression(expr, context));
        }
      }
      context = next; stages.push(stage);
    } else if (operator === "$lookup") {
      if (++budget.lookups > MONGO_LIMITS.lookups) fail("LOOKUP_COUNT_EXCEEDED");
      const lookup = object(value);
      const from = name(lookup.from, false);
      authorizeMongoRead(agent, caller, from, "aggregate");
      if (Object.keys(lookup).some((key) => !["from", "localField", "foreignField", "as", "pipeline"].includes(key))) fail("UNSUPPORTED_LOOKUP_FORM");
      const alias = name(lookup.as, false);
      if ([...context.keys()].some((path) => path === alias || path.startsWith(alias + "."))) fail("OUTPUT_FIELD_COLLISION");
      const hasFields = lookup.localField !== undefined || lookup.foreignField !== undefined;
      if (hasFields) {
        field(context, lookup.localField);
        field(baseContext(from), lookup.foreignField);
        if (forbidden.has(lookup.localField) || forbiddenFields(agent, caller, from).has(lookup.foreignField)) fail("DEVELOPER_CAN_ONLY_ACCESS_OWN_OR_ASSIGNED_RECORDS");
      } else if (lookup.pipeline === undefined) fail("UNSUPPORTED_LOOKUP_FORM");
      const nested = pipeline(lookup.pipeline ?? [], from, agent, caller, budget, depth + 1);
      const foreignOutput = [...nested.context].filter(([, info]) => info.selectable !== false);
      context.set(alias, { ...derived, type: "array" });
      for (const [key, info] of foreignOutput) context.set(`${alias}.${key}`, info);
      stages.push({ $lookup: { ...lookup, pipeline: [...nested.pipeline, { $project: readableProjection(nested.context) }] } });
    }
  }
  return { pipeline: stages, context };
}

export function validateMongoAction(agent: AgentName, caller: Caller, input: unknown): MongoReadAction {
  assertJsonData(input);
  const parsed = MongoReadActionSchema.safeParse(input);
  if (!parsed.success) fail("INVALID_MONGO_ACTION_SCHEMA");
  const action = parsed.data;
  authorizeMongoRead(agent, caller, action.collection, action.operation);
  const context = baseContext(action.collection);
  if (action.limit !== undefined) integer(action.limit, 1, MONGO_LIMITS.results, "LIMIT");
  if (action.skip !== undefined) integer(action.skip, 0, MONGO_LIMITS.skip, "SKIP");
  if (action.operation === "aggregate") {
    if (action.filter || action.projection || action.sort || action.skip !== undefined) fail("AGGREGATE_REQUIRES_PIPELINE_ONLY");
    const validated = pipeline(action.pipeline, action.collection, agent, caller, { stages: 0, lookups: 0 });
    return { ...action, operation: "aggregate", limit: action.limit ?? 25,
      pipeline: [...validated.pipeline, { $project: readableProjection(validated.context) }] } as MongoReadAction;
  }
  if (action.pipeline !== undefined) fail("PIPELINE_ONLY_FOR_AGGREGATE");
  if (action.operation === "countDocuments" && (action.projection || action.sort || action.limit !== undefined || action.skip !== undefined)) fail("COUNT_REQUIRES_FILTER_ONLY");
  if (action.operation === "findOne" && (action.limit !== undefined || action.skip !== undefined)) fail("FIND_ONE_PAGING_NOT_ALLOWED");
  const validatedFilter = filter(action.filter ?? {}, context, forbiddenFields(agent, caller, action.collection));
  const output = action.projection ? projection(action.projection, context, false)
    : new Map(["_id", ...(getCollectionSchema(action.collection)?.defaultProjection ?? [])].map((key) => [key, field(context, key, "read")]));
  return { ...action, operation: action.operation as MongoReadAction["operation"], filter: validatedFilter,
    projection: readableProjection(output), sort: action.sort ? sort(action.sort, context) : { _id: 1 },
    ...(action.operation === "find" ? { limit: action.limit ?? 10, skip: action.skip ?? 0 } : {}) };
}
