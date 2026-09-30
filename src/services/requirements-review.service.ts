import { createHash } from "node:crypto";
import { ObjectId, type ClientSession, type Db } from "mongodb";
import { getMongoClient, getDbName } from "@/src/db/mongodb";
import { RequirementsDraftSchema, RequirementsReviewSchema, type RequirementsReview, type RequirementsSaveResult } from "@/src/requirements-review";
import type { Caller } from "@/src/types";

type Transaction = <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;
type ReviewState = {
  _id: string;
  ownerId: string;
  revision: string;
  generation: string;
  digest?: string;
  status: "editing" | "pending" | "saved" | "discarded";
  expiresAt: Date;
  result?: RequirementsSaveResult;
};

function assertPm(caller: Caller) {
  if (caller.role !== "PRODUCT_MANAGER" || !caller.active) throw new Error("REVIEW_PM_ONLY");
}

function digest(review: RequirementsReview) {
  // Hash a validated, canonical object; client edits cannot change what was reviewed.
  return createHash("sha256").update(JSON.stringify(RequirementsReviewSchema.parse(review))).digest("hex");
}

export class RequirementsReviewService {
  constructor(private readonly db: Db, private readonly transaction: Transaction) {}

  private states() { return this.db.collection<ReviewState>("requirements_reviews"); }

  async savedResult(caller: Caller, threadId: string) {
    assertPm(caller);
    const state = await this.states().findOne({ _id: threadId, ownerId: caller.mongoUserId, status: "saved" });
    return state?.result;
  }

  async begin(caller: Caller, threadId: string, previous?: RequirementsReview) {
    assertPm(caller);
    const revision = new ObjectId().toHexString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    if (previous) {
      const changed = await this.states().updateOne({
        _id: threadId, ownerId: caller.mongoUserId, revision: previous.id,
        digest: digest(previous), status: { $in: ["pending", "editing"] }, expiresAt: { $gt: new Date() },
      }, { $set: { generation: revision, status: "editing", expiresAt }, $unset: { result: "" } });
      if (!changed.matchedCount) throw new Error("REVIEW_STALE_OR_EXPIRED");
    } else {
      await this.states().replaceOne({ _id: threadId }, {
        ownerId: caller.mongoUserId, revision, generation: revision, status: "editing", expiresAt,
      }, { upsert: true });
    }
    return revision;
  }

  async propose(caller: Caller, threadId: string, revision: string, input: unknown): Promise<RequirementsReview> {
    assertPm(caller);
    const draft = RequirementsDraftSchema.parse(input);
    const feature = await this.db.collection("feature_requests").findOne({ _id: new ObjectId(draft.featureRequestId) });
    if (!feature) throw new Error("REVIEW_FEATURE_NOT_FOUND");
    const existingEpic = draft.existingEpicId
      ? await this.db.collection("epics").findOne({ _id: new ObjectId(draft.existingEpicId), featureRequestId: feature._id })
      : null;
    if (draft.existingEpicId && !existingEpic) throw new Error("REVIEW_EPIC_FEATURE_MISMATCH");
    const review = RequirementsReviewSchema.parse({
      id: revision, draft, featureTitle: feature.title,
      ...(existingEpic ? { existingEpicTitle: existingEpic.title } : {}),
    });
    // Store approval metadata only. Epic/story documents are inserted by approve().
    const changed = await this.states().updateOne({
      _id: threadId, ownerId: caller.mongoUserId, generation: revision, status: "editing", expiresAt: { $gt: new Date() },
    }, { $set: { revision, status: "pending", digest: digest(review) } });
    if (!changed.matchedCount) throw new Error("REVIEW_STALE_OR_ALREADY_PROPOSED");
    return review;
  }

  async discard(caller: Caller, threadId: string, review: RequirementsReview) {
    assertPm(caller);
    const changed = await this.states().updateOne({
      _id: threadId, ownerId: caller.mongoUserId, revision: review.id,
      digest: digest(review), status: { $in: ["pending", "editing"] },
    }, { $set: { status: "discarded" } });
    if (!changed.matchedCount) throw new Error("REVIEW_STALE_OR_ALREADY_SAVED");
  }

  async approve(caller: Caller, threadId: string, input: RequirementsReview): Promise<RequirementsSaveResult> {
    assertPm(caller);
    const review = RequirementsReviewSchema.parse(input);
    return this.transaction(async (session) => {
      const state = await this.states().findOne({
        _id: threadId, ownerId: caller.mongoUserId, revision: review.id, digest: digest(review),
      }, { session });
      if (!state) throw new Error("REVIEW_STALE_OR_CHANGED");
      if (state.status === "saved" && state.result) return state.result;
      if (state.status !== "pending" || state.expiresAt <= new Date()) throw new Error("REVIEW_STALE_OR_EXPIRED");

      // Lock the reviewed revision inside the transaction before touching business records.
      const locked = await this.states().updateOne({
        _id: threadId, revision: review.id, status: "pending",
      }, { $set: { status: "saved" } }, { session });
      if (!locked.matchedCount) throw new Error("REVIEW_STALE_OR_CHANGED");

      const { draft } = review;
      const feature = await this.db.collection("feature_requests").findOne({ _id: new ObjectId(draft.featureRequestId) }, { session });
      if (!feature) throw new Error("REVIEW_FEATURE_NOT_FOUND");
      const now = new Date();
      const common = { status: "DRAFT", generatedByAI: true, createdBy: new ObjectId(caller.mongoUserId), createdAt: now, updatedAt: now };
      let epic: RequirementsSaveResult["epic"];
      if (draft.existingEpicId) {
        const existing = await this.db.collection("epics").findOne({
          _id: new ObjectId(draft.existingEpicId), featureRequestId: feature._id,
        }, { session });
        if (!existing) throw new Error("REVIEW_EPIC_FEATURE_MISMATCH");
        epic = { id: String(existing._id), key: existing.epicKey, title: existing.title, created: false };
      } else {
        const id = new ObjectId();
        const key = `EPIC-${id.toHexString().toUpperCase()}`;
        await this.db.collection("epics").insertOne({
          _id: id, epicKey: key, featureRequestId: feature._id, ...draft.epic!, ...common,
        }, { session });
        epic = { id: String(id), key, title: draft.epic!.title, created: true };
      }
      const documents = draft.stories.map((story) => {
        const id = new ObjectId();
        return { ...story, ...common, _id: id, storyKey: `US-${id.toHexString().toUpperCase()}`, epicId: new ObjectId(epic.id) };
      });
      if (documents.length) await this.db.collection("user_stories").insertMany(documents, { session });
      const result: RequirementsSaveResult = {
        epic, stories: documents.map((story) => ({ id: String(story._id), key: story.storyKey, title: story.title })),
      };
      await this.db.collection("audit_logs").insertOne({
        userId: new ObjectId(caller.mongoUserId), role: caller.role, action: "REQUIREMENTS_REVIEW_APPROVED",
        entityType: "REQUIREMENTS", channel: "CHAT", reviewId: review.id, draftDigest: digest(review),
        resultSummary: result, timestamp: now,
      }, { session });
      await this.states().updateOne({ _id: threadId, revision: review.id }, { $set: { result } }, { session });
      return result;
    });
  }
}

export async function getRequirementsReviewService() {
  const client = await getMongoClient();
  return new RequirementsReviewService(client.db(getDbName()), (work) =>
    client.withSession((session) => session.withTransaction(() => work(session))),
  );
}
