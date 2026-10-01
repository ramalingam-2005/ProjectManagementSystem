import { NextResponse } from "next/server";
import { runChat } from "@/src/agent/supervisor";
import { resolveCaller } from "@/src/repositories/user.repository";
import { RequirementsReviewSchema } from "@/src/requirements-review";
import { modelErrorResponse } from "@/src/utils/model-errors";

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

    const parsedReview = body.requirementsReview === undefined
      ? undefined : RequirementsReviewSchema.safeParse(body.requirementsReview);
    if (parsedReview && !parsedReview.success) {
      return NextResponse.json({ ok: false, error: "INVALID_REQUIREMENTS_REVIEW" }, { status: 400 });
    }
    const caller = await resolveCaller(userId);
    const result = await runChat({ caller, sessionId, message, requirementsReview: parsedReview?.data });

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
    const modelError = modelErrorResponse(error);
    if (modelError) return NextResponse.json({ ok: false, error: modelError.message }, { status: modelError.status });
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "REVIEW_PM_ONLY" ? 403 : message.startsWith("REVIEW_") ? 409
      : /USER_NOT_FOUND|USER_ID_REQUIRED/.test(message) ? 404
      : /INVALID_|REQUIRED|TOO_LONG/.test(message) ? 400
        : 500;
    const errorMessage = message === "REVIEW_PM_ONLY" ? "Only a Product Manager can review this draft."
      : message.startsWith("REVIEW_") ? "This draft changed or expired. Ask for a fresh draft to continue."
      : message;
    return NextResponse.json({ ok: false, error: errorMessage }, { status });
  }
}
