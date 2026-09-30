import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RequirementsReview } from "@/src/requirements-review";
import type { RequirementsReviewService } from "@/src/services/requirements-review.service";
import type { Caller } from "@/src/types";

export function makeRequirementsDraftTool(input: {
  caller: Caller;
  threadId: string;
  revision: string;
  service: RequirementsReviewService;
  onReview: (review: RequirementsReview) => void;
}) {
  return tool(async ({ draftJson }) => {
    try {
      const review = await input.service.propose(input.caller, input.threadId, input.revision, JSON.parse(draftJson));
      input.onReview(review);
      return JSON.stringify({ ok: true, status: "AWAITING_PM_REVIEW", message: "The draft will be displayed for review. No epic or story has been saved. The PM must use Approve and save after reviewing it." });
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "INVALID_REQUIREMENTS_DRAFT" });
    }
  }, {
    name: "preview_requirements_draft",
    description: "Show a complete proposed epic and user stories to the PM for review, without inserting epic or story records. Read the feature first. Call once with the complete latest draft, including all revisions. Never treat a chat message as approval to save.",
    schema: z.object({
      draftJson: z.string().max(40000).describe('JSON object: {"featureRequestId":"real MongoDB _id","epic":{"title":"...","description":"..."},"stories":[{"title":"...","userStory":"As a ... I want ... so that ...","acceptanceCriteria":["..."],"storyPoints":3,"priority":"MEDIUM"}]}. Up to 5 stories. For stories under an existing epic, replace epic with existingEpicId. For only a new epic, use stories:[]. No status, public keys or system fields.'),
    }),
  });
}
