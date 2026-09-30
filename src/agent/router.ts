import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { AGENT_INFO, ROLE_AGENT_ACCESS } from "@/src/config/agent-registry";
import { getDb } from "@/src/db/mongodb";
import { getRouterModel } from "@/src/agent/model";
import { withModelRetry } from "@/src/utils/retry";
import type { AgentName, Caller } from "@/src/types";

const RouteSchema = z.object({
  agent: z.enum(["REQUIREMENTS", "SPRINT_TASK", "BUG", "RELEASE", "DOCUMENTATION"]),
  reason: z.string(),
});

export async function routeAgent(caller: Caller, sessionId: string, message: string): Promise<AgentName> {
  const allowed = ROLE_AGENT_ACCESS[caller.role];
  if (allowed.length === 1) return allowed[0];

  const db = await getDb();
  const sessionKey = `${caller.mongoUserId}:${sessionId}`;
  const session = await db.collection("chat_sessions").findOne(
    { sessionKey },
    { projection: { lastAgent: 1 } },
  );
  const lastAgent = allowed.includes(session?.lastAgent as AgentName) ? session?.lastAgent : undefined;

  const routeDescriptions = allowed
    .map((name) => `${name}: ${AGENT_INFO[name].purpose}`)
    .join("\n");

  const router = getRouterModel().withStructuredOutput(RouteSchema);
  const result = await withModelRetry(() => router.invoke([
    new SystemMessage([
      "You are a supervisor router for a product engineering chatbot.",
      `Authenticated role: ${caller.role}.`,
      `Allowed agents: ${allowed.join(", ")}.`,
      lastAgent ? `Previous specialist agent in this session: ${lastAgent}. Use it for ambiguous follow-ups when appropriate.` : "",
      "Choose exactly one allowed specialist agent. Never choose an agent outside the allowed list.",
      "Route by the latest user message. An explicit new topic takes priority over the previous specialist. Use the previous specialist only for an ambiguous follow-up that does not identify a new topic.",
      routeDescriptions,
    ].filter(Boolean).join("\n")),
    new HumanMessage(message),
  ]));

  const agent = result.agent as AgentName;
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
