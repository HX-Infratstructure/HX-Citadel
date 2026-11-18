import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, MutationCtx, QueryCtx } from "./_generated/server";
import { formatIssueKey, parseIssueKey } from "../lib/issue-key";
import { createComment as createCommentWithRules } from "./comments";
import {
  createIssue as createIssueWithRules,
  getOrgIssue,
  issueShape,
  listTeamIssues,
  setIssueProof,
  updateIssue as updateIssueWithRules,
} from "./issues";
import {
  findAgentMember,
  OrgScope,
  resolveAgentAssignee,
  resolveAgentReadScope,
  resolveAgentScope,
} from "./lib/orgScope";
import {
  issueKindValidator,
  issuePriorityValidator,
  issueStatusValidator,
  issueTypeValidator,
} from "./schema";

const keyedIssue = v.object({ ...issueShape, key: v.union(v.string(), v.null()) });

type Db = { db: QueryCtx["db"] };

function withKey(issue: Doc<"issues">, teamKey: string, parentNumber?: number) {
  return { ...issue, key: formatIssueKey(teamKey, issue, parentNumber) };
}

async function findTeamByKey(ctx: Db, orgId: Id<"organizations">, teamKey: string): Promise<Doc<"teams">> {
  const team = await ctx.db
    .query("teams")
    .withIndex("by_org_and_key", (q) => q.eq("orgId", orgId).eq("key", teamKey))
    .unique();
  if (team === null) {
    throw new Error(`Team ${teamKey} not found`);
  }
  return team;
}

async function subtasksOf(ctx: Db, issueId: Id<"issues">): Promise<Doc<"issues">[]> {
  const subtasks = await ctx.db
    .query("issues")
    .withIndex("by_parent", (q) => q.eq("parentIssueId", issueId))
    .collect();
  return subtasks.sort((a, b) => (a.subNumber ?? 0) - (b.subNumber ?? 0));
}

type FoundIssue = { issue: Doc<"issues">; team: Doc<"teams">; parentNumber?: number };

/** A story by KEY-12 or a sub-task by KEY-12.3, inside the workspace. */
async function findIssueByKey(ctx: Db, orgId: Id<"organizations">, key: string): Promise<FoundIssue> {
  const parsed = parseIssueKey(key);
  if (parsed === null) {
    throw new Error(`invalid issue key ${key}; use KEY-12 or KEY-12.3`);
  }
  const team = await findTeamByKey(ctx, orgId, parsed.teamKey);
  const story = await ctx.db
    .query("issues")
    .withIndex("by_team_and_number", (q) => q.eq("teamId", team._id).eq("number", parsed.number))
    .unique();
  if (story === null || story.kind !== "story") {
    throw new Error(`Issue ${key} not found`);
  }
  if (parsed.subNumber === undefined) {
    return { issue: story, team };
  }
  const subtask = (await subtasksOf(ctx, story._id)).find((sub) => sub.subNumber === parsed.subNumber);
  if (subtask === undefined) {
    throw new Error(`Issue ${key} not found`);
  }
  return { issue: subtask, team, parentNumber: story.number };
}

export const createIssue = internalMutation({
  args: {
    agentName: v.string(),
    teamKey: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    kind: v.optional(issueKindValidator),
    type: v.optional(issueTypeValidator),
    status: v.optional(issueStatusValidator),
    priority: v.optional(issuePriorityValidator),
    parentKey: v.optional(v.string()),
    assignee: v.optional(v.string()),
  },
  returns: v.object({ issue: keyedIssue }),
  handler: async (ctx, { agentName, teamKey, parentKey, assignee, ...fields }) => {
    const scope = await resolveAgentScope(ctx, agentName);
    const team = await findTeamByKey(ctx, scope.org._id, teamKey);
    const parent = parentKey === undefined ? null : (await findIssueByKey(ctx, scope.org._id, parentKey)).issue;
    const assigneeId = assignee === undefined ? undefined : await resolveAgentAssignee(ctx, scope.org._id, assignee);
    const issueId = await createIssueWithRules(ctx, scope, {
      ...fields,
      teamId: team._id,
      parentIssueId: parent?._id,
      assigneeId,
    });
    const issue = await getOrgIssue(ctx, scope.org._id, issueId);
    return { issue: withKey(issue, team.key, parent?.number) };
  },
});

export const getIssue = internalQuery({
  args: { agentName: v.string(), key: v.string() },
  returns: v.object({ issue: keyedIssue, subtasks: v.array(keyedIssue) }),
  handler: async (ctx, { agentName, key }) => {
    const org = await resolveAgentReadScope(ctx, agentName);
    const { issue, team, parentNumber } = await findIssueByKey(ctx, org._id, key);
    const subtasks = await subtasksOf(ctx, issue._id);
    return {
      issue: withKey(issue, team.key, parentNumber),
      subtasks: subtasks.map((subtask) => withKey(subtask, team.key, issue.number)),
    };
  },
});

