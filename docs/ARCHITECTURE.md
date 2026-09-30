# Architecture

## Agent boundaries

### Requirements Agent
- PM: feature-request triage; AI-assisted DRAFT epic/story generation; edit/approve stories.
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

## Why raw MongoDB is not exposed

A model-generated action is untrusted input. The service compiles only an allow-listed action language. Delete/drop/aggregate/JavaScript operators are not exposed. OWN and ASSIGNED scopes are injected server-side from the authenticated MongoDB user.

## Shared UI/chat service path

```text
UI button/form -> API -> application/database service -> guardrails -> MongoDB
Chat -> LLM -> guarded tool adapter -> same application/database service -> guardrails -> MongoDB
```

The AI only interprets natural language and selects an action. It does not own business authorization.

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
