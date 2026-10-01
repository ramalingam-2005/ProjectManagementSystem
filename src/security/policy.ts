import type { AgentName, DbOperation, Role, Scope } from "@/src/types";

export interface Rule {
  ops: DbOperation[];
  scope: Scope;
  mutableFields?: string[];
  creationReview?: boolean;
}

type RoleRules = Partial<Record<string, Rule>>;

export const POLICY: Record<AgentName, Partial<Record<Role, RoleRules>>> = {
  REQUIREMENTS: {
    PRODUCT_MANAGER: {
      feature_requests: {
        ops: ["find", "find_one", "count", "insert_one", "update_one"],
        scope: "ALL",
        mutableFields: ["featureRequestKey", "productId", "title", "description", "source", "sourceDetail", "priority", "status"],
      },
      // Creation must pass through the PM review service.
      epics: {
        creationReview: true,
        ops: ["find", "find_one", "count", "insert_one", "update_one"],
        scope: "ALL",
        mutableFields: ["epicKey", "featureRequestId", "title", "description", "status"],
      },
      user_stories: {
        creationReview: true,
        ops: ["find", "find_one", "count", "insert_one", "insert_many", "update_one", "update_many"],
        scope: "ALL",
        mutableFields: ["storyKey", "epicId", "title", "userStory", "acceptanceCriteria", "storyPoints", "priority", "status"],
      },
    },
    ENGINEERING_LEAD: {
      feature_requests: { ops: ["find", "find_one", "count"], scope: "ALL" },
      epics: {
        ops: ["find", "find_one", "count", "insert_one", "update_one"],
        scope: "ALL",
        mutableFields: ["epicKey", "featureRequestId", "title", "description", "status"],
      },
      user_stories: { ops: ["find", "find_one", "count"], scope: "ALL" },
    },
    DEVELOPER: {
      feature_requests: {
        ops: ["find", "find_one", "count", "insert_one"],
        scope: "OWN",
        mutableFields: ["featureRequestKey", "productId", "title", "description", "source", "sourceDetail", "priority", "status"],
      },
    },
    QA: {
      feature_requests: {
        ops: ["find", "find_one", "count", "insert_one"],
        scope: "OWN",
        mutableFields: ["featureRequestKey", "productId", "title", "description", "source", "sourceDetail", "priority", "status"],
      },
    },
  },

  SPRINT_TASK: {
    PRODUCT_MANAGER: {
      sprints: { ops: ["find", "find_one", "count"], scope: "ALL" },
      tasks: { ops: ["find", "find_one", "count"], scope: "ALL" },
      user_stories: { ops: ["find", "find_one", "count"], scope: "ALL" },
    },
    ENGINEERING_LEAD: {
      sprints: {
        ops: ["find", "find_one", "count", "insert_one", "update_one", "calculate"],
        scope: "TEAM",
        mutableFields: ["sprintNumber", "name", "status", "startDate", "endDate", "velocity"],
      },
      tasks: {
        ops: ["find", "find_one", "count", "insert_one", "update_one", "update_many", "calculate"],
        scope: "TEAM",
        mutableFields: ["taskKey", "storyId", "sprintId", "assigneeId", "assignee", "releaseVersion", "type", "title", "description", "storyPoints", "priority", "status", "blocked", "blockerReason"],
      },
      user_stories: { ops: ["find", "find_one", "count"], scope: "ALL" },
    },
    DEVELOPER: {
      sprints: { ops: ["find", "find_one", "count"], scope: "OWN" },
      tasks: {
        ops: ["find", "find_one", "count", "update_one", "calculate"],
        scope: "OWN",
        mutableFields: ["status", "blocked", "blockerReason"],
      },
      user_stories: { ops: ["find", "find_one", "count"], scope: "OWN" },
    },
    QA: {
      sprints: { ops: ["find", "find_one", "count"], scope: "ALL" },
      tasks: { ops: ["find", "find_one", "count"], scope: "ALL" },
    },
  },

  BUG: {
    PRODUCT_MANAGER: {
      bugs: { ops: ["find", "find_one", "count"], scope: "ALL" },
      test_cases: { ops: ["find", "find_one", "count"], scope: "ALL" },
      tasks: { ops: ["find", "find_one", "count"], scope: "ALL" },
    },
    QA: {
      bugs: {
        ops: ["find", "find_one", "count", "insert_one", "update_one"],
        scope: "ALL",
        mutableFields: ["bugKey", "productId", "sourceTestCaseId", "assigneeId", "assignee", "affectedReleaseVersion", "title", "description", "component", "stepsToReproduce", "logs", "severity", "status", "qaVerificationResult"],
      },
      test_cases: {
        ops: ["find", "find_one", "count", "insert_one", "update_one"],
        scope: "ALL",
        mutableFields: ["testCaseKey", "productId", "title", "module", "active", "targetVersions"],
      },
      tasks: { ops: ["find", "find_one", "count"], scope: "ALL" },
    },
    DEVELOPER: {
      bugs: {
        ops: ["find", "find_one", "count", "insert_one", "update_one"],
        scope: "ASSIGNED",
        mutableFields: ["bugKey", "productId", "sourceTestCaseId", "affectedReleaseVersion", "title", "description", "component", "stepsToReproduce", "logs", "severity", "status", "fixSummary"],
      },
      test_cases: { ops: ["find", "find_one", "count"], scope: "ASSIGNED" },
      tasks: { ops: ["find", "find_one", "count"], scope: "OWN" },
    },
    ENGINEERING_LEAD: {
      bugs: {
        ops: ["find", "find_one", "count", "update_one"],
        scope: "TEAM",
        mutableFields: ["assigneeId", "assignee", "severity", "status"],
      },
      test_cases: { ops: ["find", "find_one", "count"], scope: "ALL" },
      tasks: { ops: ["find", "find_one", "count"], scope: "TEAM" },
    },
  },

  RELEASE: {
    PRODUCT_MANAGER: {
      releases: {
        ops: ["find", "find_one", "count", "update_one", "calculate"],
        scope: "ALL",
        mutableFields: ["pmSignoff"],
      },
      tasks: { ops: ["find", "find_one", "count"], scope: "ALL" },
      bugs: { ops: ["find", "find_one", "count"], scope: "ALL" },
      test_cases: { ops: ["find", "find_one", "count"], scope: "ALL" },
    },
    QA: {
      releases: {
        ops: ["find", "find_one", "count", "update_one", "calculate"],
        scope: "ALL",
        mutableFields: ["qaSignoff"],
      },
      tasks: { ops: ["find", "find_one", "count"], scope: "ALL" },
      bugs: { ops: ["find", "find_one", "count"], scope: "ALL" },
      test_cases: { ops: ["find", "find_one", "count"], scope: "ALL" },
    },
    ENGINEERING_LEAD: {
      releases: {
        ops: ["find", "find_one", "count", "insert_one", "update_one", "calculate"],
        scope: "ALL",
        mutableFields: ["productId", "version", "status"],
      },
      tasks: { ops: ["find", "find_one", "count"], scope: "TEAM" },
      bugs: { ops: ["find", "find_one", "count"], scope: "TEAM" },
      test_cases: { ops: ["find", "find_one", "count"], scope: "ALL" },
    },
    DEVELOPER: {
      releases: { ops: ["find", "find_one", "count", "calculate"], scope: "ALL" },
      tasks: { ops: ["find", "find_one", "count"], scope: "OWN" },
      bugs: { ops: ["find", "find_one", "count"], scope: "ASSIGNED" },
      test_cases: { ops: ["find", "find_one", "count"], scope: "ASSIGNED" },
    },
  },

  DOCUMENTATION: {
    PRODUCT_MANAGER: { documents: { ops: ["find", "find_one", "count"], scope: "ALL" } },
    ENGINEERING_LEAD: { documents: { ops: ["find", "find_one", "count"], scope: "ALL" } },
    DEVELOPER: { documents: { ops: ["find", "find_one", "count"], scope: "ALL" } },
    QA: { documents: { ops: ["find", "find_one", "count"], scope: "ALL" } },
  },
};

export const NEVER_ALLOWED = new Set([
  "delete_one",
  "delete_many",
  "drop",
  "dropDatabase",
  "replace_one",
  "renameCollection",
  "bulkWrite",
  "$where",
  "$function",
  "$merge",
  "$out",
]);

export function getRolePolicy(agent: AgentName, role: Role): RoleRules {
  return POLICY[agent][role] ?? {};
}

export function getAllowedCollections(agent: AgentName, role: Role): string[] {
  return Object.keys(getRolePolicy(agent, role));
}