/** The issue a write names, by key, re-read after the write so the response shows the result. */
async function resolveKeyedWrite(ctx: MutationCtx, agentName: string, key: string) {
  const scope = await resolveAgentScope(ctx, agentName);
  const found = await findIssueByKey(ctx, scope.org._id, key);
  const reread = async () => withKey(await getOrgIssue(ctx, scope.org._id, found.issue._id), found.team.key, found.parentNumber);
  return { scope, issueId: found.issue._id, reread };
}

/** An assignee by agent name; `null` unassigns, `undefined` leaves it alone. */
async function assigneeIdFor(ctx: MutationCtx, scope: OrgScope, assignee: string | null | undefined) {
  if (assignee === undefined || assignee === null) {
    return assignee;
  }
  return await resolveAgentAssignee(ctx, scope.org._id, assignee);
}

/** `me` is the calling agent, which has nothing assigned before its first write (null); any other name must exist. */
async function assigneeFilter(ctx: QueryCtx, orgId: Id<"organizations">, agentName: string, assignee: string | undefined) {
  if (assignee === "me") {
    return await findAgentMember(ctx, orgId, agentName);
  }
  if (assignee === undefined) {
    return undefined;
  }
  return await resolveAgentAssignee(ctx, orgId, assignee);
}

const listedIssue = v.object({
  ...issueShape,
  key: v.union(v.string(), v.null()),
  assignee: v.union(v.string(), v.null()),
  parentKey: v.union(v.string(), v.null()),
});

export const listIssues = internalQuery({
  args: {
    agentName: v.string(),
    teamKey: v.string(),
    status: v.optional(issueStatusValidator),
    assignee: v.optional(v.string()),
  },
  returns: v.object({ issues: v.array(listedIssue) }),
  handler: async (ctx, { agentName, teamKey, status, assignee }) => {
    const org = await resolveAgentReadScope(ctx, agentName);
    const team = await findTeamByKey(ctx, org._id, teamKey);
    const assigneeId = await assigneeFilter(ctx, org._id, agentName, assignee);
    if (assigneeId === null) {
      return { issues: [] };
    }
    const all = await listTeamIssues(ctx, org._id, team._id);
    const byId = new Map(all.map((issue) => [issue._id, issue]));
    const matches = all.filter(
      (issue) => (status === undefined || issue.status === status) && (assigneeId === undefined || issue.assigneeId === assigneeId)
    );
    const issues = await Promise.all(
      matches.map(async (issue) => {
        const parent = issue.parentIssueId === undefined ? undefined : byId.get(issue.parentIssueId);
        const user = issue.assigneeId === undefined ? null : await ctx.db.get(issue.assigneeId);
        return {
          ...withKey(issue, team.key, parent?.number),
          assignee: user?.name ?? null,
          parentKey: parent === undefined ? null : formatIssueKey(team.key, parent),
        };
      })
    );
    return { issues };
  },
});

export const updateIssue = internalMutation({
  args: {
    agentName: v.string(),
    key: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(issueStatusValidator),
    priority: v.optional(issuePriorityValidator),
    assignee: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ issue: keyedIssue }),
  handler: async (ctx, { agentName, key, assignee, ...fields }) => {
    const { scope, issueId, reread } = await resolveKeyedWrite(ctx, agentName, key);
    const assigneeId = await assigneeIdFor(ctx, scope, assignee);
    await updateIssueWithRules(ctx, scope, { ...fields, issueId, assigneeId });
    return { issue: await reread() };
  },
});

export const setProof = internalMutation({
  args: { agentName: v.string(), key: v.string(), proofUrl: v.string() },
  returns: v.object({ issue: keyedIssue }),
  handler: async (ctx, { agentName, key, proofUrl }) => {
    const { scope, issueId, reread } = await resolveKeyedWrite(ctx, agentName, key);
    await setIssueProof(ctx, scope, { issueId, proofUrl });
    return { issue: await reread() };
  },
});

export const createComment = internalMutation({
  args: { agentName: v.string(), key: v.string(), body: v.string() },
  returns: v.object({
    comment: v.object({
      _id: v.id("comments"),
      _creationTime: v.number(),
      orgId: v.id("organizations"),
      issueId: v.id("issues"),
      authorId: v.id("users"),
      body: v.string(),
      mentions: v.optional(v.array(v.id("users"))),
    }),
  }),
  handler: async (ctx, { agentName, key, body }) => {
    const { scope, issueId } = await resolveKeyedWrite(ctx, agentName, key);
    const commentId = await createCommentWithRules(ctx, scope, { issueId, body });
    const comment = await ctx.db.get(commentId);
    if (comment === null) {
      throw new Error(`Comment ${commentId} not found`);
    }
    return { comment };
  },
});
