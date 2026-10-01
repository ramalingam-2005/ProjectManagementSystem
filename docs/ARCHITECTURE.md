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

## Shared native MongoDB reads

All five agents use the same database tool and service entry point. Reads use native structured MongoDB data:

```json
{
  "collection": "feature_requests",
  "operation": "find",
  "filter": { "priority": "HIGH" },
  "projection": { "featureRequestKey": 1, "title": 1 },
  "sort": { "createdAt": -1 },
  "limit": 25,
  "skip": 0
}
```

The common path validates JSON shape, agent/role permissions, registry fields, recursive filter operators, and every aggregation stage before executing any data query. Native operations are find, findOne, countDocuments and aggregate. Aggregation permits approved $lookup stages, including recursively validated nested pipelines. Every joined collection receives its own scope filter and safe output projection. Model-generated JavaScript is never executed.

The existing policy remains authoritative. Native findOne/countDocuments names map to existing find_one/count grants; aggregation requires the existing find grant on the base collection and each lookup target. Collection grants, mutable fields and record scopes are preserved. PM creation review is represented by creationReview in the centralized policy.

Find returns at most 25 records, with skip, hasMore and nextSkip. Limits above 25 are rejected. Aggregate appends an independent server limit and also bounds client consumption. Queries have a 5-second server execution limit, and aggregations disable disk spill. Output is restricted to registry-approved fields and bounded to 1 MB. Offset pagination is not a snapshot.

Mutations and business calculations retain their existing typed condition/field contracts and business services. Native update objects, delete/drop operations, JavaScript expressions, and unapproved stages/operators are rejected. Reads never use the old condition-to-filter mapper. Text and keyword matching now use native filters proposed by the model; there is no automatic title substitution or externally maintained feature mapping.

See [the implementation report](NATIVE_MONGODB_REFACTOR.md) for schema, examples, recursive validation, limits, verification and remaining restrictions.

## Shared UI/chat service path

```text
UI button/form -> API -> application/database service -> guardrails -> MongoDB
Chat -> LLM -> guarded tool adapter -> same application/database service -> guardrails -> MongoDB
```

The AI only interprets natural language and selects an action. It does not own business authorization.

Simple record-list requests such as "show all user stories" select the owning
specialist before model routing. Requirements handles PM/EL story lists; developer
story lists use Sprint/Task with the existing OWN scope. The selected specialist
is saved for follow-ups. Filtered requests, drafting, documentation questions and
ambiguous follow-ups still use the model router, which receives each specialist's
permitted collections. Collection permissions and record scopes remain enforced
by the database service.

Explicit task assignments select Sprint/Task. An ID-only reply, including a
quoted MongoDB ID, retains the previous permitted specialist. The assignee
mutation alias accepts a name, email, userKey or ObjectId; the backend resolves
the user without granting the assistant access to the users collection.
The tool schema documents the required condition operator and typed values;
malformed input reports the invalid field path before execution.

`tests/routing.test.cjs` covers the Engineering Lead story-list regression,
role-specific routing, documentation questions, follow-ups and paginated reads
through the chat service with a mocked database.

Simple list requests run through the guarded database tool in 25-record pages
and render tables directly from returned records. The display cap is 500 records;
larger or interrupted lists explicitly report that they are incomplete. These
requests use no model calls and do not begin or invalidate PM draft reviews.
The rendered response is still saved in the conversation checkpoint.

## Model context size

The model receives a compact schema and a request budget of 5,000 estimated input
tokens, including tool definitions. The estimate uses UTF-8 payload size with
headroom for the 1,800-token output allowance; it is not a provider tokenizer.
At most two earlier turns contribute short excerpts selected for relevance to
the latest request. Historical tool calls/results are omitted from model input.

The latest user instruction is preserved verbatim. Current tool calls stay paired
with their results. When results are large, every agent first uses a reversible
JSON representation: repeated object keys become table columns and repeated
values use JSON Pointer references. This works on arbitrary tool data and retains
every record and value. Full original results stay in traces and checkpoints.

If the planning context still cannot fit, the agent answers from collected
evidence with tools disabled and a short prompt that omits tool schemas. This
step may shorten long read-result strings and nested arrays, marking omissions;
top-level records and their numeric/boolean fields are retained. Mutation results and
unknown action results are never shortened. The answer identifies incomplete
evidence and unfinished actions. If the model still fails, confirmed mutation
receipts remain visible in the response. An oversized initial instruction can
still be rejected before execution.

A provider 413 retries only the rejected model invocation with a smaller budget.
It does not restart the graph or repeat completed database actions. The chat API
returns readable messages for size and quota errors without provider JSON or
organization details. Transient model retries accept requested waits up to 30
seconds; daily exhaustion and longer waits return immediately from this retry
layer. `tests/model-context.test.cjs` covers these behaviors,
table rendering, pagination and the approved-story task prerequisite.
`tests/context-budget.test.cjs` verifies reversible packing, reserved keys,
Unicode, complete record coverage, protected receipts and recovery through
all five specialist graphs. Context recovery has no query-text or metric-specific
branches.

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
