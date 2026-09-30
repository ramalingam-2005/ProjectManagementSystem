import { routeAgent } from "@/src/agent/router";
import { runSpecialistAgent } from "@/src/agent/specialist-agent";
import type { Caller } from "@/src/types";

function safeSessionId(value: string): string {
  const sessionId = value.trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) throw new Error("INVALID_SESSION_ID");
  return sessionId;
}

export async function runChat(input: {
  caller: Caller;
  sessionId: string;
  message: string;
}) {
  const sessionId = safeSessionId(input.sessionId);
  const message = input.message.trim();
  if (!message) throw new Error("MESSAGE_REQUIRED");
  if (message.length > 4000) throw new Error("MESSAGE_TOO_LONG");

  const agent = await routeAgent(input.caller, sessionId, message);
  const threadId = `user_${input.caller.mongoUserId}_session_${sessionId}`;
  const result = await runSpecialistAgent({
    agent,
    caller: input.caller,
    threadId,
    message,
  });

  return {
    agent,
    threadId,
    response: result.response,
    trace: result.trace,
  };
}
