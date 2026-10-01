# 50 additional test cases

Checked on 2026-10-01 with Node.js v22.15.0.

**Result: all 50 new cases passed. The full suite, including subsequent chat regressions, passes all 130 tests with no failures, skips or cancellations.**

TypeScript checking (`npm run typecheck`) also passed.

Implementation: [acceptance-50.test.cjs](../tests/acceptance-50.test.cjs).

## Run

From the directory containing `package.json`:

```powershell
npm run test:50
npm test
npm run typecheck
```

The cases exercise real validation, authorization, executor and route-handler code.
Database calls use a recording driver stub; review API cases replace caller and
service dependencies. No live MongoDB or Groq credentials are required. These
checks do not establish live database behavior, model response quality or browser
interaction behavior.

## Issue found and fixed

TC27 exposed a projection validation error: `{ description: 0, _id: 1 }` was
rejected as a mixed projection. MongoDB permits explicitly including `_id` in an
exclusion projection. The validator now accepts that form while continuing to
reject mixed inclusion/exclusion for ordinary fields. TC26–TC28 cover those
boundaries, and TC27 checks both find and aggregate validation.
See [MongoDB projection rules](https://www.mongodb.com/docs/v7.0/reference/method/db.collection.find/).

## Cases

Each row is an independently named test. Every row passed in the final full run.

| ID | Area | Input or action | Expected result |
| --- | --- | --- | --- |
| TC01 | Drafts | Surround epic title and criterion text with spaces | Trim parsed text; preserve input |
| TC02 | Drafts | Add stories to an existing epic | Accept without a new epic |
| TC03 | Drafts | Propose a new epic with no stories | Accept epic-only draft |
| TC04 | Drafts | Supply new epic and existing epic ID | Reject ambiguous draft |
| TC05 | Drafts | Supply stories without an epic | Reject missing parent |
| TC06 | Drafts | Select existing epic with no new stories | Reject empty change |
| TC07 | Drafts | Submit five then six stories | Accept five; reject six |
| TC08 | Drafts | Submit no criteria or a blank criterion | Reject both |
| TC09 | Drafts | Submit fifteen then sixteen criteria | Accept fifteen; reject sixteen |
| TC10 | Drafts | Use 0, 100 and 2.5 story points | Accept integer boundaries; reject fraction |
| TC11 | Sessions | Trim a valid eighty-character ID | Return normalized ID |
| TC12 | Sessions | Submit an eighty-one-character ID | Reject ID |
| TC13 | Sessions | Submit a path-like ID | Reject before creating thread |
| TC14 | Sessions | Reuse a session name with another caller | Produce distinct thread IDs |
| TC15 | Permissions | Developer updates task status and blocker | Authorize with OWN scope |
| TC16 | Permissions | Developer changes task assignee | Reject immutable field |
| TC17 | Permissions | QA changes developer fix summary | Reject immutable field |
| TC18 | Permissions | PM submits QA signoff | Reject wrong signoff field |
| TC19 | Permissions | QA submits PM signoff | Reject wrong signoff field |
| TC20 | Permissions | Lead changes generatedByAI | Reject system metadata change |
| TC21 | Permissions | Authorized mutation has no filter | Reject unbounded update |
| TC22 | Permissions | Inactive account reads or updates | Reject both actions |
| TC23 | Queries | Add operator keys to an ObjectId literal | Reject malformed literal |
| TC24 | Queries | Supply an ISO date with month 13 | Reject invalid date |
| TC25 | Queries | Supply a string for blocker.blocked | Reject invalid boolean |
| TC26 | Queries | Include title and exclude _id | Return only title projection |
| TC27 | Queries | Exclude description and include _id | Accept safe find and aggregate projections |
| TC28 | Queries | Include title and exclude description | Reject mixed ordinary fields |
| TC29 | Queries | Add limit to countDocuments | Reject paging on counts |
| TC30 | Queries | Add skip to findOne | Reject paging on single-record read |
| TC31 | Queries | Add top-level filter to aggregate | Require filter in pipeline |
| TC32 | Queries | Add pipeline to find | Reject incompatible query shape |
| TC33 | Queries | Supply regex options without pattern | Reject incomplete predicate |
| TC34 | Queries | Use title as a lookup output alias | Reject stored-field collision |
| TC35 | Queries | Match and project an unwind index | Preserve numeric alias in output |
| TC36 | Queries | Compute output from an unselectable field | Reject field access |
| TC37 | Execution | Find returns no rows | Return terminal page, close cursor, audit success |
| TC38 | Execution | Default page receives eleven rows | Return ten, expose next page, add _id sort |
| TC39 | Execution | findOne returns no record | Return null and audit success |
| TC40 | Execution | Developer counts with an empty OR branch | Inject ownership outside the OR |
| TC41 | Execution | Cursor throws a connection error | Close cursor, sanitize error, audit failure |
| TC42 | Execution | findOne returns over 1 MB | Withhold payload and audit failure |
| TC43 | Review API | Send malformed JSON | HTTP 400 before caller/service resolution |
| TC44 | Review API | Omit explicit action | HTTP 400 before caller/service resolution |
| TC45 | Review API | Add a client-supplied role | HTTP 400 before caller/service resolution |
| TC46 | Review API | Caller resolution reports inactive account | HTTP 403 without service access |
| TC47 | Review API | Caller resolution reports missing account | HTTP 404 without approval attempt |
| TC48 | Review API | Approval service reports stale review | HTTP 409 with fresh-preview guidance |
| TC49 | Review API | Save service throws connection error | HTTP 500 with safe retry guidance |
| TC50 | Review API | Discard a valid review | Call discard only with caller's thread |
