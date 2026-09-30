import { routeAgent } from "@/src/agent/router";
import { runSpecialistAgent } from "@/src/agent/specialist-agent";
import type { Caller } from "@/src/types";
import type { RequirementsReview } from "@/src/requirements-review";
import { getRequirementsReviewService } from "@/src/services/requirements-review.service";
import { chatThreadId, safeSessionId } from "@/src/utils/chat-session";

export async function runChat(input: {
  caller: Caller;
  sessionId: string;
  message: string;
  requirementsReview?: RequirementsReview;
}) {
  const sessionId = safeSessionId(input.sessionId);
  const message = input.message.trim();
  if (!message) throw new Error("MESSAGE_REQUIRED");
  if (message.length > 4000) throw new Error("MESSAGE_TOO_LONG");

  const agent = input.requirementsReview ? "REQUIREMENTS" : await routeAgent(input.caller, sessionId, message);
  const threadId = chatThreadId(input.caller, sessionId);
  if (input.requirementsReview && input.caller.role !== "PRODUCT_MANAGER") throw new Error("REVIEW_PM_ONLY");
  const service = agent === "REQUIREMENTS" && input.caller.role === "PRODUCT_MANAGER"
    ? await getRequirementsReviewService() : undefined;
  const saved = service ? await service.savedResult(input.caller, threadId) : undefined;
  const revision = service ? await service.begin(input.caller, threadId, input.requirementsReview) : undefined;
  const result = await runSpecialistAgent({
    agent,
    caller: input.caller,
    threadId,
    message,
    requirements: service && revision ? { service, revision, previous: input.requirementsReview, saved } : undefined,
  });

  return {
    agent,
    threadId,
    response: result.response,
    trace: result.trace,
    requirementsReview: result.requirementsReview,
  };
}
