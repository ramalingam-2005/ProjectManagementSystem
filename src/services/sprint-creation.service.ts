import type { Document, Filter } from "mongodb";
import { getDb } from "@/src/db/mongodb";
import { MONGO_LIMITS } from "@/src/security/mongo-policy";
import { SprintCreationError } from "@/src/utils/business-action-errors";

const DAY_MS = 24 * 60 * 60 * 1000;

// Called only after authorization. The supplied scope is server-derived and
// must also constrain duplicate detection and the predecessor lookup.
export async function prepareSprintInsert(fields: Record<string, unknown>, scope: Filter<Document>): Promise<Record<string, unknown>> {
  const number = fields.sprintNumber;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new SprintCreationError("SPRINT_NUMBER_REQUIRED", "What positive whole-number sprint number should I create?");
  }
  if ("startDate" in fields || "endDate" in fields) {
    throw new SprintCreationError("SPRINT_DATES_MANAGED", `I couldn't create Sprint ${number} because the supplied dates conflict with automatic two-week scheduling.`, "Omit startDate and endDate from fieldsJson. The backend derives both dates from the preceding sprint; retry the corrected creation action.");
  }
  if ("velocity" in fields) {
    throw new SprintCreationError("SPRINT_VELOCITY_MANAGED", "New sprints start with velocity zero. The backend sets this automatically.", "Omit velocity from fieldsJson; the backend sets it to zero. Retry the corrected creation action.");
  }
  if (fields.status !== undefined && fields.status !== "PLANNED") {
    throw new SprintCreationError("SPRINT_INITIAL_STATUS", "New sprints must be created as PLANNED before they can be started.");
  }
  if (fields.name !== undefined && (typeof fields.name !== "string" || !fields.name.trim())) {
    throw new SprintCreationError("SPRINT_NAME_REQUIRED", `What name should I use for Sprint ${number}?`);
  }
  const sprints = (await getDb()).collection("sprints");
  const options = { projection: { _id: 1, endDate: 1 }, maxTimeMS: MONGO_LIMITS.maxTimeMS };
  if (await sprints.findOne({ $and: [{ sprintNumber: number }, scope] }, options)) {
    throw new SprintCreationError("SPRINT_ALREADY_EXISTS", `Sprint ${number} already exists within your access. No new sprint was created.`);
  }
  const previous = await sprints.find({ $and: [{ sprintNumber: number - 1 }, scope] }, options).limit(2).toArray();
  if (previous.length !== 1) {
    throw new SprintCreationError("SPRINT_PREDECESSOR_REQUIRED", previous.length
      ? `I couldn't create Sprint ${number} because more than one Sprint ${number - 1} is available. Resolve the duplicate sprint numbers first.`
      : `I couldn't create Sprint ${number} because Sprint ${number - 1} was not found within your access. Its schedule is needed to determine the new sprint's dates.`);
  }
  const previousEnd = previous[0].endDate;
  if (!(previousEnd instanceof Date) || !Number.isFinite(previousEnd.getTime())) {
    throw new SprintCreationError("SPRINT_PREDECESSOR_DATE_REQUIRED", `I couldn't determine Sprint ${number}'s dates. What is Sprint ${number - 1}'s end date?`);
  }
  const startDate = new Date(previousEnd);
  startDate.setUTCHours(0, 0, 0, 0);
  startDate.setUTCDate(startDate.getUTCDate() + 1);
  const endDate = new Date(startDate.getTime() + 14 * DAY_MS - 1);
  if (!Number.isFinite(endDate.getTime())) {
    throw new SprintCreationError("SPRINT_PREDECESSOR_DATE_REQUIRED", `Sprint ${number - 1}'s end date is outside the supported range. Correct it before creating Sprint ${number}.`);
  }
  return { sprintNumber: number, name: fields.name ?? `Sprint ${number}`, status: "PLANNED", startDate, endDate, velocity: 0, capacities: [] };
}
