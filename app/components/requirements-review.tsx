import type { RequirementsReview } from "@/src/requirements-review";

export function RequirementsReviewCard({ review, active, busy, needsRefresh, onApprove, onEdit, onDiscard }: {
  review: RequirementsReview;
  active: boolean;
  busy: boolean;
  needsRefresh: boolean;
  onApprove: () => void;
  onEdit: () => void;
  onDiscard: () => void;
}) {
  const { draft } = review;
  return (
    <section className="requirements-review" aria-label="Review epic and user stories">
      <div className="review-heading"><h3>Review your draft</h3><span>{active ? "Awaiting your approval" : "Review closed or replaced"}</span></div>
      <p><strong>Feature:</strong> {review.featureTitle}</p>
      {draft.epic ? <div className="review-epic"><h4>New epic: {draft.epic.title}</h4><p>{draft.epic.description}</p></div>
        : <p><strong>Existing epic:</strong> {review.existingEpicTitle}</p>}
      {draft.stories.map((story, index) => <section className="review-story" key={index}>
        <h4>{index + 1}. {story.title}</h4>
        <p>{story.userStory}</p>
        <p className="review-meta">{story.storyPoints} story points · {story.priority} priority</p>
        <strong>Acceptance criteria</strong>
        <ul>{story.acceptanceCriteria.map((criterion, criterionIndex) => <li key={criterionIndex}>{criterion}</li>)}</ul>
      </section>)}
      {active && <>
        <p className="review-note">Approval saves the displayed epic and stories as DRAFT. You can request changes before saving.</p>
        {needsRefresh && <p role="status">A fresh preview is needed before approval. Describe your changes below.</p>}
        <div className="review-actions">
          <button className="primary" disabled={busy || needsRefresh} onClick={onApprove}>Approve and save</button>
          <button className="secondary" disabled={busy} onClick={onEdit}>Request changes</button>
          <button className="secondary" disabled={busy} onClick={onDiscard}>Discard</button>
        </div>
      </>}
    </section>
  );
}
