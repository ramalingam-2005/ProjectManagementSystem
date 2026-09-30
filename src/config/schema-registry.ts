import type { CollectionSchema } from "@/src/types";

export const COLLECTION_SCHEMAS = {
  feature_requests: {
    description: "Product feature requests submitted for review and triage.",
    fields: {
      _id: { type: "ObjectId", queryable: true, selectable: true },
      featureRequestKey: { type: "string", queryable: true, selectable: true, description: "Optional public key such as FR-101." },
      productId: { type: "ObjectId", queryable: true, selectable: true },
      requestedBy: { type: "ObjectId", queryable: true, selectable: true },
      title: { type: "string", queryable: true, selectable: true },
      description: { type: "string", queryable: true, selectable: true },
      source: { type: "string", queryable: true, selectable: true },
      sourceDetail: { type: "string", queryable: true, selectable: true },
      priority: { type: "string", queryable: true, selectable: true },
      status: { type: "string", queryable: true, selectable: true },
      submittedAt: { type: "date", queryable: true, selectable: true },
      createdAt: { type: "date", queryable: true, selectable: true },
      updatedAt: { type: "date", queryable: true, selectable: true },
    },
    virtualFields: {
      key: { type: "string", queryable: true, description: "Public identifier alias. Exact stored keys take priority; FR-113, feature-113 and feature request 113 can resolve the same feature. Also accepts Mongo _id." },
    },
    defaultProjection: ["featureRequestKey", "title", "priority", "status", "source", "updatedAt"],
  },

  epics: {
    description: "Engineering epics linked to feature requests.",
    fields: {
      _id: { type: "ObjectId", queryable: true, selectable: true },
      epicKey: { type: "string", queryable: true, selectable: true, description: "Optional public key such as EPIC-101." },
      featureRequestId: { type: "ObjectId", queryable: true, selectable: true },
      title: { type: "string", queryable: true, selectable: true },
      description: { type: "string", queryable: true, selectable: true },
      generatedByAI: { type: "boolean", queryable: true, selectable: true },
      status: { type: "string", queryable: true, selectable: true },
      createdAt: { type: "date", queryable: true, selectable: true },
      updatedAt: { type: "date", queryable: true, selectable: true },
    },
    virtualFields: {
      key: { type: "string", queryable: true, description: "Alias for epicKey or Mongo _id." },
      featureRequestKey: { type: "string", queryable: true, description: "Resolves a feature request public key/title/_id to featureRequestId." },
    },
    relationships: { featureRequestId: "feature_requests._id" },
    defaultProjection: ["epicKey", "featureRequestId", "title", "status", "updatedAt"],
  },

  user_stories: {
    description: "User stories belonging to epics.",
    fields: {
      _id: { type: "ObjectId", queryable: true, selectable: true },
      storyKey: { type: "string", queryable: true, selectable: true, description: "Optional public key such as US-101." },
      epicId: { type: "ObjectId", queryable: true, selectable: true },
      title: { type: "string", queryable: true, selectable: true },
      userStory: { type: "string", queryable: true, selectable: true },
      acceptanceCriteria: { type: "string[]", queryable: false, selectable: true },
      storyPoints: { type: "number", queryable: true, selectable: true },
      priority: { type: "string", queryable: true, selectable: true },
      status: { type: "string", queryable: true, selectable: true },
      createdAt: { type: "date", queryable: true, selectable: true },
      updatedAt: { type: "date", queryable: true, selectable: true },
    },
    virtualFields: {
      key: { type: "string", queryable: true, description: "Alias for storyKey or Mongo _id." },
      epicKey: { type: "string", queryable: true, description: "Resolves an epic public key/title/_id to epicId." },
      featureRequestKey: { type: "string", queryable: true, description: "Resolves through epics to stories under the feature request." },
    },
    relationships: { epicId: "epics._id" },
    defaultProjection: ["storyKey", "epicId", "title", "userStory", "storyPoints", "priority", "status"],
  },

  sprints: {
    description: "Sprint planning, dates and developer capacities.",
    fields: {
      _id: { type: "ObjectId", queryable: true, selectable: true },
      sprintNumber: { type: "number", queryable: true, selectable: true },
      name: { type: "string", queryable: true, selectable: true },
      status: { type: "string", queryable: true, selectable: true },
      startDate: { type: "date", queryable: true, selectable: true },
      endDate: { type: "date", queryable: true, selectable: true },
      velocity: { type: "number", queryable: true, selectable: true },
      "capacities.developerId": { type: "ObjectId", queryable: true, selectable: false },
      "capacities.capacity": { type: "number", queryable: true, selectable: false },
      capacities: { type: "array", queryable: false, selectable: true },
      createdAt: { type: "date", queryable: true, selectable: true },
    },
    virtualFields: {
      key: { type: "string", queryable: true, description: "Accepts a Mongo _id or sprint number/name." },
    },
    defaultProjection: ["sprintNumber", "name", "status", "startDate", "endDate", "velocity", "capacities"],
  },

  tasks: {
    description: "Engineering tasks assigned to developers and sprints.",
    fields: {
      _id: { type: "ObjectId", queryable: true, selectable: true },
      taskKey: { type: "string", queryable: true, selectable: true },
      storyId: { type: "ObjectId", queryable: true, selectable: true },
      sprintId: { type: "ObjectId", queryable: true, selectable: true },
      assigneeId: { type: "ObjectId", queryable: true, selectable: true },
      createdBy: { type: "ObjectId", queryable: true, selectable: true },
      releaseVersion: { type: "string", queryable: true, selectable: true },
      type: { type: "string", queryable: true, selectable: true },
      title: { type: "string", queryable: true, selectable: true },
      description: { type: "string", queryable: true, selectable: true },
      storyPoints: { type: "number", queryable: true, selectable: true },
      priority: { type: "string", queryable: true, selectable: true },
      status: { type: "string", queryable: true, selectable: true },
      "blocker.blocked": { type: "boolean", queryable: true, selectable: false },
      "blocker.reason": { type: "string", queryable: true, selectable: false },
      blocker: { type: "object", queryable: false, selectable: true },
      dependencies: { type: "ObjectId[]", queryable: false, selectable: true },
      createdAt: { type: "date", queryable: true, selectable: true },
      updatedAt: { type: "date", queryable: true, selectable: true },
    },
    virtualFields: {
      key: { type: "string", queryable: true, description: "Alias for taskKey or Mongo _id." },
      assignee: { type: "string", queryable: true, description: "Developer email, userKey, name or Mongo _id; backend resolves it to assigneeId." },
    },
    relationships: { storyId: "user_stories._id", sprintId: "sprints._id", assigneeId: "users._id" },
    defaultProjection: ["taskKey", "title", "status", "priority", "storyPoints", "assigneeId", "sprintId", "blocker", "releaseVersion"],
  },

  bugs: {
    description: "Software defects reported from QA or engineering.",
    fields: {
      _id: { type: "ObjectId", queryable: true, selectable: true },
      bugKey: { type: "string", queryable: true, selectable: true },
      productId: { type: "ObjectId", queryable: true, selectable: true },
      sourceTestCaseId: { type: "ObjectId", queryable: true, selectable: true },
      reportedBy: { type: "ObjectId", queryable: true, selectable: true },
      assigneeId: { type: "ObjectId", queryable: true, selectable: true },
      affectedReleaseVersion: { type: "string", queryable: true, selectable: true },
      title: { type: "string", queryable: true, selectable: true },
      description: { type: "string", queryable: true, selectable: true },
      component: { type: "string", queryable: true, selectable: true },
      stepsToReproduce: { type: "string[]", queryable: false, selectable: true },
      logs: { type: "string", queryable: true, selectable: true },
      severity: { type: "string", queryable: true, selectable: true },
      status: { type: "string", queryable: true, selectable: true },
      "fixDetails.fixSummary": { type: "string", queryable: true, selectable: false },
      "qaVerification.result": { type: "string", queryable: true, selectable: false },
      fixDetails: { type: "object", queryable: false, selectable: true },
      qaVerification: { type: "object", queryable: false, selectable: true },
      createdAt: { type: "date", queryable: true, selectable: true },
      updatedAt: { type: "date", queryable: true, selectable: true },
    },
    virtualFields: {
      key: { type: "string", queryable: true, description: "Alias for bugKey or Mongo _id." },
      assignee: { type: "string", queryable: true, description: "Developer email, userKey, name or Mongo _id." },
    },
    relationships: { sourceTestCaseId: "test_cases._id", assigneeId: "users._id" },
    defaultProjection: ["bugKey", "title", "component", "severity", "status", "assigneeId", "affectedReleaseVersion", "stepsToReproduce", "fixDetails", "qaVerification"],
  },

  test_cases: {
    description: "QA test cases and embedded execution history.",
    fields: {
      _id: { type: "ObjectId", queryable: true, selectable: true },
      testCaseKey: { type: "string", queryable: true, selectable: true },
      productId: { type: "ObjectId", queryable: true, selectable: true },
      title: { type: "string", queryable: true, selectable: true },
      module: { type: "string", queryable: true, selectable: true },
      active: { type: "boolean", queryable: true, selectable: true },
      targetVersions: { type: "string[]", queryable: true, selectable: true },
      "executions.releaseVersion": { type: "string", queryable: true, selectable: false },
      "executions.result": { type: "string", queryable: true, selectable: false },
      executions: { type: "array", queryable: false, selectable: true },
      createdAt: { type: "date", queryable: true, selectable: true },
      updatedAt: { type: "date", queryable: true, selectable: true },
    },
    virtualFields: {
      key: { type: "string", queryable: true, description: "Alias for testCaseKey or Mongo _id." },
    },
    defaultProjection: ["testCaseKey", "title", "module", "active", "targetVersions", "executions"],
  },

  releases: {
    description: "Release scope, sign-offs, notes and deployment state.",
    fields: {
      _id: { type: "ObjectId", queryable: true, selectable: true },
      productId: { type: "ObjectId", queryable: true, selectable: true },
      version: { type: "string", queryable: true, selectable: true },
      status: { type: "string", queryable: true, selectable: true },
      "signoffs.pm.approved": { type: "boolean", queryable: true, selectable: false },
      "signoffs.qa.approved": { type: "boolean", queryable: true, selectable: false },
      signoffs: { type: "object", queryable: false, selectable: true },
      scope: { type: "object", queryable: false, selectable: true },
      releaseNotes: { type: "object", queryable: false, selectable: true },
      deployments: { type: "array", queryable: false, selectable: true },
      createdAt: { type: "date", queryable: true, selectable: true },
      updatedAt: { type: "date", queryable: true, selectable: true },
    },
    virtualFields: {
      key: { type: "string", queryable: true, description: "Release version or Mongo _id." },
    },
    defaultProjection: ["version", "status", "scope", "signoffs", "releaseNotes", "updatedAt"],
  },

  documents: {
    description: "Internal product, process, API and release documentation.",
    fields: {
      _id: { type: "ObjectId", queryable: true, selectable: true },
      ownerId: { type: "ObjectId", queryable: true, selectable: true },
      title: { type: "string", queryable: true, selectable: true },
      type: { type: "string", queryable: true, selectable: true },
      version: { type: "string", queryable: true, selectable: true },
      content: { type: "string", queryable: true, selectable: true },
      status: { type: "string", queryable: true, selectable: true },
      "metadata.releaseVersion": { type: "string", queryable: true, selectable: false },
      "metadata.tags": { type: "string[]", queryable: true, selectable: false },
      metadata: { type: "object", queryable: false, selectable: true },
      createdAt: { type: "date", queryable: true, selectable: true },
      updatedAt: { type: "date", queryable: true, selectable: true },
    },
    virtualFields: {
      key: { type: "string", queryable: true, description: "Document Mongo _id or exact title." },
    },
    defaultProjection: ["title", "type", "version", "status", "content", "metadata", "updatedAt"],
  },
} satisfies Record<string, CollectionSchema>;

export type CollectionName = keyof typeof COLLECTION_SCHEMAS;

export function getCollectionSchema(collection: string): CollectionSchema | undefined {
  return COLLECTION_SCHEMAS[collection as CollectionName];
}

export function listQueryableFields(collection: string): string[] {
  const schema = getCollectionSchema(collection);
  if (!schema) return [];
  const normal = Object.entries(schema.fields)
    .filter(([, config]) => config.queryable !== false)
    .map(([name]) => name);
  return [...normal, ...Object.keys(schema.virtualFields ?? {})];
}

export function listSelectableFields(collection: string): string[] {
  const schema = getCollectionSchema(collection);
  if (!schema) return [];
  return Object.entries(schema.fields)
    .filter(([, config]) => config.selectable !== false)
    .map(([name]) => name);
}
