import { NextResponse } from "next/server";
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
  });
}
