import { ObjectId, type Filter } from "mongodb";
import { getDb } from "@/src/db/mongodb";
import type { Caller, Scope } from "@/src/types";

export async function buildScopeFilter(collection: string, scope: Scope, caller: Caller): Promise<Filter<Record<string, unknown>>> {
  if (scope === "ALL") return {};

  const callerId = new ObjectId(caller.mongoUserId);
  const db = await getDb();

  if (scope === "OWN") {
    if (collection === "tasks") return { assigneeId: callerId };
    if (collection === "sprints") return { "capacities.developerId": callerId };
    if (collection === "user_stories") {
      const storyIds = await db.collection("tasks").distinct("storyId", { assigneeId: callerId });
      return { _id: { $in: storyIds.filter((id): id is ObjectId => id instanceof ObjectId) } };
    }
    return { ownerId: callerId };
  }

  if (scope === "ASSIGNED") {
    if (collection === "bugs") return { assigneeId: callerId };
    if (collection === "test_cases") {
      const testCaseIds = await db.collection("bugs").distinct("sourceTestCaseId", { assigneeId: callerId });
      return { _id: { $in: testCaseIds.filter((id): id is ObjectId => id instanceof ObjectId) } };
    }
    return { assigneeId: callerId };
  }

  // TEAM scope is derived from users.reportsToUserId because the core project schema
  // does not require a teamId field on every record.
  if (scope === "TEAM") {
    const developerIds = await db.collection("users")
      .find({ reportsToUserId: callerId, active: { $ne: false } }, { projection: { _id: 1 } })
      .map((user) => user._id)
      .toArray();

    const teamUserIds = [callerId, ...developerIds];

    if (collection === "tasks") {
      return { $or: [{ assigneeId: { $in: teamUserIds } }, { createdBy: callerId }] };
    }
    if (collection === "bugs") return { assigneeId: { $in: developerIds } };
    if (collection === "sprints") return { "capacities.developerId": { $in: developerIds } };
    return {};
  }

  return {};
}
