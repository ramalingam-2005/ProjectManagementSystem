import type { AgentTrace, Caller } from "@/src/types";
import type { MongoReadAction } from "@/src/db/mongo-action";

export function isBugCountRequest(message: string): boolean {
  // Only an unfiltered total. Open/high/release-specific counts and compound
  // requests still go through the specialist's normal structured query path.
  return /^(?:please\s+)?(?:how many (?:total )?bugs(?: are there)?|count (?:all |the )?bugs|(?:what is |what's )?(?:the )?(?:total )?(?:number|count) of bugs)(?: (?:in|across) (?:the |this )?(?:system|workspace))?[?.!]?$/i.test(message.trim());
}

export async function readBugCount(caller: Caller, invoke: (action: MongoReadAction) => Promise<string>): Promise<string> {
  const output = JSON.parse(await invoke({ collection: "bugs", operation: "countDocuments", filter: {} }));
  if (!output.ok || !Number.isSafeInteger(output.result?.count)) return "I couldn't retrieve the bug count. No total is available for this request.";
  const count = output.result.count;
  const scope = caller.role === "DEVELOPER" ? "assigned to you" : "across the workspace";
  return `There ${count === 1 ? "is" : "are"} **${count} ${count === 1 ? "bug" : "bugs"}** ${scope}, including all statuses.`;
}

const plain = (value: unknown) => String(value ?? "").replace(/[<>`*_\[\]\\|]/g, "").replace(/\s+/g, " ").trim();

export function bugCreationReceipt(traces: AgentTrace[]): string | undefined {
  const writes = traces.filter((trace) => /^(insert|update)_/.test(String((trace.generatedAction as { operation?: unknown })?.operation)));
  if (writes.length !== 1 || traces.at(-1) !== writes[0] || traces.some((trace) => (trace.result as { ok?: boolean })?.ok === false)) return undefined;
  const action = writes[0].generatedAction as { collection?: string; operation?: string };
  const result = writes[0].result as { ok?: boolean; result?: { document?: Record<string, unknown>; linkedTestExecution?: { testCaseKey: string; releaseVersion: string; attempt: number } } };
  const bug = result.result?.document;
  if (action.collection !== "bugs" || action.operation !== "insert_one" || !result.ok || !bug?.bugKey || bug.status !== "NEW" || bug.assigneeId != null) return undefined;
  const link = result.result?.linkedTestExecution;
  return `Created **${plain(bug.bugKey)} — ${plain(bug.title)}**.\n\nStatus: **NEW**. Unassigned and visible to all Engineering Leads for developer assignment.`
    + (link ? `\n\nLinked to **${plain(link.testCaseKey)}**, release **${plain(link.releaseVersion)}**, attempt **${link.attempt}**.` : "");
}
