const { test } = require("node:test");
const assert = require("node:assert/strict");
const database = require("../src/db/mongodb.ts");
const models = require("../src/agent/model.ts");
const { routeAgent } = require("../src/agent/router.ts");
const { AGENT_INFO, ROLE_AGENT_ACCESS } = require("../src/config/agent-registry.ts");

const lead = { mongoUserId: "aaaaaaaaaaaaaaaaaaaaaaaa", userKey: "u-el-1", name: "Lead", role: "ENGINEERING_LEAD", active: true };
const coffee = "tell me procedure to make a cup of coffee";
function fixture(t, selected = "OUT_OF_SCOPE") {
  const session = { lastAgent: "SPRINT_TASK" };
  const prompts = [], writes = [], schemas = [];
  t.mock.method(database, "getDb", async () => ({ collection(name) {
    assert.equal(name, "chat_sessions", "an unrelated question must not read business collections");
    return {
      async findOne() { return session; },
      async updateOne(filter, update) { writes.push({ filter, update }); Object.assign(session, update.$set); },
    };
  } }));
  t.mock.method(models, "getRouterModel", () => ({ withStructuredOutput(schema) {
    schemas.push(schema);
    return { async invoke(messages) { prompts.push(messages); return { agent: selected, reason: "Fixture classification" }; } };
  } }));
  t.mock.method(models, "getModel", () => { throw new Error("Out-of-scope responses must not invoke a specialist model"); });
  return { session, prompts, writes, schemas };
}
function forbidSpecialistAndReviews(t) {
  const specialists = require("../src/agent/specialist-agent.ts");
  const reviews = require("../src/services/requirements-review.service.ts");
  t.mock.method(specialists, "runSpecialistAgent", async () => { throw new Error("Unrelated questions must not invoke a specialist or its tools"); });
  t.mock.method(reviews, "getRequirementsReviewService", async () => { throw new Error("Unrelated questions must not start or invalidate a draft review"); });
  return require("../src/agent/supervisor.ts");
}

test("The router can classify the coffee question as OUT_OF_SCOPE without replacing the previous specialist", async (t) => {
  const f = fixture(t);
  f.session.lastAgent = "DOCUMENTATION";
  assert.equal(await routeAgent(lead, "coffee", coffee), "OUT_OF_SCOPE");
  assert.equal(f.writes.length, 0);
  assert.equal(f.session.lastAgent, "DOCUMENTATION");
  assert.equal(f.schemas[0].safeParse({ agent: "OUT_OF_SCOPE", reason: "Unrelated" }).success, true);
  assert.equal(f.prompts[0].at(-1).content, coffee);
  assert.match(f.prompts[0][0].content, /'Tell me procedure to make a cup of coffee' is OUT_OF_SCOPE/);
  assert.match(f.prompts[0][0].content, /not a fallback for unrelated questions/);
});

test("Chat explains its workspace scope for unrelated questions for every role without business tools", async (t) => {
  const f = fixture(t);
  const { runChat, WORKSPACE_SCOPE_RESPONSE } = forbidSpecialistAndReviews(t);
  for (const role of ["PRODUCT_MANAGER", "ENGINEERING_LEAD", "DEVELOPER", "QA"]) {
    const result = await runChat({ caller: { ...lead, role }, sessionId: "unrelated", message: coffee });
    assert.equal(result.agent, "OUT_OF_SCOPE");
    assert.equal(result.response, WORKSPACE_SCOPE_RESPONSE);
    assert.match(result.response, /requirements, sprints and tasks, bugs and QA, releases, and internal documentation/);
    assert.doesNotMatch(result.response, /Not documented|documentation task|boil|brew/i);
    assert.deepEqual(result.trace, []);
  }
  assert.equal(f.writes.length, 0);
  assert.equal(Object.keys(AGENT_INFO).length, 5);
  assert.ok(Object.values(ROLE_AGENT_ACCESS).every((agents) => !agents.includes("OUT_OF_SCOPE")));
});

