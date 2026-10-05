import type { AgentName } from "@/src/types";
import type { MongoReadAction } from "@/src/db/mongo-action";

type Column = readonly [field: string, label: string];
export interface RecordListIntent {
  collection: string;
  label: string;
  agents: AgentName[];
  columns: Column[];
  sprintNumber?: number;
}

const LISTS: Record<string, RecordListIntent> = {
  "feature requests": { collection: "feature_requests", label: "Feature requests", agents: ["REQUIREMENTS"], columns: [["featureRequestKey", "Feature Key"], ["title", "Title"], ["priority", "Priority"], ["status", "Status"]] },
  epics: { collection: "epics", label: "Epics", agents: ["REQUIREMENTS"], columns: [["epicKey", "Epic Key"], ["title", "Title"], ["featureRequestId", "Feature Request ID"], ["status", "Status"]] },
  "user stories": { collection: "user_stories", label: "User stories", agents: ["REQUIREMENTS", "SPRINT_TASK"], columns: [["storyKey", "Story Key"], ["title", "Title"], ["epicId", "Epic ID"], ["storyPoints", "Points"], ["priority", "Priority"], ["status", "Status"]] },
  sprints: { collection: "sprints", label: "Sprints", agents: ["SPRINT_TASK"], columns: [["sprintNumber", "Sprint"], ["name", "Name"], ["status", "Status"], ["startDate", "Start"], ["endDate", "End"]] },
  tasks: { collection: "tasks", label: "Tasks", agents: ["SPRINT_TASK"], columns: [["taskKey", "Task Key"], ["title", "Title"], ["storyPoints", "Points"], ["priority", "Priority"], ["status", "Status"]] },
  bugs: { collection: "bugs", label: "Bugs", agents: ["BUG"], columns: [["bugKey", "Bug Key"], ["title", "Title"], ["severity", "Severity"], ["status", "Status"]] },
  "test cases": { collection: "test_cases", label: "Test cases", agents: ["BUG"], columns: [["testCaseKey", "Test Case Key"], ["title", "Title"], ["module", "Module"], ["active", "Active"]] },
  releases: { collection: "releases", label: "Releases", agents: ["RELEASE"], columns: [["version", "Version"], ["status", "Status"], ["updatedAt", "Updated"]] },
  documents: { collection: "documents", label: "Documents", agents: ["DOCUMENTATION"], columns: [["title", "Title"], ["type", "Type"], ["version", "Version"], ["status", "Status"]] },
};

export function recordListIntent(message: string): RecordListIntent | undefined {
  const normalized = message.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
  // Match the entire request so extra filters or actions cannot be discarded.
  const sprintTasks = normalized.match(/^(?:please )?(?:show|list|display|get)(?: me)? (?:all )?(?:the )?tasks (?:in|for) (?:the )?sprint (?:#\s*)?(\d+)(?: please)?[.!?]*$/);
  if (sprintTasks) {
    const sprintNumber = Number(sprintTasks[1]);
    if (!Number.isSafeInteger(sprintNumber)) return undefined;
    return {
      ...LISTS.tasks, label: `Tasks in Sprint ${sprintNumber}`, sprintNumber,
      columns: [...LISTS.tasks.columns.slice(0, 2), ["assigneeId", "Assignee ID"], ...LISTS.tasks.columns.slice(2)],
    };
  }
  const entity = normalized.match(/^(?:please )?(?:show|list|display|get)(?: me)? (?:all )?(?:the )?([a-z ]+?)(?: please)?[.!?]*$/)?.[1];
  return entity && Object.hasOwn(LISTS, entity) ? LISTS[entity] : undefined;
}

export const MAX_LIST_RECORDS = 500;

function readFailure(label: string, error: string = ""): string {
  return /COLLECTION_NOT_ALLOWED|OPERATION_NOT_ALLOWED|USER_INACTIVE/.test(error)
    ? `Your account does not have permission to list ${label.toLowerCase()}.`
    : `I couldn't retrieve ${label.toLowerCase()}. Please try again.`;
}

function cell(value: unknown): string {
  if (value === undefined || value === null) return "—";
  // Character references render as literal text, including pipes and URL
  // punctuation that GFM would otherwise reinterpret as columns or formatting.
  return String(value).replace(/\s+/g, " ").replace(/[&\\|`*_\[\]{}()<>#!:.@]/g, (char) => `&#${char.charCodeAt(0)};`);
}

// Pagination and formatting are deterministic. Each page still goes through the
// same guarded tool, record scopes, response limits and audit as a model read.
export async function readRecordList(intent: RecordListIntent, invoke: (action: MongoReadAction) => Promise<string>): Promise<string> {
  let filter: MongoReadAction["filter"] = {};
  if (intent.sprintNumber !== undefined) {
    const label = `Sprint ${intent.sprintNumber}`;
    const output = JSON.parse(await invoke({
      collection: "sprints", operation: "find", filter: { sprintNumber: intent.sprintNumber },
      projection: { _id: 1, name: 1, sprintNumber: 1 }, sort: { _id: 1 }, limit: 2,
    }));
    if (!output.ok) return readFailure(intent.label, output.error);
    const matches = output.result.items;
    if (!matches.length) return `${label} was not found within your access.`;
    if (matches.length > 1 || output.result.hasMore) {
      return `Multiple sprints match ${label} within your access. Please specify a sprint ID.\n\n`
        + matches.map((sprint: Record<string, unknown>) => `- ${cell(sprint.name)}: ${cell(sprint._id)}`).join("\n");
    }
    // Never fall back to an unfiltered task read if sprint resolution fails.
    if (typeof matches[0]._id !== "string" || !/^[a-f0-9]{24}$/i.test(matches[0]._id)) return readFailure(intent.label);
    filter = { sprintId: matches[0]._id };
  }
  const rows: Record<string, unknown>[] = [];
  let skip = 0;
  let complete = false;
  let failure = false;
  while (rows.length < MAX_LIST_RECORDS) {
    const output = JSON.parse(await invoke({
      collection: intent.collection, operation: "find", filter,
      projection: Object.fromEntries([ ["_id", 1], ...intent.columns.map(([field]) => [field, 1]) ]),
      sort: { _id: 1 }, limit: 25, skip,
    }));
    if (!output.ok) {
      if (!rows.length) return readFailure(intent.label, output.error);
      failure = true;
      break;
    }
    const page = output.result;
    rows.push(...page.items);
    if (!page.hasMore) { complete = true; break; }
    if (!Number.isSafeInteger(page.nextSkip) || page.nextSkip <= skip) break;
    skip = page.nextSkip;
  }
  if (!rows.length) return `No ${intent.label.toLowerCase()} were found within your access.`;
  const table = [
    `| ${intent.columns.map(([, label]) => label).join(" | ")} |`,
    `| ${intent.columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${intent.columns.map(([field]) => cell(row[field])).join(" | ")} |`),
  ].join("\n");
  const footer = complete ? `Listed all ${rows.length} records available to your account.`
    : failure ? "The remaining records could not be loaded. This list is incomplete."
      : `Showing the first ${rows.length} records. More records are available; narrow the request to see a smaller set.`;
  return `### ${intent.label} (${rows.length})\n\n${table}\n\n${footer}`;
}
