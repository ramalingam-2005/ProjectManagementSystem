import { NextResponse } from "next/server";
import { z } from "zod";
import { chatThreadId } from "@/src/utils/chat-session";
import { resolveCaller } from "@/src/repositories/user.repository";
import { RequirementsReviewSchema } from "@/src/requirements-review";
import { getRequirementsReviewService } from "@/src/services/requirements-review.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  userId: z.string().trim().min(1).max(320),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  action: z.enum(["approve", "discard"]),
  review: RequirementsReviewSchema,
}).strict();

export async function POST(request: Request) {
  let input: z.infer<typeof RequestSchema>;
  try { input = RequestSchema.parse(await request.json()); }
  catch { return NextResponse.json({ ok: false, error: "Invalid review request." }, { status: 400 }); }
  try {
    const caller = await resolveCaller(input.userId);
    const service = await getRequirementsReviewService();
    const threadId = chatThreadId(caller, input.sessionId);
    if (input.action === "discard") {
      await service.discard(caller, threadId, input.review);
      return NextResponse.json({ ok: true, response: "Draft discarded. No epic or story was created." });
    }
    const result = await service.approve(caller, threadId, input.review);
    const response = [
      "Saved the reviewed draft.",
      `${result.epic.created ? "Created epic" : "Used existing epic"}: ${result.epic.key || result.epic.id} - ${result.epic.title}`,
      ...result.stories.map((story) => `- ${story.key}: ${story.title}`),
      "New records have DRAFT status. Approval for engineering work is a separate step.",
    ].join("\n\n");
    return NextResponse.json({ ok: true, response, result });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code === "REVIEW_PM_ONLY" ? 403 : code.startsWith("REVIEW_") ? 409
      : code === "USER_NOT_FOUND" ? 404 : code === "USER_INACTIVE" ? 403 : 500;
    const message = status === 403 ? "Only the active Product Manager can approve this draft."
      : status === 409 ? "This draft changed, expired, or is no longer available. Request a fresh preview."
      : status === 404 ? "Account not found."
      : "Could not confirm the save. Retry this same review to check its result safely.";
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
