import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { encodeToolContent } from "@/src/agent/tool-context";

// Conservative estimate, not a provider tokenizer. Reserve room for tool framing
// and the 1,800-token completion within the deployment's 8,000-token allowance.
export const MODEL_INPUT_TOKEN_BUDGET = 5_000;

export function messageType(message: BaseMessage): string {
  return message.getType?.() ?? message._getType?.() ?? "";
}

export function textContent(message: BaseMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => typeof part === "string" ? part
    : "text" in part ? String(part.text ?? "") : "").join("\n");
}

export function estimateRequestTokens(messages: BaseMessage[], tools: unknown[] = []): number {
  const data = messages.map((message) => ({
    role: messageType(message), content: message.content, name: message.name,
    ...(messageType(message) === "ai" ? { tool_calls: (message as AIMessage).tool_calls } : {}),
    ...(messageType(message) === "tool" ? { tool_call_id: (message as ToolMessage).tool_call_id } : {}),
  }));
  return Math.ceil(Buffer.byteLength(JSON.stringify({ messages: data, tools }), "utf8") / 3) + 100;
}

function excerpt(text: string, latest: string): string {
  if (text.length <= 1_600) return text;
  const terms = [...new Set(latest.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [])]
    .filter((term) => !["show", "all", "the", "for", "create", "list", "please", "tasks", "stories"].includes(term));
  const lines = text.split("\n").filter((line) => line.trim());
  const relevant = lines.map((line, index) => ({ line, index, score: terms.filter((term) => line.toLowerCase().includes(term)).length }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 6).sort((a, b) => a.index - b.index);
  return relevant.map(({ line }) => line).join("\n").slice(0, 1_540) + "\n[Earlier response excerpt; remaining content omitted.]";
}

function compactValue(value: unknown, maxItems: number, maxText: number, depth = 0, arrayDepth = 0): unknown {
  if (typeof value === "string") return value.length > maxText ? value.slice(0, maxText) + "... [truncated]" : value;
  if (depth > 8) return "[nested content omitted]";
  if (Array.isArray(value)) {
    // Keep every top-level row before shortening nested detail arrays. Numeric
    // and boolean fields remain intact; shortened strings are marked above.
    const limit = arrayDepth === 0 ? Infinity : maxItems;
    const items = value.slice(0, limit).map((item) => compactValue(item, maxItems, maxText, depth + 1, arrayDepth + 1));
    return value.length > limit ? [...items, { omittedItems: value.length - limit }] : items;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, compactValue(item, maxItems, maxText, depth + 1, arrayDepth)]));
  return value;
}

function compactToolMessage(message: BaseMessage, maxItems?: number, maxText?: number, preserve = false): BaseMessage {
  if (messageType(message) !== "tool") return message;
  const tool = message as ToolMessage;
  const content = textContent(tool);
  let compacted: string;
  try {
    const value = JSON.parse(content);
    const result = preserve || maxItems === undefined || maxText === undefined ? value : compactValue(value, maxItems, maxText);
    compacted = encodeToolContent(JSON.stringify(result), JSON.stringify(result) !== JSON.stringify(value));
  } catch {
    compacted = !preserve && maxText !== undefined && content.length > maxText
      ? content.slice(0, maxText) + "\n[Tool result excerpt; remaining content omitted.]" : content;
  }
  if (compacted === content) return message;
  return new ToolMessage({ content: compacted, tool_call_id: tool.tool_call_id, name: tool.name, status: tool.status });
}

export function prepareModelMessages(prompt: string, history: BaseMessage[], tools: unknown[] = [], budget = MODEL_INPUT_TOKEN_BUDGET, options: { allowTruncation?: boolean } = {}): BaseMessage[] {
  const latestIndex = history.findLastIndex((message) => messageType(message) === "human");
  if (latestIndex < 0) throw new Error("MODEL_CONTEXT_REQUIRES_USER_MESSAGE");
  const latest = textContent(history[latestIndex]);
  const system = new SystemMessage(prompt);
  let current = history.slice(latestIndex);
  const readOnlyIds = new Set(current.flatMap((message) => messageType(message) === "ai"
    ? ((message as AIMessage).tool_calls ?? []).filter((call) => ["find", "findOne", "countDocuments", "aggregate", "calculate"].includes(call.args.operation)).map((call) => call.id)
    : []));
  // Try a reversible encoding before dropping any evidence. This also removes
  // repeated records that appear in both a result list and a summary subset.
  if (estimateRequestTokens([system, ...current], tools) > budget) {
    current = current.map((message) => compactToolMessage(message));
  }
  // Never cut the latest instruction or split tool call/result pairs. Only the
  // model-facing copy of oversized tool content is shortened; traces stay full.
  for (const [items, chars] of [[10, 500], [3, 200], [1, 100]]) {
    if (options.allowTruncation === false) break;
    if (estimateRequestTokens([system, ...current], tools) <= budget) break;
    current = history.slice(latestIndex).map((message) => compactToolMessage(message, items, chars,
      messageType(message) === "tool" && !readOnlyIds.has((message as ToolMessage).tool_call_id)));
  }
  if (estimateRequestTokens([system, ...current], tools) > budget) throw new Error("MODEL_CONTEXT_TOO_LARGE");

  // Historical tool names belong to their previous specialist. Pass excerpts of
  // at most two completed turns instead of old calls, database pages and tables.
  const previous: BaseMessage[][] = [];
  for (let end = latestIndex; end > 0 && previous.length < 2;) {
    let start = end - 1;
    while (start >= 0 && messageType(history[start]) !== "human") start--;
    if (start < 0) break;
    const answer = history.slice(start + 1, end).findLast((message) => messageType(message) === "ai" && !(message as AIMessage).tool_calls?.length);
    const turn: BaseMessage[] = [new HumanMessage(excerpt(textContent(history[start]), latest))];
    if (answer) turn.push(new AIMessage("Earlier response (historical; verify current records):\n" + excerpt(textContent(answer), latest)));
    previous.unshift(turn);
    end = start;
  }
  while (previous.length && estimateRequestTokens([system, ...previous.flat(), ...current], tools) > budget) previous.shift();
  return [system, ...previous.flat(), ...current];
}
