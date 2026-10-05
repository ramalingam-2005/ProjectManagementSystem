# Sprint creation contract and scheduling

`insert_one` requires `fieldsJson`: a JSON string encoding an array of
`FieldChange` objects. `documentsJson` is reserved for `insert_many`, where each
document has a `fields` array. Missing, empty or mixed insert payloads now fail
before dispatch with an actionable error for the agent. The executor also checks
the distinction for direct callers.

An Engineering Lead can request “create Sprint 15” with this tool input:

```json
{
  "collection": "sprints",
  "operation": "insert_one",
  "fieldsJson": "[{\"field\":\"sprintNumber\",\"numberValue\":15},{\"field\":\"name\",\"stringValue\":\"Sprint 15\"},{\"field\":\"status\",\"stringValue\":\"PLANNED\"}]",
  "reason": "Create Sprint 15"
}
```

The backend selects Sprint 14 within the caller's existing scope. Sprint 15 starts
at 00:00 UTC on the calendar day after Sprint 14's end date and ends at
23:59:59.999 UTC on its fourteenth day. For a predecessor ending October 11,
the resulting dates are October 12–25. Month/year boundaries and leap days are
handled using UTC date arithmetic.

Creation rejects model-supplied dates and velocity. The backend supplies
`PLANNED`, zero velocity, timestamps, caller ownership and an empty capacities
list; it does not guess the team's capacity. Creator access keeps the new sprint
visible to its Engineering Lead before capacity planning. Existing team-member
scope remains available for older sprints.

Missing, inaccessible or duplicate predecessor records stop creation. A missing
end date produces a question about the preceding sprint's end date. An existing
sprint number within scope is rejected before insertion. This is a sequential
duplicate check, not a database uniqueness constraint across concurrent requests.
Creating the first sprint still requires an existing predecessor schedule; this
change does not add a separate bootstrap scheduling workflow.

Tool results separate internal correction guidance from a plain-language
`userMessage`. Only known failures before execution are eligible for payload
repair. The normal tool loop can correct them; if the model instead asks the user
to repair JSON, the graph gives it one additional correction attempt. A remaining
validation failure returns the plain-language message and any confirmed earlier
mutation receipts. Database/uncertain execution failures are not labeled safe
for this automatic correction.

Regression coverage in `tests/sprint-creation.test.cjs` uses an in-memory database
and model stubs. It exercises the real tool/executor and graph, including the
reported wrong `documentsJson` call followed by exactly one successful insertion.
No live sprint records are created by these tests.

Validation: `npm test` passes all 171 tests; `npm run typecheck` passes. The
context-recovery regression also verifies that size-error retries send a smaller
request and retain confirmed mutations without replaying them.
