# Bug reporting, shared backlog and assignment

QA reports an unassigned bug into a shared workspace backlog visible to every
Engineering Lead. Any lead can assign it to a specific active developer, regardless
of reporting relationships. The developer submits a fix summary; QA verifies the
fix. These rules are enforced in backend services, not just the specialist prompt.

## Creation

New bugs do not contain `teamLeadId`. The assistant does not ask for an owning
lead or team. All Engineering Leads have ALL bug scope for reading, counting and
assignment; assignment still requires an existing active developer.

QA and Developer can report bugs. A new report requires a non-empty title
and a confirmed severity (LOW, MEDIUM, HIGH or CRITICAL).
QA reports additionally require an existing test case and a uniquely selected
recorded execution, as described below.

The backend supplies `status: NEW`, `assigneeId: null`, `reportedBy`, `bugKey`,
and timestamps. Reproduction steps initially default to an empty list. It does
not manufacture a description, component, logs, fix or QA verification. For QA
reports, the product and affected release come from the selected test case/run.
Supplied product/test-case references must exist; test cases respect the caller's
scope. Supplied product and test-case links must agree. Other reporting details
can be supplied by QA later. Developer reports retain their existing optional
test-case reference behavior and do not gain permission to write QA executions.

Example request from QA:

> Report a login button bug. Clicking Login does nothing.
> Severity HIGH. Found in TC-106, release v2.4, attempt 1.
> Steps: open the login page, enter valid credentials, click Login.

Facts and test-case references in examples must match actual observations and records.
The tool uses `insert_one` with `fieldsJson`; the user never supplies tool JSON.
The assistant asks about severity/impact if the user has not supplied it.

## QA test-case execution link

If QA has not identified the test case in the current report, the assistant asks:

> Which test case did you use to find this bug? Please provide its key, such as TC-106.

`sourceTestCase` accepts the exact case key or ID; `sourceTestCaseId` also accepts
the stored ID. The backend rejects inactive, missing or ambiguous cases. It
never derives a case from an unrelated conversation or a similar bug title.

When multiple executions match, QA must identify the affected release and
attempt. `affectedReleaseVersion` and the numeric `testExecutionAttempt` select
the run. If there is only one matching recorded execution, it can be selected
automatically. A case with no executions must have its test run recorded first;
this creation flow does not invent a run or silently pick the latest one.

The backend saves these links in a single MongoDB transaction:

```text
bugs.sourceTestCaseId                       = selected test-case ObjectId
bugs.sourceTestExecutionAttempt             = selected attempt
bugs.affectedReleaseVersion                 = selected execution release
test_cases.executions[index].linkedBugId    = newly created bug ObjectId
```

The bug insert, execution-link update and success audit commit together.
Transaction support is required, as for PM requirements approval (MongoDB Atlas
or another replica-set deployment). A failed insert, link update or audit aborts
the transaction. The execution array is checked against its read snapshot so a
concurrent change cannot redirect the link to another run. A callback retry uses
the same new bug ID. The agent does not replay uncertain transaction outcomes.

Only `linkedBugId` and the test case's `updatedAt` change. Recorded PASS/FAIL,
`testedBy`, `executedAt` and other executions remain intact. An execution already
linked to a bug is rejected without replacing that link or creating a duplicate.
The existing singular `linkedBugId` schema is preserved.

The confirmation includes the saved bug key and linked test-case key, release
and attempt. Generic bug updates cannot change this linkage or its product/release
independently. Historical bug records are not automatically linked to guessed
test cases or executions.

## Assignment and lifecycle

| Actor | Action | Backend result |
| --- | --- | --- |
| QA / Developer | Report a bug | NEW, `assigneeId: null`, no team lead field |
| Any EL | Assign/reassign a specific active developer | ASSIGNED |
| Assigned Developer | Supply a non-empty `fixSummary` | FIX_READY, fixer and timestamp |
| QA | `qaVerificationResult: PASS` after FIX_READY | VERIFIED_CLOSED, verifier and timestamp |
| QA | `qaVerificationResult: FAIL` after FIX_READY or VERIFIED_CLOSED | REOPENED, verifier and timestamp |

QA cannot set either assignment alias, on inserts or updates. Developers cannot
self-assign or transfer a bug. Leads can assign developers across reporting groups,
but cannot assign a QA user, an inactive user or a nonexistent ID. Exact IDs are
validated as well as names, and ambiguous names require clarification.
Assignment is allowed only for NEW, ASSIGNED or REOPENED bugs. Direct status
changes cannot bypass the fix/verification actions. Mutations select exactly
one scoped record and compare its status, assignee and existing update
timestamp before writing, so a concurrent lifecycle change produces a refusal
instead of a stale overwrite.

## Visibility and counts

- QA / PM / every EL see all workspace bugs, assigned and unassigned.
- Developer sees assigned bugs.
- Existing unassigned bugs are immediately visible to every lead.
- Legacy `teamLeadId` fields, if present in old records, are ignored for access
  and assignment. They are no longer exposed by the tool schema or written.

The exact unfiltered request "how many bugs are there" uses `countDocuments`
through the guarded read service, without a model call. Its answer names the
workspace or assigned-record scope and says all statuses are
included. Filtered and compound questions continue through normal model/tool
queries, with instructions to explain the scope.

Single successful bug creation receives a plain confirmation with the bug key,
title, NEW status and the pending EL assignment. The normal multi-action answer
path remains available for compound requests.

## Existing unassigned reports such as BUG-161

Every Engineering Lead can already view an existing unassigned bug. No routing,
ownership backfill or duplicate creation is needed. A lead can request:

> Assign BUG-161 to [developer name].

QA still cannot assign the bug. Old team-lead values do not affect this workflow;
no migration or live business writes are automatically performed by this change.

## Implementation and validation

- `src/services/bug-workflow.service.ts`: report validation, developer
  resolution and operation-specific lifecycle checks.
- `src/services/bug-test-link.service.ts`: required QA case/run resolution and
  execution snapshot; `database-action.service.ts` commits the linked creation.
- `src/security/policy.ts`: QA assignment denied; EL bug access uses ALL for the
  Bug and Release specialists. Developer bug access remains ASSIGNED.
- `src/services/scope.service.ts`: shared policy-driven scope enforcement for
  reads, counts, joined reads and mutation targeting.
- `src/agent/bug-response.ts`: deterministic unfiltered counts and creation receipt.
- `tests/bug-workflow.test.cjs`: 30 regressions covering backend enforcement,
  shared visibility, assignment across reporting groups, invalid assignee refusals,
  races, chat clarification, execution
  selection, link preservation and transaction rollback/retry behavior.

Validation: `npm test` passed all 211 tests; `npm run typecheck` passed. These
checks use in-memory data/model fixtures and do not create or change live bugs.