test("An unrelated detour preserves routing for a subsequent ID-only reply", async (t) => {
  const f = fixture(t);
  await routeAgent(lead, "detour", coffee);
  assert.equal(await routeAgent(lead, "detour", "bbbbbbbbbbbbbbbbbbbbbbbb"), "SPRINT_TASK");
  assert.equal(f.prompts.length, 1, "the ID reply keeps its specialist without consulting the model");
  assert.equal(f.writes.length, 1);
  assert.equal(f.session.lastAgent, "SPRINT_TASK");
});

test("Stored internal guides remain documentation requests even when their topic is coffee", async (t) => {
  const f = fixture(t, "DOCUMENTATION");
  assert.equal(await routeAgent(lead, "internal", "Find our office coffee-machine guide"), "DOCUMENTATION");
  assert.match(f.prompts[0][0].content, /stored internal guide or policy is DOCUMENTATION/);
  assert.equal(f.session.lastAgent, "DOCUMENTATION");
  const { systemPrompt } = require("../src/agent/specialist-agent.ts");
  assert.match(systemPrompt("DOCUMENTATION", lead), /If a workspace documentation search returns no relevant document, say exactly 'Not documented'/);
});

test("Mixed requests retain their product-engineering action", async (t) => {
  const f = fixture(t, "RELEASE");
  assert.equal(await routeAgent(lead, "mixed", "Show release v2.4 blockers and tell me how to make coffee"), "RELEASE");
  assert.match(f.prompts[0][0].content, /Mixed requests with a workspace action should route to its specialist/);
});

test("Unrelated questions leave an active PM draft untouched", async (t) => {
  const f = fixture(t);
  const { runChat } = forbidSpecialistAndReviews(t);
  const review = { id: "bbbbbbbbbbbbbbbbbbbbbbbb", featureTitle: "CSV import", draft: { featureRequestId: "cccccccccccccccccccccccc", epic: { title: "CSV import", description: "Import CSV files" }, stories: [] } };
  const original = JSON.stringify(review);
  const result = await runChat({ caller: { ...lead, role: "PRODUCT_MANAGER" }, sessionId: "pending-draft", message: coffee, requirementsReview: review });
  assert.equal(result.agent, "OUT_OF_SCOPE");
  assert.equal(result.requirementsReviewUnchanged, true);
  assert.equal(result.requirementsReview, undefined, "the UI should keep its existing card instead of displaying a second review");
  assert.equal(JSON.stringify(review), original);
  assert.match(f.prompts[0][0].content, /unsaved requirements draft/);
  assert.equal(f.writes.length, 0);
});

test("Pending draft follow-ups still route to Requirements", async (t) => {
  const f = fixture(t, "REQUIREMENTS");
  assert.equal(await routeAgent({ ...lead, role: "PRODUCT_MANAGER" }, "draft", "Make the acceptance criteria more specific", true), "REQUIREMENTS");
  assert.equal(f.session.lastAgent, "REQUIREMENTS");
  assert.match(f.prompts[0][0].content, /Previous specialist agent in this session: REQUIREMENTS/);
});

test("The scope branch cannot bypass the PM-only review check", async (t) => {
  const f = fixture(t);
  const { runChat } = forbidSpecialistAndReviews(t);
  await assert.rejects(runChat({ caller: lead, sessionId: "forbidden-review", message: coffee, requirementsReview: { id: "untrusted" } }), /REVIEW_PM_ONLY/);
  assert.equal(f.prompts.length, 0);
});

test("The chat API returns a normal scope response with no action trace", async (t) => {
  fixture(t);
  forbidSpecialistAndReviews(t);
  const users = require("../src/repositories/user.repository.ts");
  t.mock.method(users, "resolveCaller", async () => lead);
  const { POST } = require("../app/api/chat/route.ts");
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: lead.userKey, sessionId: "coffee-api", message: coffee }) }));
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.agent, "OUT_OF_SCOPE");
  assert.match(json.response, /outside my product-engineering workspace scope/);
  assert.deepEqual(json.trace, []);
});

test("Other invented routes remain rejected", async (t) => {
  const f = fixture(t, "GENERAL");
  await assert.rejects(routeAgent(lead, "unknown", coffee), /ROUTER_SELECTED_FORBIDDEN_AGENT:GENERAL/);
  assert.equal(f.writes.length, 0);
});
