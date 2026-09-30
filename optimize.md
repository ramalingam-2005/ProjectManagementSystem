# Optimization Plan

Recommended order: **fix existing errors -> secure access -> reduce token usage -> improve performance.**

This plan considers security risk, cost, response quality, scalability, and implementation effort. It records recommendations from the code review; the changes have not been implemented.

## First: fix the existing errors

The TypeScript check run during the review failed because:

- `/api/health` calls `getModel(40)`, but `getModel` accepts no arguments.
- The MongoDB client types conflict with the checkpoint package's MongoDB dependency.
- Release readiness uses `failedTests` before declaring it.

Resolve these issues before measuring improvements.

## Phase 1: Security

| Priority | Recommended step | Finding in this project |
|---|---|---|
| **Critical** | Authenticate users through a verified server session. | The [chat API](app/api/chat/route.ts) trusts a browser-provided `userId`. Knowing another user's ID is enough to select their permissions through this code path. |
| **High** | Apply record permissions to every calculation. | The calculation branch in the [database action service](src/services/database-action.service.ts) runs before the normal scope filter. Workload calculations can query developers outside the caller's team; release calculations return underlying records without applying their normal scopes. |
| **High** | Add request limits and spending controls. | Enforce limits per authenticated user, request deadlines, body-size limits, and a total tool-call budget. Six tool rounds can contain more than six individual actions. |
| **Medium** | Reduce exposed diagnostic data. | Restrict `/api/schema`, sanitize client errors, and return only necessary action details. Full tool results currently reach the browser. |

Keep authorization in the backend and test every role against allowed and forbidden records. This follows [OWASP's authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

## Phase 2: Token usage

1. **Budget history by tokens.**

   [Conversation trimming](src/agent/specialist-agent.ts) targets ten messages, but one tool response can be large. Use a token budget, preserve complete tool-call/result pairs, and retain a compact summary of older context.

2. **Shrink database responses before sending them to the model.**

   Documentation queries can return full document content, while calculations return potentially large task and bug lists. Return relevant excerpts, totals, essential fields, and bounded examples. Calculate totals over all authorized records before limiting the evidence shown.

3. **Skip routing calls for clear requests.**

   Use deterministic routing for explicit commands and recognizable identifiers, with an LLM fallback for ambiguous requests. Validate routing accuracy before expanding these shortcuts.

4. **Use task-specific budgets.**

   Simple reads should have smaller output and action budgets than drafting multiple stories. Preserve enough output space for valid tool arguments. Shorten repeated schema descriptions only after checking tool-call accuracy.

**Quick win:** remove model inference from routine health checks. Every successful health-check path currently invokes Groq.

## Phase 3: Performance and reliability

| Improvement | Why it matters | Tradeoff |
|---|---|---|
| **Batch workload queries** | The sprint summary in the [database action service](src/services/database-action.service.ts) performs two sequential queries per developer. Fetch authorized users and tasks in batches. | Bound result sizes as teams grow. |
| **Add targeted indexes through a separate migration** | Index session lookups and frequent scope/filter combinations. Some indexes currently exist only in the destructive evaluation seed. | Extra indexes consume storage and slow writes; verify with `explain()`. |
| **Consolidate retries** | Model retries and `withModelRetry` overlap, potentially extending failures. Use one bounded policy with jitter, deadlines, and `Retry-After`. | Distinguish temporary failures from invalid tool arguments. |
| **Replace public-key scans with atomic allocation** | Key generation scans existing IDs and can choose duplicates under concurrent requests. Use an atomic counter plus unique indexes. | Add idempotency so repeated requests cannot duplicate business actions. |
| **Stream responses and progress** | The UI currently waits for the complete JSON response. Streaming improves time to visible feedback. | It does not reduce total computation; show mutation success only after confirmation. |

The query and retry recommendations align with [MongoDB's optimization guidance](https://www.mongodb.com/docs/manual/core/query-optimization/) and [Groq's rate-limit guidance](https://console.groq.com/docs/rate-limits).

## Measurement and implementation priorities

Measure success using:

- Tokens per successful task.
- Median and p95 response time.
- Database query time.
- Retry rate.
- Task accuracy.
- Authorization tests for allowed and forbidden operations across roles.

After resolving the TypeScript errors, prioritize **authentication, calculation permissions, health-check cost, and retry control**. Measure before claiming percentage savings.
