import type { AgentName, Role } from "@/src/types";

export const AGENT_INFO: Record<AgentName, { label: string; purpose: string }> = {
  REQUIREMENTS: {
    label: "Requirements Agent",
    purpose: "Feature requests, requirement drafting, draft epics and user stories, approval context.",
  },
  SPRINT_TASK: {
    label: "Sprint / Task Agent",
    purpose: "Sprints, tasks, assignments, workload, blockers, capacity and progress.",
  },
  BUG: {
    label: "Bug Agent",
    purpose: "Bug reporting, triage, similar-bug lookup, fix-ready flow, QA verification and test context.",
  },
  RELEASE: {
    label: "Release Agent",
    purpose: "Release scope, deterministic readiness, blockers, sign-offs and release-note context.",
  },
  DOCUMENTATION: {
    label: "Documentation Agent",
    purpose: "Grounded search over internal documents with honest not-documented fallback.",
  },
};

// Access to an agent does NOT imply write access. Collection/operation/scope rules are enforced in policy.ts.
export const ROLE_AGENT_ACCESS: Record<Role, AgentName[]> = {
  PRODUCT_MANAGER: ["REQUIREMENTS", "SPRINT_TASK", "BUG", "RELEASE", "DOCUMENTATION"],
  ENGINEERING_LEAD: ["REQUIREMENTS", "SPRINT_TASK", "BUG", "RELEASE", "DOCUMENTATION"],
  DEVELOPER: ["REQUIREMENTS", "SPRINT_TASK", "BUG", "RELEASE", "DOCUMENTATION"],
  QA: ["REQUIREMENTS", "SPRINT_TASK", "BUG", "RELEASE", "DOCUMENTATION"],
};
