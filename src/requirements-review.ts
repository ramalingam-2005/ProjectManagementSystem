import { z } from "zod";

const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
const text = (max: number) => z.string().trim().min(1).max(max);

export const RequirementsDraftSchema = z.object({
  featureRequestId: objectId,
  existingEpicId: objectId.optional(),
  epic: z.object({ title: text(180), description: text(6000) }).strict().optional(),
  stories: z.array(z.object({
    title: text(180),
    userStory: text(4000),
    acceptanceCriteria: z.array(text(600)).min(1).max(15),
    storyPoints: z.number().int().min(0).max(100),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  }).strict()).max(5),
}).strict().refine((draft) => Boolean(draft.epic) !== Boolean(draft.existingEpicId), {
  message: "Provide either a new epic or an existingEpicId.",
}).refine((draft) => Boolean(draft.epic) || draft.stories.length > 0, {
  message: "Include at least one new epic or story.",
});

export const RequirementsReviewSchema = z.object({
  id: objectId,
  draft: RequirementsDraftSchema,
  featureTitle: text(500),
  existingEpicTitle: text(500).optional(),
}).strict();

export type RequirementsDraft = z.infer<typeof RequirementsDraftSchema>;
export type RequirementsReview = z.infer<typeof RequirementsReviewSchema>;

export interface RequirementsSaveResult {
  epic: { id: string; key?: string; title: string; created: boolean };
  stories: Array<{ id: string; key: string; title: string }>;
}
