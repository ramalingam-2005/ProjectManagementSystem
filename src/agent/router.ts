import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { AGENT_INFO, ROLE_AGENT_ACCESS } from "@/src/config/agent-registry";
import { getDb } from "@/src/db/mongodb";
import { getRouterModel } from "@/src/agent/model";
import { getAllowedCollections } from "@/src/security/policy";
import { nativeOperations } from "@/src/security/mongo-policy";
import { recordListIntent } from "@/src/agent/record-list";
import { withModelRetry } from "@/src/utils/retry";
import type { AgentName, Caller } from "@/src/types";

const RouteSchema = z.object({
  agent: z.enum(["REQUIREMENTS", "SPRINT_TASK", "BUG", "RELEASE", "DOCUMENTATION"]),
  reason: z.string(),
});

function explicitListAgent(caller: Caller, message: string, allowed: AgentName[]): AgentName | undefined {
  // Match complete, simple list requests only. Questions about documentation,
  // filtered lists, draft creation and ambiguous follow-ups still use the router.
  const route = recordListIntent(message);
  if (!route) return undefined;
  const candidates = route.agents.filter((agent) => allowed.includes(agent));
  // Prefer a specialist with an existing read grant (developer stories use OWN
  // scope through SPRINT_TASK). If none has a grant, the owning specialist must
  // explain the refusal; routing never creates collection permissions.
  return candidates.find((agent) => nativeOperations(agent, caller.role, route.collection).includes("find")) ?? candidates[0];
}

export async function routeAgent(caller: Caller, sessionId: string, message: string): Promise<AgentName> {
  const allowed = ROLE_AGENT_ACCESS[caller.role];
  if (allowed.length === 1) return allowed[0];

  const db = await getDb();
  const sessionKey = `${caller.mongoUserId}:${sessionId}`;
  let agent = explicitListAgent(caller, message, allowed);
  if (!agent && allowed.includes("SPRINT_TASK") && /^(?:please\s+)?(?:assign|reassign)\s+task-[a-z0-9]+\s+to\s+\S/i.test(message.trim())) {
    agent = "SPRINT_TASK";
  }
  if (!agent) {
    const session = await db.collection("chat_sessions").findOne(
      { sessionKey },
      { projection: { lastAgent: 1 } },
    );
    const lastAgent = allowed.includes(session?.lastAgent as AgentName) ? session?.lastAgent as AgentName : undefined;
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
          "Choose exactly one allowed specialist agent. Never choose an agent outside the allowed list.",
          "Route by the latest user message. An explicit new topic takes priority over the previous specialist. Use the previous specialist only for an ambiguous follow-up that does not identify a new topic.",
          "Requests to view/list stored feature requests, epics or user stories belong to REQUIREMENTS, including approved and existing records. For developer user-story reads use SPRINT_TASK, which applies OWN scope. Listing backlog records is not documentation search.",
          "Creating, assigning or reassigning engineering tasks belongs to SPRINT_TASK, including tasks for a user story. REQUIREMENTS handles the story itself, not engineering tasks.",
          "DOCUMENTATION is for stored documents, guides, policies and process explanations. Choose it for a guide about writing user stories, but choose REQUIREMENTS for the actual story records.",
          routeDescriptions,
        ].filter(Boolean).join("\n")),
        new HumanMessage(message),
      ]));
      agent = result.agent as AgentName;
    }
  }
  if (!allowed.includes(agent)) throw new Error(`ROUTER_SELECTED_FORBIDDEN_AGENT:${agent}`);

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
