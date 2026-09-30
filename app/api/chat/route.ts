import { NextResponse } from "next/server";
import { runChat } from "@/src/agent/supervisor";
import { resolveCaller } from "@/src/repositories/user.repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";

    if (!userId || !message || !sessionId) {
      return NextResponse.json(
        { ok: false, error: "userId, message and sessionId are required. Use a new sessionId for a new conversation." },
        { status: 400 },
      );
    }

    const caller = await resolveCaller(userId);
    const result = await runChat({ caller, sessionId, message });

    return NextResponse.json({
      ok: true,
      caller: {
        id: caller.mongoUserId,
        userKey: caller.userKey,
        name: caller.name,
        role: caller.role,
      },
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = /USER_NOT_FOUND|USER_ID_REQUIRED/.test(message) ? 404
      : /INVALID_|REQUIRED|TOO_LONG/.test(message) ? 400
        : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
