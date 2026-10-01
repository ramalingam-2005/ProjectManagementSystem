import { BSON, type Document } from "mongodb";
import { getDb } from "@/src/db/mongodb";
import { validateMongoAction } from "@/src/security/mongo-validator";
import { authorizeMongoRead, MONGO_LIMITS, type MongoReadOperation } from "@/src/security/mongo-policy";
import { buildScopeFilter } from "@/src/services/scope.service";
import { auditDatabaseAction } from "@/src/services/database-audit.service";
import type { AgentName, Caller } from "@/src/types";

async function scope(agent: AgentName, caller: Caller, collection: string, operation: MongoReadOperation) {
  return buildScopeFilter(collection, authorizeMongoRead(agent, caller, collection, operation).scope, caller);
}
async function scopedPipeline(agent: AgentName, caller: Caller, collection: string, pipeline: Document[]): Promise<Document[]> {
  const enforced = await scope(agent, caller, collection, "aggregate");
  const stages: Document[] = Object.keys(enforced).length ? [{ $match: enforced }] : [];
  for (const stage of pipeline) {
    stages.push(stage.$lookup ? { $lookup: { ...stage.$lookup,
      pipeline: await scopedPipeline(agent, caller, stage.$lookup.from, stage.$lookup.pipeline),
    } } : stage);
  }
  return stages;
}

async function boundedRows(cursor: AsyncIterable<Document> & { close(): Promise<void> }, maxRows: number) {
  const rows: Document[] = [];
  let bytes = 0;
  try {
    for await (const row of cursor) {
      bytes += BSON.calculateObjectSize(row);
      if (bytes > MONGO_LIMITS.responseBytes) throw new Error("RESULT_TOO_LARGE:Narrow the query or projection.");
      rows.push(row);
      if (rows.length >= maxRows) break;
    }
    return rows;
  } finally { await cursor.close(); }
}

export async function executeMongoRead(agent: AgentName, caller: Caller, input: unknown) {
  let validated = false;
  try {
    // No target or scope query happens until the entire action, including all
    // nested lookup pipelines, has passed static validation.
    const action = validateMongoAction(agent, caller, input);
    validated = true;
    const db = await getDb();
    let result: unknown;
    const options = { maxTimeMS: MONGO_LIMITS.maxTimeMS };
    if (action.operation === "aggregate") {
      const pipeline = await scopedPipeline(agent, caller, action.collection, action.pipeline!);
      const limit = action.limit!;
      const rows = await boundedRows(db.collection(action.collection).aggregate([
        ...pipeline, { $limit: limit + 1 },
      ], { ...options, allowDiskUse: false, batchSize: limit + 1 }), limit + 1);
      result = { items: rows.slice(0, limit), returned: Math.min(rows.length, limit), hasMore: rows.length > limit, limit };
    } else {
      const enforced = await scope(agent, caller, action.collection, action.operation);
      const filter = Object.keys(enforced).length ? { $and: [action.filter!, enforced] } : action.filter!;
      const collection = db.collection(action.collection);
      if (action.operation === "countDocuments") result = { count: await collection.countDocuments(filter, options) };
      else if (action.operation === "findOne") {
        result = await collection.findOne(filter, { ...options, projection: action.projection, sort: action.sort });
        if (result && BSON.calculateObjectSize(result as Document) > MONGO_LIMITS.responseBytes) throw new Error("RESULT_TOO_LARGE:Narrow the projection.");
      } else {
        const limit = action.limit!, skip = action.skip!;
        const sort = { ...action.sort };
        if (!("_id" in sort)) sort._id = 1;
        const rows = await boundedRows(collection.find(filter, { ...options, projection: action.projection })
          .sort(sort).skip(skip).limit(limit + 1), limit + 1);
        const hasMore = rows.length > limit;
        result = { items: rows.slice(0, limit), returned: Math.min(rows.length, limit), limit, skip, hasMore,
          nextSkip: hasMore && skip + limit <= MONGO_LIMITS.skip ? skip + limit : null };
      }
    }
    // A read result is not returned if the audit cannot be recorded.
    await auditDatabaseAction(agent, caller, input, "ALLOWED", "SUCCEEDED");
    return { ok: true, agent, collection: action.collection, operation: action.operation, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "DATABASE_READ_FAILED";
    const code = message.split(":")[0];
    try { await auditDatabaseAction(agent, caller, input, validated ? "ALLOWED" : "REJECTED", validated ? "FAILED" : "NOT_EXECUTED", code); }
    catch { /* Preserve the original failure, never return an unaudited read result. */ }
    if (validated && !/^RESULT_TOO_LARGE/.test(message)) throw new Error("DATABASE_READ_FAILED:Query execution or audit failed.");
    throw error;
  }
}
