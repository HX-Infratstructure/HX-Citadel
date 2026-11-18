import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Shared validators — import these from feature code instead of redefining.
 * The schema is FROZEN for parallel track work: coordinate before editing this file.
 */
export const issueStatusValidator = v.union(
  v.literal("backlog"),
  v.literal("todo"),
  v.literal("in_progress"),
  v.literal("in_review"),
  v.literal("done"),
  v.literal("canceled")
);

export const issueKindValidator = v.union(
  v.literal("epic"),
  v.literal("feature"),
  v.literal("story"),
  v.literal("subtask")
);

export const issueTypeValidator = v.union(
  v.literal("story"),
  v.literal("bug"),
  v.literal("chore")
);

export const issuePriorityValidator = v.union(
  v.literal("none"),
  v.literal("urgent"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low")
);

export const memberRoleValidator = v.union(
  v.literal("admin"),
  v.literal("member")
);

/** Absent means human. Agents are created by convex/lib/agents.ts, not Clerk. */
export const userKindValidator = v.union(v.literal("human"), v.literal("agent"));

export const projectStatusValidator = v.union(
  v.literal("backlog"),
  v.literal("planned"),
  v.literal("in_progress"),
  v.literal("paused"),
  v.literal("completed"),
  v.literal("canceled")
);

export const issueRelationTypeValidator = v.union(
  v.literal("blocks"),
  v.literal("blocked_by"),
  v.literal("related"),
  v.literal("duplicate_of")
);

export const decisionStatusValidator = v.union(v.literal("open"), v.literal("answered"));

/** Where the owner answered: on the story, or in the Inbox copy (P3.6d carries that answer back). */
export const decisionViaValidator = v.union(v.literal("story"), v.literal("inbox"));

export const decisionAnswerValidator = v.object({ choice: v.optional(v.string()), text: v.optional(v.string()) });

/** A decision an agent asks the owner about one story; the limits and rules live in `convex/lib/decisions.ts`. */
export const decisionFields = {
  orgId: v.id("organizations"),
  issueId: v.id("issues"),
  askedBy: v.id("users"),
  question: v.string(),
  choices: v.optional(v.array(v.string())),
  recommended: v.optional(v.string()),
  status: decisionStatusValidator,
  answer: v.optional(decisionAnswerValidator),
  answeredBy: v.optional(v.id("users")),
  answeredVia: v.optional(decisionViaValidator),
  answeredAt: v.optional(v.number()),
  /** The Inbox copy's message id; P3.6d writes it. */
  inboxMessageId: v.optional(v.string()),
};

export default defineSchema({
  // ── Synced from Clerk via webhooks ─────────────────────────────────────
  users: defineTable({
    clerkId: v.string(),
    name: v.string(),
    email: v.string(),
    imageUrl: v.optional(v.string()),
    kind: v.optional(userKindValidator),
  }).index("by_clerk_id", ["clerkId"]),

  organizations: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  })
    .index("by_clerk_org_id", ["clerkOrgId"])
    .index("by_slug", ["slug"]),

  members: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    role: memberRoleValidator,
    clerkMembershipId: v.string(),
    clerkUpdatedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_user", ["userId"])
    .index("by_org_and_user", ["orgId", "userId"])
    .index("by_clerk_membership_id", ["clerkMembershipId"]),

  // ── Workspace structure ────────────────────────────────────────────────
  teams: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    /** Issue prefix, e.g. "ENG" → ENG-123 */
    key: v.string(),
    description: v.optional(v.string()),
    /** Per-team issue number sequence */
    nextIssueNumber: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_and_key", ["orgId", "key"]),

  issues: defineTable({
    orgId: v.id("organizations"),
    teamId: v.id("teams"),
    kind: issueKindValidator,
    /** Set only on stories */
    type: v.optional(issueTypeValidator),
    /** Per-team sequence number, stories only, displayed as KEY-number */
    number: v.optional(v.number()),
    /** Per-story sequence number, subtasks only, displayed as KEY-number.subNumber */
    subNumber: v.optional(v.number()),
    title: v.string(),
    description: v.optional(v.string()),
    status: issueStatusValidator,
    priority: issuePriorityValidator,
    assigneeId: v.optional(v.id("users")),
    creatorId: v.id("users"),
    projectId: v.optional(v.id("projects")),
    cycleId: v.optional(v.id("cycles")),
    parentIssueId: v.optional(v.id("issues")),
    estimate: v.optional(v.number()),
    /** Due date as ms since epoch */
    dueDate: v.optional(v.number()),
    /** Fractional ranking for board/list ordering */
    sortOrder: v.number(),
    /** True only on a story's Complete testing sub-task */
    testing: v.optional(v.boolean()),
    /** Absolute http(s) proof link, Complete testing sub-task only */
    proofUrl: v.optional(v.string()),
    /** Bumped by one on every patch (`patchIssue`); absent reads as 1 */
    version: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_team", ["teamId"])
    .index("by_team_and_number", ["teamId", "number"])
    .index("by_team_and_status", ["teamId", "status"])
    .index("by_team_and_sort_order", ["teamId", "sortOrder"])
    .index("by_team_kind_status", ["teamId", "kind", "status"])
    .index("by_assignee_kind_status", ["orgId", "assigneeId", "kind", "status"])
    .index("by_project", ["projectId"])
    .index("by_cycle", ["cycleId"])
    .index("by_parent", ["parentIssueId"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["orgId", "teamId"],
    })
    .searchIndex("search_description", {
      searchField: "description",
      filterFields: ["orgId", "teamId"],
    }),

  labels: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    /** Hex color, e.g. "#5e6ad2" */
    color: v.string(),
  }).index("by_org", ["orgId"]),

  issueLabels: defineTable({
    issueId: v.id("issues"),
    labelId: v.id("labels"),
  })
    .index("by_issue", ["issueId"])
    .index("by_label", ["labelId"]),

  issueRelations: defineTable({
    issueId: v.id("issues"),
    relatedIssueId: v.id("issues"),
    type: issueRelationTypeValidator,
  })
    .index("by_issue", ["issueId"])
    .index("by_related", ["relatedIssueId"]),

  comments: defineTable({
    orgId: v.id("organizations"),
    issueId: v.id("issues"),
    authorId: v.id("users"),
    body: v.string(),
    /** User ids @mentioned in the body */
    mentions: v.optional(v.array(v.id("users"))),
  }).index("by_issue", ["issueId"]),

  activity: defineTable({
    orgId: v.id("organizations"),
    issueId: v.id("issues"),
    actorId: v.id("users"),
    /** e.g. "created" | "status_changed" | "assigned" | "labeled" | "commented" */
    type: v.string(),
    field: v.optional(v.string()),
    oldValue: v.optional(v.string()),
    newValue: v.optional(v.string()),
  })
    .index("by_issue", ["issueId"])
    .index("by_org", ["orgId"]),

  projects: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    status: projectStatusValidator,
    leadId: v.optional(v.id("users")),
    /** Target date as ms since epoch */
    targetDate: v.optional(v.number()),
    color: v.optional(v.string()),
  }).index("by_org", ["orgId"]),

  cycles: defineTable({
    orgId: v.id("organizations"),
    teamId: v.id("teams"),
    /** Per-team cycle sequence: Cycle 1, Cycle 2, ... */
    number: v.number(),
    name: v.optional(v.string()),
    startDate: v.number(),
    endDate: v.number(),
  })
    .index("by_team", ["teamId"])
    .index("by_team_and_number", ["teamId", "number"]),

  attachments: defineTable({
    orgId: v.id("organizations"),
    issueId: v.id("issues"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    fileType: v.string(),
    fileSize: v.number(),
    uploadedBy: v.id("users"),
  })
    .index("by_issue", ["issueId"])
    .index("by_storage", ["storageId"]),

  views: defineTable({
    orgId: v.id("organizations"),
    creatorId: v.id("users"),
    name: v.string(),
    /** JSON-serialized filter configuration (owned by Track A) */
    filters: v.string(),
    shared: v.boolean(),
  })
    .index("by_org", ["orgId"])
    .index("by_creator", ["creatorId"]),

  decisions: defineTable(decisionFields)
    .index("by_issue", ["issueId"])
    .index("by_issue_and_status", ["issueId", "status"])
    .index("by_org_and_status", ["orgId", "status"]),

  idempotencyKeys: defineTable({
    orgId: v.id("organizations"),
    agentId: v.id("users"),
    key: v.string(),
    requestHash: v.string(),
    body: v.any(),
    createdAt: v.number(),
  })
    .index("by_org_and_key", ["orgId", "key"])
    .index("by_created_at", ["createdAt"]),
});
