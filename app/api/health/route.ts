import { HumanMessage } from "@langchain/core/messages";
import { NextResponse } from "next/server";
import { getModel } from "@/src/agent/model";
import { getDb, getDbName } from "@/src/db/mongodb";
import { withModelRetry } from "@/src/utils/retry";

export const runtime = "nodejs";

export async function GET() {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });

    const response = await withModelRetry(() => getModel(40).invoke([
      new HumanMessage("Reply only with: ready"),
    ]), 2);

    return NextResponse.json({
      ok: true,
      mongodb: "connected",
      database: getDbName(),
      groq: {
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        output: typeof response.content === "string" ? response.content : "connected",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Health check failed" },
      { status: 500 },
    );
  }
}
