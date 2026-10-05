import { getRolePolicy } from "@/src/security/policy";
import type { AgentName, Caller, Role } from "@/src/types";

export const MONGO_LIMITS = Object.freeze({
  results: 25, skip: 10_000, pipelineStages: 20, totalStages: 40,
  lookupDepth: 3, lookups: 6, depth: 16, nodes: 800, inValues: 20,
  stringLength: 2000, regexLength: 120, actionBytes: 32_000,
  responseBytes: 1_000_000, maxTimeMS: 5000,
});
export const READ_OPERATIONS = ["find", "findOne", "countDocuments", "aggregate"] as const;
export type MongoReadOperation = typeof READ_OPERATIONS[number];
export const FILTER_OPERATORS = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists", "$not", "$regex", "$options"]);
export const LOGICAL_OPERATORS = new Set(["$and", "$or"]);
export const AGGREGATION_STAGES = new Set(["$match", "$lookup", "$unwind", "$group", "$project", "$sort", "$limit", "$skip", "$count"]);
export const GROUP_OPERATORS = new Set(["$sum", "$avg", "$min", "$max", "$first", "$last"]);
export const EXPRESSION_OPERATORS = new Set(["$literal", "$add", "$subtract", "$multiply", "$divide", "$ifNull", "$size"]);

// Native reads inherit the existing collection and record permissions. Aggregation
// is read-only and requires the same find grant on every participating collection.
export function nativeOperations(agent: AgentName, role: Role, collection: string): MongoReadOperation[] {
  const ops = getRolePolicy(agent, role)[collection]?.ops ?? [];
  return READ_OPERATIONS.filter((operation) => ops.includes(operation === "findOne" ? "find_one"
    : operation === "countDocuments" ? "count" : "find"));
}

export function authorizeMongoRead(agent: AgentName, caller: Caller, collection: string, operation: string) {
  if (!caller.active) throw new Error("USER_INACTIVE");
  const policy = getRolePolicy(agent, caller.role);
  if (!Object.hasOwn(policy, collection) || !policy[collection]) throw new Error(`COLLECTION_NOT_ALLOWED:${collection}`);
  if (!nativeOperations(agent, caller.role, collection).includes(operation as MongoReadOperation)) {
    throw new Error(`OPERATION_NOT_ALLOWED:${operation}`);
  }
  return policy[collection]!;
}
