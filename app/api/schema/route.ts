import { NextResponse } from "next/server";
import { READ_OPERATIONS, MONGO_LIMITS, FILTER_OPERATORS, LOGICAL_OPERATORS, AGGREGATION_STAGES } from "@/src/security/mongo-policy";
import { COLLECTION_SCHEMAS } from "@/src/config/schema-registry";
import { ROLE_AGENT_ACCESS } from "@/src/config/agent-registry";
import { POLICY } from "@/src/security/policy";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    database: process.env.MONGODB_DB || "product_engineering",
    roleAgentAccess: ROLE_AGENT_ACCESS,
    policies: POLICY,
    schemas: COLLECTION_SCHEMAS,
    nativeReads: { operations: READ_OPERATIONS, limits: MONGO_LIMITS,
      filterOperators: [...FILTER_OPERATORS, ...LOGICAL_OPERATORS], stages: [...AGGREGATION_STAGES] },
  });
}
