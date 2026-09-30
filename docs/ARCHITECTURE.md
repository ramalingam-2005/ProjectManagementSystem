# Architecture

## Agent boundaries

### Requirements Agent
- PM: feature-request triage; preview and revise AI-generated epics/stories; explicitly approve insertion as DRAFT; separately approve saved stories for engineering.
- EL: read requirements and stories; create/update engineering epics.
- Developer / QA: may submit own feature requests only.

### Sprint / Task Agent
- EL: sprint planning, task creation/assignment/rebalancing, team workload.
- Developer: own task reads and own status/blocker updates; own workload only.
- PM / QA: read-only sprint/task visibility where the project permission matrix allows it.

### Bug Agent
- QA: test/bug management and verification.
- Developer: raise bugs; assigned bug reads; mark assigned bug FIX_READY.
- EL: team bug visibility and reassignment.
- PM: read-only bug/test visibility.

### Release Agent
- EL: release engineering records and readiness.
- PM: read + PM scope sign-off only.
- QA: read + QA test sign-off only.
- Developer: read-only release visibility.

### Documentation Agent
- PM / EL / Developer / QA: grounded document search.

## Dynamic action flow

Each specialist gets only its permitted schema and one guarded database tool.
The PM Requirements Agent additionally receives `preview_requirements_draft`. Direct PM inserts into `epics` and `user_stories` are refused by the shared authorization guard.
The **LLM-facing schema is flat** for Groq reliability. Nested conditions are passed as a JSON string:

```json
{
  "collection": "feature_requests",
  "operation": "find",
  "conditionsJson": "[{\"field\":\"priority\",\"operator\":\"eq\",\"stringValue\":\"HIGH\"}]",
  "limit": 10,
  "reason": "PM asked for high-priority requests"
}
```

The backend parses that JSON string and validates it against Zod, the collection schema, role policy, scope rules and business rules before any MongoDB operation runs.

`find` reads are paginated. Oversized numeric limits are capped at 25 by the backend, so a model request such as `limit: 100` reaches the application instead of failing provider schema validation. Each result includes `offset`, `limit`, `hasMore` and `nextOffset`. Subsequent pages reuse the same filters and sort. Sorting includes `_id` as a unique tie-breaker; offset pagination is not a snapshot, so concurrent changes to matching records can still affect page membership. Offsets beyond 10,000 require narrower filters. Each page independently applies the caller's record scope, and write limits remain enforced.

## Why raw MongoDB is not exposed

A model-generated action is untrusted input. The service compiles only an allow-listed action language. Delete/drop/aggregate/JavaScript operators are not exposed. OWN and ASSIGNED scopes are injected server-side from the authenticated MongoDB user.

## Shared UI/chat service path

```text
UI button/form -> API -> application/database service -> guardrails -> MongoDB
Chat -> LLM -> guarded tool adapter -> same application/database service -> guardrails -> MongoDB
```

The AI only interprets natural language and selects an action. It does not own business authorization.

## PM approval before insertion

```text
Read feature -> generate preview -> PM reviews
                                   -> request changes -> replacement preview
                                   -> discard
                                   -> Approve and save -> transaction -> DRAFT records
```

The preview tool validates a complete draft and stores only ownership, revision, expiry and a digest in `requirements_reviews`. The browser receives the draft for display. Existing MongoDB chat checkpoints continue to hold conversation/tool history.

Sending a revision request invalidates the previous approval. The model cannot grant approval; the browser sends an explicit action to `POST /api/requirements/review`. The service checks the current PM role, conversation, revision and digest before saving exactly the reviewed fields. New records always have DRAFT status and server-controlled ownership, timestamps and public keys.

Approval uses a MongoDB transaction for the epic, stories, audit and save receipt. Retries return the receipt without repeating inserts. Existing epics must belong to the selected feature and are left unchanged. References are checked again during approval. These controls depend on the existing caller resolver and do not replace production authentication.

## Deterministic calculations

The Sprint/Task agent can request:
- `developer_workload`
- `sprint_overload_summary`

The backend computes capacity and assigned story points.

The Release agent can request:
- `release_readiness`

The backend computes readiness evidence, score/band, blockers and sign-off state. The LLM only explains the returned calculation.

## Tool-level safety

The guardrail checks:

```text
role
 -> agent
 -> collection
 -> operation
 -> condition fields
 -> record scope
 -> mutable fields
 -> bulk limits
 -> business transition rules
```

Rejected tool actions are written to `audit_logs`.
