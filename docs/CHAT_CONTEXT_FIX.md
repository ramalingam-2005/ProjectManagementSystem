# Chat lists, request size and task assignment fixes

## Reported behavior

After listing epics and user stories, the Engineering Lead asked:

> for user login intergration create tasks

Groq rejected the request with HTTP 413: 8,716 requested tokens exceeded the
8,000-token allowance. The history window counted messages, so large earlier
tables and database results were repeatedly sent to the model. The story list
also stopped at 25 records, and the generated tables merged their headings.

The Engineering Lead also reported that assigning TASK-207 to Rahul Kumar
incorrectly requested a MongoDB ID. Supplying the quoted ID switched the
conversation to Requirements, which refused access to tasks.

"Show all tasks in Sprint 14" also bypassed the simple-list handler. The model
repeated unfiltered sprint lookups (returning Sprint 8) and printed tool-call XML
instead of retrieving and displaying tasks.

An unrelated question, "tell me procedure to make a cup of coffee", returned
"Not documented" because the router had to select one of the five specialists.
The word "procedure" sent the request to the stored-document-only specialist.

Groq documents an 8,000-token-per-minute free-plan limit for the configured
GPT-OSS models; organization-specific limits are available in its console.
See [Groq rate limits](https://console.groq.com/docs/rate-limits).

## Changes

- Model input has an estimated size budget covering the prompt, tool definitions,
  current turn and relevant history excerpts. Stored history remains intact.
- Current tool calls/results remain paired. Completed mutations are not replayed
  when an oversized model invocation is retried with less context.
- Simple lists use the guarded database tool directly, including permissions,
  record scopes, 25-record pages and audits. Tables have separate header cells.
- Lists fetch up to 500 records. A larger or interrupted list is explicitly
  marked incomplete. No model calls are needed to list records.
- Numbered sprint task lists resolve the exact `sprintNumber`, then retain the
  returned `sprintId` filter on every task page. Both reads enforce existing
  role scopes. Missing, inaccessible or ambiguous sprints stop task retrieval.
  Tables include the stored assignee ID; no access to user records is added.
- Printed or malformed tool calls are never executed or returned as answers.
  The shared answering step uses actual tool evidence, with an explicit
  unfinished-work fallback if it cannot produce a valid response.
- Viewing records does not begin or invalidate a PM draft review.
- The router can return `OUT_OF_SCOPE` for unrelated questions. The supervisor
  then returns a fixed explanation of supported workspace topics with no
  specialist, business-tool or draft-service invocation. This routing outcome
  adds no specialist permissions. It preserves the previous specialist and any
  active draft review, including whether its approval controls were stale.
- Explicit requests for stored internal guides still route to Documentation,
  even when their topic is coffee. `Not documented` remains the response to an
  in-scope documentation search with no relevant results.
- HTTP 413/429 responses show readable messages instead of raw provider errors.
- Task creation still requires a source story approved by a Product Manager.
- Explicit task assignments route to Sprint/Task; ID-only replies retain the
  previous permitted specialist.
- Assignment instructions describe the existing name resolver. Engineering
  Leads can use the assignee alias while the service enforces team scope.
- Business-action tool descriptions specify typed values and the required
  condition operator. Invalid input identifies the failing field path.
- Per-minute quota retries allow waits up to 30 seconds. Daily exhaustion and
  longer waits are surfaced to the caller.
- All agents now compact arbitrary JSON tool results using shared table columns
  and references to repeated values. This first pass is reversible and retains
  every record. It does not depend on a query, collection or calculation metric.
- If the planning context still exceeds the budget, a smaller answering step
  uses the collected evidence with tools disabled. Read-result omissions are
  marked; mutation receipts are protected. Completed database actions are not
  repeated, and a failed final model call still returns confirmed receipts.

## Verification

- `npm test`: **181 tests passed**, including the original 50 additional cases,
  database recovery, numbered sprint lists, sprint creation, scope routing and malformed tool-call regressions.
- `npm run typecheck`: passed.
- `npm run build`: passed, including TypeScript and production page generation.
- A live replay used MongoDB and the configured `openai/gpt-oss-120b` model, with
  session state, checkpoints and audit entries kept in memory. Business writes
  were blocked by the diagnostic wrapper.
- "show all the epics": **10 epics**, no model calls.
- "show all user stories": **76 stories across four pages**, no model calls.
- The exact task request routed to Sprint/Task and completed without HTTP 413.
  Model input estimates ranged from **3,687 to 4,068 tokens**.
- The live response identified "User login integration" as **DRAFT** and explained
  that a Product Manager must approve the story before tasks can be created.
  No business records were changed during verification.
- A live assignment replay listed **58 tasks across three pages**, then processed
  `assign task-207 to rahul kumar`. The model used the `assignee` alias, and the
  backend resolved it to `6aba3de4d6f922d2386934bc` with the correct task/team filter.
  Exactly one update was intercepted and simulated; the database was not changed.
- An automated graph regression reproduces an older conversation requesting an
  ID, then supplies the exact quoted ID and verifies one permitted task update.
  Unknown users, missing condition operators and forbidden roles are also covered.
- The Sprint 14 workload request was replayed after listing tasks. The backend
  calculation returned all **10 developers**; the shared answering step completed
  without a context error and identified Aditya Rao at **18 assigned / 8 capacity**.
  No business writes were allowed during this replay.
- Generic context tests also cover Requirements, Bug, Release and Documentation,
  repeated subsets, nested records, reserved JSON keys, Unicode, partial read
  results and failure after a confirmed write. Full source evidence remains intact.
- The Sprint 14 list regression uses an in-memory database through the chat graph
  and guarded read service, with model calls disabled. It returns 27 permitted
  tasks across two pages, excludes Sprint 8 and other-team tasks, and verifies
  developer OWN scope, PM/QA access, missing/duplicate sprints and page failures.
  This regression does not query or modify the live database.
- A live router check classified the exact coffee question as `OUT_OF_SCOPE`
  and "Find our office coffee-machine guide" as `DOCUMENTATION`. All database
  access in that check used an in-memory fixture. Scope regressions also cover
  all four roles, the chat API, mixed requests, ID follow-ups and pending drafts.

The input estimate is conservative rather than an exact tokenizer count. Provider
usage limits still apply to requests that need the model.
