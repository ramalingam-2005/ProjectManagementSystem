import { ObjectId } from "mongodb";
import { getDb } from "@/src/db/mongodb";
import type { AgentName, Caller } from "@/src/types";

export function redactDatabaseAction(value: unknown, depth = 0, budget = { left: 800 }): unknown {
  if (depth > 16 || --budget.left < 0) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 2000)
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/gi, "[redacted MongoDB URI]")
    .replace(/\b(?:gsk_|sk-)[A-Za-z0-9_-]+/g, "[redacted API key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(\b(?:password|secret|api[-_ ]?key|access[-_ ]?token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]");
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactDatabaseAction(item, depth + 1, budget));
  if (value && typeof value === "object") {
    if (value instanceof ObjectId) return value.toHexString();
    if (value instanceof Date) return value.toISOString();
    const entries = Object.entries(value).slice(0, 100);
    return Object.fromEntries(entries.map(([key, item]) => [key,
      /password|secret|credential|api.?key|authorization|access.?token/i.test(key) ? "[redacted]" : redactDatabaseAction(item, depth + 1, budget)]));
  }
  return ["number", "boolean"].includes(typeof value) || value === null ? value : "[unsupported value]";
}

export async function auditDatabaseAction(agent: AgentName, caller: Caller, action: unknown,
  validationResult: "ALLOWED" | "REJECTED", executionStatus: "SUCCEEDED" | "FAILED" | "NOT_EXECUTED", code?: string) {
  const data = action && typeof action === "object" ? action as Record<string, unknown> : {};
  const db = await getDb();
  await db.collection("audit_logs").insertOne({
    userId: new ObjectId(caller.mongoUserId), role: caller.role, agent,
    collection: typeof data.collection === "string" ? redactDatabaseAction(data.collection.slice(0, 80)) : undefined,
    operation: typeof data.operation === "string" ? redactDatabaseAction(data.operation.slice(0, 40)) : undefined,
    action: `${agent}_${executionStatus}`, entityType: "AI_TOOL", channel: "CHAT",
    generatedAction: redactDatabaseAction(action), validationResult, executionStatus,
    resultSummary: { ok: executionStatus === "SUCCEEDED", ...(code ? { code: redactDatabaseAction(code.slice(0, 180)) } : {}) }, timestamp: new Date(),
  });
}
