import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { isBugCountRequest } from "@/src/agent/bug-response";
import { z } from "zod";
import { AGENT_INFO, ROLE_AGENT_ACCESS } from "@/src/config/agent-registry";
import { getDb } from "@/src/db/mongodb";
import { getRouterModel } from "@/src/agent/model";
import { getAllowedCollections } from "@/src/security/policy";
import { nativeOperations } from "@/src/security/mongo-policy";
import { recordListIntent } from "@/src/agent/record-list";
import { withModelRetry } from "@/src/utils/retry";
import type { AgentName, Caller, ChatRoute } from "@/src/types";

const RouteSchema = z.object({
  agent: z.enum(["REQUIREMENTS", "SPRINT_TASK", "BUG", "RELEASE", "DOCUMENTATION", "OUT_OF_SCOPE"]),
  reason: z.string(),
});

function explicitListAgent(caller: Caller, message: string, allowed: AgentName[]): AgentName | undefined {
  // Match complete supported list requests, including tasks in a numbered sprint.
  // Other filters, documentation questions and ambiguous follow-ups use the router.
  const route = recordListIntent(message);
  if (!route) return undefined;
  const candidates = route.agents.filter((agent) => allowed.includes(agent));
  // Prefer a specialist with an existing read grant (developer stories use OWN
  // scope through SPRINT_TASK). If none has a grant, the owning specialist must
  // explain the refusal; routing never creates collection permissions.
  return candidates.find((agent) => nativeOperations(agent, caller.role, route.collection).includes("find")) ?? candidates[0];
}

export async function routeAgent(caller: Caller, sessionId: string, message: string, reviewInProgress = false): Promise<ChatRoute> {
  const allowed = ROLE_AGENT_ACCESS[caller.role];

  const db = await getDb();
  const sessionKey = `${caller.mongoUserId}:${sessionId}`;
  let agent: ChatRoute | undefined = reviewInProgress ? undefined : explicitListAgent(caller, message, allowed);
  if (!agent && !reviewInProgress && allowed.includes("BUG") && isBugCountRequest(message)) agent = "BUG";
  if (!agent && allowed.includes("SPRINT_TASK") && /^(?:please\s+)?(?:assign|reassign)\s+task-[a-z0-9]+\s+to\s+\S/i.test(message.trim())) {
    agent = "SPRINT_TASK";
  }
  if (!agent) {
    const session = await db.collection("chat_sessions").findOne(
      { sessionKey },
      { projection: { lastAgent: 1 } },
    );
    const lastAgent = reviewInProgress && allowed.includes("REQUIREMENTS") ? "REQUIREMENTS"
      : allowed.includes(session?.lastAgent as AgentName) ? session?.lastAgent as AgentName : undefined;
    // An identifier supplied in reply to a specialist's question belongs to
    // that specialist. The ID itself provides no topic for the model to route.
    const identifierOnly = /^(?:[a-f0-9]{24}|"[a-f0-9]{24}"|'[a-f0-9]{24}'|`[a-f0-9]{24}`)$/i.test(message.trim());
    if (identifierOnly && lastAgent) {
      agent = lastAgent;
    } else {
      const routeDescriptions = allowed.map((name) =>
        `${name}: ${AGENT_INFO[name].purpose} Permitted collections: ${getAllowedCollections(name, caller.role).join(", ")}.`,
      ).join("\n");
      const router = getRouterModel().withStructuredOutput(RouteSchema);
      const result = await withModelRetry(() => router.invoke([
        new SystemMessage([
          "You are a supervisor router for a product engineering chatbot.",
          `Authenticated role: ${caller.role}.`,
          `Allowed agents: ${allowed.join(", ")}.`,
          lastAgent ? `Previous specialist agent in this session: ${lastAgent}. Use it for ambiguous follow-ups when appropriate.` : "",
          "Choose one allowed specialist for product-engineering workspace requests, or OUT_OF_SCOPE for unrelated requests. OUT_OF_SCOPE has no tools or database access; never invent another route.",
          "OUT_OF_SCOPE includes everyday questions without a workspace connection: making coffee, cooking recipes, vacation plans, entertainment or general trivia. 'Tell me procedure to make a cup of coffee' is OUT_OF_SCOPE, even after a documentation conversation. Words like procedure, guide or how-to do not by themselves make a request internal documentation.",
          "An explicit request to find a stored internal guide or policy is DOCUMENTATION even if its topic mentions coffee (e.g. 'Find our office coffee-machine guide'). Mixed requests with a workspace action should route to its specialist; do not discard that action because an unrelated topic is also present.",
          reviewInProgress ? "An unsaved requirements draft is awaiting PM review. Keep in-scope draft edits and follow-ups with REQUIREMENTS; unrelated questions remain OUT_OF_SCOPE and must not revise the draft." : "",
          "Route by the latest user message. An explicit new topic takes priority over the previous specialist. Use the previous specialist only for an ambiguous follow-up that does not identify a new topic.",
          "Requests to view/list stored feature requests, epics or user stories belong to REQUIREMENTS, including approved and existing records. For developer user-story reads use SPRINT_TASK, which applies OWN scope. Listing backlog records is not documentation search.",
          "Creating, assigning or reassigning engineering tasks belongs to SPRINT_TASK, including tasks for a user story. REQUIREMENTS handles the story itself, not engineering tasks.",
          "DOCUMENTATION is for stored workspace documents, internal guides, policies and product-engineering processes. Choose it for a guide about writing user stories, but choose REQUIREMENTS for the actual story records. It is not a fallback for unrelated questions.",
          routeDescriptions,
        ].filter(Boolean).join("\n")),
        new HumanMessage(message),
      ]));
      agent = result.agent;
    }
  }
  // An unrelated detour must not replace the specialist used for ID replies or
  // begin/invalidate a draft review. No specialist or business tool runs for it.
  if (agent === "OUT_OF_SCOPE") return agent;
  if (!allowed.includes(agent)) throw new Error(`ROUTER_SELECTED_FORBIDDEN_AGENT:${agent}`);
  if (reviewInProgress) {
    if (!allowed.includes("REQUIREMENTS")) throw new Error("REVIEW_PM_ONLY");
    agent = "REQUIREMENTS";
  }

  await db.collection("chat_sessions").updateOne(
    { sessionKey },
    {
      $set: {
        sessionKey,
        userId: caller.mongoUserId,
        role: caller.role,
        lastAgent: agent,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  return agent;
}
