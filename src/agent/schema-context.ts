import { COLLECTION_SCHEMAS, listSelectableFields } from "@/src/config/schema-registry";
import { getRolePolicy } from "@/src/security/policy";
import type { AgentName, CollectionSchema, Role } from "@/src/types";

export function schemaContext(agent: AgentName, role: Role): string {
  const policy = getRolePolicy(agent, role);
  const sections = Object.entries(policy).map(([collection, rule]) => {
    const schema = COLLECTION_SCHEMAS[collection as keyof typeof COLLECTION_SCHEMAS] as CollectionSchema | undefined;
    if (!schema || !rule) return "";

    const fields = Object.entries(schema.fields)
      .map(([name, config]) => `${name}:${config.type}`)
      .join(", ");
    const virtual = Object.entries(schema.virtualFields ?? {})
      .map(([name, config]) => `${name}:${config.type}(virtual)`)
      .join(", ");
    const relationships = Object.entries(schema.relationships ?? {})
      .map(([from, to]) => `${from}->${to}`)
      .join(", ");

    return [
      `COLLECTION ${collection}`,
      `purpose=${schema.description}`,
      `operations=${rule.ops.join("|")}`,
      `scope=${rule.scope}`,
      `fields=${fields}`,
      `selectableFields=${listSelectableFields(collection).join("|")} (selectFieldsCsv for find/find_one only; omit on mutations)`,
      virtual ? `virtualFilters=${virtual}` : "",
      relationships ? `relationships=${relationships}` : "",
      rule.mutableFields?.length ? `mutableFields=${rule.mutableFields.join("|")}` : "mutableFields=NONE",
      collection === "tasks" && rule.mutableFields?.includes("blocked")
        ? 'mutationInstructions=blocked (booleanValue) and blockerReason (stringValue) are valid tool mutation fields. The backend translates them to blocker.blocked and blocker.reason, manages blocker.blockedAt, and sets status=BLOCKED when blocked=true. Use these tool fields in fieldsJson; do not use stored dotted paths for mutations.'
        : "",
    ].filter(Boolean).join("\n");
  });

  return sections.join("\n\n");
}
