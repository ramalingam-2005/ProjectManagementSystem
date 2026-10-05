import { routeAgent } from "@/src/agent/router";
import { runSpecialistAgent } from "@/src/agent/specialist-agent";
import type { Caller } from "@/src/types";
import type { RequirementsReview } from "@/src/requirements-review";
import { getRequirementsReviewService } from "@/src/services/requirements-review.service";
import { chatThreadId, safeSessionId } from "@/src/utils/chat-session";
import { recordListIntent } from "@/src/agent/record-list";

export const WORKSPACE_SCOPE_RESPONSE = "That request is outside my product-engineering workspace scope. I can help with requirements, sprints and tasks, bugs and QA, releases, and internal documentation.";

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

  const threadId = chatThreadId(input.caller, sessionId);
  if (input.requirementsReview && input.caller.role !== "PRODUCT_MANAGER") throw new Error("REVIEW_PM_ONLY");
  const agent = await routeAgent(input.caller, sessionId, message, Boolean(input.requirementsReview));
  if (agent === "OUT_OF_SCOPE") return {
    agent, threadId, response: WORKSPACE_SCOPE_RESPONSE, trace: [],
    requirementsReview: undefined, requirementsReviewUnchanged: Boolean(input.requirementsReview),
  };
  const service = agent === "REQUIREMENTS" && input.caller.role === "PRODUCT_MANAGER"
    && (!recordListIntent(message) || input.requirementsReview)
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
