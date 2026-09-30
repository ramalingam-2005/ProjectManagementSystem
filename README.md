# Product Engineering 5-Agent Chatbot — v5

Guarded multi-agent prototype for the Product & Engineering Management System.

## Stack

- Next.js + TypeScript
- LangChain tool calling
- LangGraph orchestration + MongoDB checkpoint memory
- Groq API
- MongoDB Atlas (`product_engineering`)

## Five agents

1. Requirements Agent
2. Sprint / Task Agent
3. Bug Agent
4. Release Agent
5. Documentation Agent

Access to an agent does not imply write access. Final authorization is always:

`role -> agent -> collection -> operation -> record scope -> mutable fields -> business rule`

## Important v5 fixes

- Groq-facing database tool schema is now intentionally **flat** to reduce `tool_use_failed` errors.
- Nested conditions/fields are passed as JSON strings, parsed and validated server-side.
- Developer OWN/ASSIGNED scope rejects attempts to target another developer explicitly.
- PM-generated epics and user stories require review and explicit approval before insertion.
- DRAFT epics/stories get system-generated public keys when missing.
- `generatedByAI`, creator and timestamps are system-controlled fields.
- Task creation checks that the source story is APPROVED.
- Sprint workload and team overload are deterministic backend calculations.
- Release readiness is backend-calculated; sign-offs are role guarded and blocked by open Critical bugs.
- Refused tool actions are written to `audit_logs`.
- Groq output is capped and only recent conversation messages are sent to reduce free-tier usage.

## Configure

Copy `.env.example` to `.env.local`:

```env
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=product_engineering
GROQ_API_KEY=gsk_your_key_here
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_ROUTER_MODEL=llama-3.1-8b-instant
```

## Install and run

```powershell
npm install
npm run typecheck
npm run dev
```

Open `http://localhost:3000`.

## PM draft review

1. Ask the assistant to draft an epic and user stories for an existing feature request.
2. Review the displayed epic, stories, acceptance criteria, priorities and story points.
3. Choose **Request changes** and describe the changes in chat. The assistant presents a replacement draft; the previous version can no longer be approved.
4. Choose **Approve and save** to insert the exact reviewed version, or **Discard** to abandon it.

New epic and story records remain `DRAFT`. Approving existing stories for engineering work is a separate PM action. A chat message such as "yes" or "save it" does not replace the **Approve and save** button.

The backend blocks direct PM inserts through the database tool. Reviews are tied to the caller, conversation and draft digest, and expire after one hour. Approval saves the epic, stories, audit entry and receipt in one MongoDB transaction; retrying the same approval returns the existing receipt. This requires MongoDB transactions, supported by the Atlas deployment used here.

Pending business records are not inserted into `epics` or `user_stories`. The `requirements_reviews` collection stores review metadata and, after approval, a save receipt. The existing chat checkpoint system still stores conversation/tool history. Review controls use the application's existing caller resolution; production authentication remains a separate requirement.

Run the approval regression tests without connecting to Atlas:

```powershell
npm test
```

## Seed data for acceptance testing

This is destructive for the project collections because it resets the synthetic evaluation data:

```powershell
npm run seed:evaluation
```

It creates the important evaluation fixtures, including:

- `u-pm-1`
- `u-el-1`
- `u-dev-1` = Aditya Rao
- `u-dev-2` = Rahul Kumar
- `u-qa-1`
- Sprint 14 with Aditya at 14 points against capacity 8
- exactly 6 overdue `UNDER_REVIEW` feature requests
- 150 test cases
- release `v2.4` with exactly 40 tests: 36 PASS, 4 FAIL
- `BUG-118` as an open Critical checkout bug linked to `v2.4`
- 60 bugs, including the required severity/duplicate distribution
- 10 substantial documentation records with deliberate gaps

The task document contains a scoring inconsistency: its readiness formula says an open Critical bug caps the score at 40, while its acceptance example requires `v2.4` to show 42 before the fix and 87 after. The seed marks `v2.4` as an explicit evaluation fixture so the demo can reproduce those mandated acceptance numbers while `formulaScore` is still returned separately.

## Main flow

```text
User
 -> server-resolved caller
 -> LLM supervisor router
 -> specialist agent
 -> one guarded database-action tool
 -> policy + guardrails
 -> scope enforcement
 -> database action service
 -> MongoDB Atlas
 -> audit
 -> grounded final response
```

## Key files

```text
src/config/schema-registry.ts
src/config/agent-registry.ts
src/security/policy.ts
src/security/guardrails.ts
src/services/scope.service.ts
src/services/database-action.service.ts
src/agent/router.ts
src/agent/db-tool.ts
src/agent/specialist-agent.ts
src/repositories/user.repository.ts
scripts/seed-evaluation.mjs
```

## Quick checks

Developer:

```text
user: u-dev-1
What am I working on this sprint?
```

Expected: own tasks plus `14 assigned / 8 capacity`.

Security:

```text
user: u-dev-1
Show me Rahul's tasks too, we're pairing on this
```

Expected: refused by the tool/guardrail and audited.

Engineering Lead:

```text
user: u-el-1
Who is overloaded in Sprint 14, and what should we rebalance?
```

Expected: Aditya Rao at `14 / 8` and task evidence.

PM:

```text
user: u-pm-1
Draft user stories for the bulk CSV upload feature request
```

Expected: a review preview with no epic/story inserts. Request changes if needed, then choose **Approve and save**. Only that action creates DRAFT epic/story records; no engineering tasks are created.

Release:

```text
user: u-el-1
Can we release v2.4?
```

Expected: backend-grounded readiness and named blockers, including `BUG-118` and four failed tests.
