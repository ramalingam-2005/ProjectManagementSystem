import { ObjectId } from "mongodb";
import { getDb } from "@/src/db/mongodb";
import type { Caller, Role } from "@/src/types";

/**
 * Convert role values already stored in MongoDB into the canonical role names
 * used by the application policy layer.
 *
 * Examples accepted:
 *   "PM", "Product Manager", "product_manager" -> PRODUCT_MANAGER
 *   "EL", "Engineering Lead", "engineering_lead" -> ENGINEERING_LEAD
 *   "Developer", "DEV" -> DEVELOPER
 *   "QA", "QA Engineer", "Quality Assurance" -> QA
 */
export function normalizeRole(rawRole: unknown): Role | null {
  if (typeof rawRole !== "string") return null;

  const normalized = rawRole
    .trim()
    .toUpperCase()
    .replace(/[\s\-\/]+/g, "_")
    .replace(/_+/g, "_");

  const aliases: Record<string, Role> = {
    PM: "PRODUCT_MANAGER",
    PRODUCT_MANAGER: "PRODUCT_MANAGER",
    PRODUCTMANAGER: "PRODUCT_MANAGER",

    EL: "ENGINEERING_LEAD",
    ENGINEERING_LEAD: "ENGINEERING_LEAD",
    ENGINEERINGLEAD: "ENGINEERING_LEAD",

    DEV: "DEVELOPER",
    DEVELOPER: "DEVELOPER",
    SOFTWARE_DEVELOPER: "DEVELOPER",

    QA: "QA",
    QA_ENGINEER: "QA",
    QUALITY_ASSURANCE: "QA",
    QUALITY_ASSURANCE_ENGINEER: "QA",
    TESTER: "QA",
  };

  return aliases[normalized] ?? null;
}

export async function resolveCaller(input: string): Promise<Caller> {
  const value = input.trim();
  if (!value) throw new Error("USER_ID_REQUIRED");

  const db = await getDb();
  const or: Record<string, unknown>[] = [
    { userKey: value },
    { email: value },
    { username: value },
  ];

  if (ObjectId.isValid(value)) {
    or.push({ _id: new ObjectId(value) });
  }

  const user = await db.collection("users").findOne({ $or: or });

  if (!user) throw new Error("USER_NOT_FOUND");
  if (user.active === false) throw new Error("USER_INACTIVE");

  // Accept either `role` or a legacy `roleName` string.
  const rawRole = user.role ?? user.roleName;
  const role = normalizeRole(rawRole);

  if (!role) {
    const shown = typeof rawRole === "string" ? rawRole : typeof rawRole;
    throw new Error(`ROLE_NOT_SUPPORTED:${shown}`);
  }

  const email = typeof user.email === "string" ? user.email : undefined;
  const userKey =
    typeof user.userKey === "string" && user.userKey.trim()
      ? user.userKey
      : email ?? String(user._id);

  return {
    mongoUserId: String(user._id),
    userKey,
    email,
    name:
      typeof user.name === "string" && user.name.trim()
        ? user.name
        : typeof user.fullName === "string" && user.fullName.trim()
          ? user.fullName
          : "User",
    role,
    active: true,
  };
}

export async function resolveUserObjectId(identity: string): Promise<ObjectId> {
  const value = identity.trim();
  if (!value) throw new Error("USER_REFERENCE_REQUIRED");
  if (ObjectId.isValid(value)) return new ObjectId(value);

  const db = await getDb();
  const user = await db.collection("users").findOne(
    {
      $or: [
        { userKey: value },
        { email: value },
        { username: value },
        { name: { $regex: `^${escapeRegex(value)}$`, $options: "i" } },
        { fullName: { $regex: `^${escapeRegex(value)}$`, $options: "i" } },
      ],
    },
    { projection: { _id: 1 } },
  );

  if (!user?._id) throw new Error(`USER_REFERENCE_NOT_FOUND:${value}`);
  return user._id as ObjectId;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
