import { COLLECTION_SCHEMAS } from "@/src/config/schema-registry";
import { getRolePolicy } from "@/src/security/policy";
import { nativeOperations } from "@/src/security/mongo-policy";
import type { AgentName, CollectionSchema, Role } from "@/src/types";

export function schemaContext(agent: AgentName, role: Role): string {
  const policy = getRolePolicy(agent, role);
  const sections = Object.entries(policy).map(([collection, rule]) => {
    const schema = COLLECTION_SCHEMAS[collection as keyof typeof COLLECTION_SCHEMAS] as CollectionSchema | undefined;
    if (!schema || !rule) return "";

    const fields = Object.entries(schema.fields)
      .map(([name, config]) => `${name}:${config.type}${config.queryable === false ? "[no-filter]" : ""}${config.selectable === false ? "[no-select]" : ""}`)
      .join(", ");
    const virtual = Object.entries(schema.virtualFields ?? {})
      .map(([name, config]) => `${name}:${config.type}`)
      .join(", ");
    const relationships = Object.entries(schema.relationships ?? {})
      .map(([from, to]) => `${from}->${to}`)
      .join(", ");
    const needsReview = rule.creationReview;
    const operations = [...nativeOperations(agent, role, collection), ...rule.ops.filter((op) =>
      !["find", "find_one", "count"].includes(op) && !(needsReview && ["insert_one", "insert_many"].includes(op)))];

    return [
      `COLLECTION ${collection}`,
      `operations=${operations.join("|")}`,
      needsReview ? "creation=preview_requirements_draft followed by the PM's Approve and save button; direct inserts are blocked" : "",
      `scope=${rule.scope}`,
      `fields=${fields}`,
      virtual ? `businessServiceAliases(eq/ne filters; mutable aliases also work in fieldsJson)=${virtual}` : "",
      relationships ? `relationships=${relationships}` : "",
      rule.mutableFields?.length ? `mutableFields=${rule.mutableFields.join("|")}` : "mutableFields=NONE",
      rule.mutableFields?.includes("assignee")
        ? 'assignment=Use fieldsJson [{"field":"assignee","stringValue":"<name, email, userKey or ObjectId>"}]. The backend resolves the user and stores assigneeId; direct users collection access is unnecessary. Try the supplied identity with the tool before reporting a user missing.'
        : "",
      collection === "tasks" && rule.mutableFields?.includes("blocked")
        ? 'mutationInstructions=blocked (booleanValue) and blockerReason (stringValue) are valid tool mutation fields. The backend translates them to blocker.blocked and blocker.reason, manages blocker.blockedAt, and sets status=BLOCKED when blocked=true. Use these tool fields in fieldsJson; do not use stored dotted paths for mutations.'
        : "",
    ].filter(Boolean).join("\n");
  });

  return "Stored fields allow filtering and selection unless marked [no-filter] or [no-select]. Virtual aliases are for business services only, never native reads.\n" + sections.join("\n\n");
}
