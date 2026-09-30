import type { Caller } from "@/src/types";

export function safeSessionId(value: string): string {
  const sessionId = value.trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) throw new Error("INVALID_SESSION_ID");
  return sessionId;
}

export function chatThreadId(caller: Caller, sessionId: string): string {
  return `user_${caller.mongoUserId}_session_${safeSessionId(sessionId)}`;
}
