import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, QueryCtx } from "./_generated/server";
import { formatIssueKey, parseIssueKey } from "../lib/issue-key";
import { createIssue as createIssueWithRules, getOrgIssue, issueShape } from "./issues";
import { resolveAgentAssignee, resolveAgentReadScope, resolveAgentScope } from "./lib/orgScope";
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
