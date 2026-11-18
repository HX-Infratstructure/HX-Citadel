import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, MutationCtx, QueryCtx } from "./_generated/server";
import { formatIssueKey, parseIssueKey } from "../lib/issue-key";
import { createComment as createCommentWithRules } from "./comments";
import {
  createIssue as createIssueWithRules,
  getOrgIssue,
  issueShape,
  LIST_LIMIT,
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
import { expireKeys, idempotencyValidator, Idempotency, withIdempotency } from "./lib/idempotency";
import { assertIfMatch, issueVersion } from "./lib/issueVersion";
import {
  askDecision as askDecisionWithRules,
  decisionValidator,
  listedDecisionValidator,
  listIssueDecisions,
} from "./lib/decisions";
import { inOrg, orgChildren, orgRow } from "./lib/orgRows";
import { invalid, notFound } from "./lib/refusals";
import { findTeamByKey } from "./lib/teams";
import {
  issueKindValidator,
  issuePriorityValidator,
  issueStatusValidator,
  issueTypeValidator,
} from "./schema";

const keyedIssue = v.object({ ...issueShape, key: v.union(v.string(), v.null()), version: v.number() });

/** The version the client last read; a different current version refuses the write as stale. */
const ifMatch = v.optional(v.number());

/** REST and MCP always send it; the mutation stores the result under it. */
const idempotency = v.optional(idempotencyValidator);

type Db = { db: QueryCtx["db"] };

/** Every agent write: resolve the agent, then run the write once per Idempotency-Key, in this mutation. */
async function agentWrite<T>(
  ctx: MutationCtx,
  agentName: string,
  key: Idempotency | undefined,
  write: (scope: OrgScope) => Promise<T>
): Promise<T> {
  const scope = await resolveAgentScope(ctx, agentName);
  return await withIdempotency(ctx, scope, key, () => write(scope));
}

/** The issue JSON agents see. A story's sub-task counter is server bookkeeping, so it stays out. */
function withKey(issue: Doc<"issues">, teamKey: string, parentNumber?: number) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { nextSubNumber, ...fields } = issue;
  return { ...fields, key: formatIssueKey(teamKey, issue, parentNumber), version: issueVersion(issue) };
}

async function subtasksOf(ctx: Db, orgId: Id<"organizations">, issueId: Id<"issues">): Promise<Doc<"issues">[]> {
  const subtasks = await orgChildren(ctx, orgId, issueId);
  return subtasks.sort((a, b) => (a.subNumber ?? 0) - (b.subNumber ?? 0));
}

type FoundIssue = { issue: Doc<"issues">; team: Doc<"teams">; parentNumber?: number };

/** A story by KEY-12 or a sub-task by KEY-12.3, inside the workspace. */
async function findIssueByKey(ctx: Db, orgId: Id<"organizations">, key: string): Promise<FoundIssue> {
  const parsed = parseIssueKey(key);
  if (parsed === null) {
    invalid(`invalid issue key ${key}; use KEY-12 or KEY-12.3`);
  }
  const team = await findTeamByKey(ctx, orgId, parsed.teamKey);
  const story = await inOrg(
    ctx.db.query("issues").withIndex("by_team_and_number", (q) => q.eq("teamId", team._id).eq("number", parsed.number)),
    orgId
  ).unique();
  if (story === null || story.kind !== "story") {
    notFound(`Issue ${key} not found`);
  }
  if (parsed.subNumber === undefined) {
    return { issue: story, team };
  }
  const subtask = (await subtasksOf(ctx, orgId, story._id)).find((sub) => sub.subNumber === parsed.subNumber);
  if (subtask === undefined) {
    notFound(`Issue ${key} not found`);
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
    ifMatch,
    idempotency,
  },
  returns: v.object({ issue: keyedIssue }),
  handler: (ctx, { agentName, idempotency, teamKey, parentKey, assignee, ifMatch, ...fields }) =>
    agentWrite(ctx, agentName, idempotency, async (scope) => {
      const team = await findTeamByKey(ctx, scope.org._id, teamKey);
      if (ifMatch !== undefined && parentKey === undefined) {
        invalid("If-Match applies only with parentKey");
      }
      const parent = parentKey === undefined ? null : (await findIssueByKey(ctx, scope.org._id, parentKey)).issue;
      if (parent !== null && parentKey !== undefined) {
        assertIfMatch(parent, parentKey, ifMatch);
      }
      const assigneeId = assignee === undefined ? undefined : await resolveAgentAssignee(ctx, scope.org._id, assignee);
      const issueId = await createIssueWithRules(ctx, scope, {
        ...fields,
        teamId: team._id,
        parentIssueId: parent?._id,
        assigneeId,
      });
      const issue = await getOrgIssue(ctx, scope.org._id, issueId);
      return { issue: withKey(issue, team.key, parent?.number) };
    }),
});

export const getIssue = internalQuery({
  args: { agentName: v.string(), key: v.string() },
  returns: v.object({ issue: keyedIssue, subtasks: v.array(keyedIssue) }),
  handler: async (ctx, { agentName, key }) => {
    const org = await resolveAgentReadScope(ctx, agentName);
    const { issue, team, parentNumber } = await findIssueByKey(ctx, org._id, key);
    const subtasks = await subtasksOf(ctx, org._id, issue._id);
    return {
      issue: withKey(issue, team.key, parentNumber),
      subtasks: subtasks.map((subtask) => withKey(subtask, team.key, issue.number)),
    };
  },
});

/** The issue a write names, by key, checked against If-Match before any write and re-read after it. */
async function resolveKeyedWrite(ctx: MutationCtx, scope: OrgScope, key: string, ifMatch: number | undefined) {
  const found = await findIssueByKey(ctx, scope.org._id, key);
  assertIfMatch(found.issue, key, ifMatch);
  const reread = async () => withKey(await getOrgIssue(ctx, scope.org._id, found.issue._id), found.team.key, found.parentNumber);
  return { issueId: found.issue._id, reread };
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

/** A failed `.paginate` is the client's only when it sent a cursor and Convex names the cursor (`InvalidCursor`); anything else stays a 500. */
export function pageFailure(error: unknown, cursor: string | undefined): never {
  if (cursor !== undefined && error instanceof Error && /cursor/i.test(error.message)) {
    invalid("cursor must be the nextCursor of an earlier page of this list");
  }
  throw error;
}

const listedIssue = v.object({
  ...issueShape,
  key: v.union(v.string(), v.null()),
  assignee: v.union(v.string(), v.null()),
  parentKey: v.union(v.string(), v.null()),
  version: v.number(),
});

export const listIssues = internalQuery({
  args: {
    agentName: v.string(),
    teamKey: v.string(),
    status: v.optional(issueStatusValidator),
    assignee: v.optional(v.string()),
    /** The `nextCursor` of the previous page; absent for the first page. */
    cursor: v.optional(v.string()),
  },
  returns: v.object({ issues: v.array(listedIssue), nextCursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { agentName, teamKey, status, assignee, cursor }) => {
    if (cursor === "") {
      invalid("cursor cannot be empty");
    }
    const org = await resolveAgentReadScope(ctx, agentName);
    const team = await findTeamByKey(ctx, org._id, teamKey);
    const assigneeId = await assigneeFilter(ctx, org._id, agentName, assignee);
    if (assigneeId === null) {
      return { issues: [], nextCursor: null };
    }
    const page = await ctx.db
      .query("issues")
      .withIndex("by_team", (q) => q.eq("teamId", team._id))
      .order("desc")
      // No index covers team plus workspace, an optional status and an assignee; the filter runs before the page limit, so no match is cut.
      // eslint-disable-next-line @convex-dev/no-filter-in-query
      .filter((q) =>
        q.and(
          q.eq(q.field("orgId"), org._id),
          q.or(status === undefined, q.eq(q.field("status"), status)),
          q.or(assigneeId === undefined, q.eq(q.field("assigneeId"), assigneeId))
        )
      )
      .paginate({ numItems: LIST_LIMIT, cursor: cursor ?? null })
      .catch((error: unknown) => pageFailure(error, cursor));
    const parents = new Map<Id<"issues">, Promise<Doc<"issues"> | null>>();
    const parentOf = (parentId: Id<"issues">) => {
      if (!parents.has(parentId)) {
        parents.set(parentId, orgRow(ctx, org._id, parentId));
      }
      return parents.get(parentId)!;
    };
    const issues = await Promise.all(
      page.page.map(async (issue) => {
        const parent = issue.parentIssueId === undefined ? null : await parentOf(issue.parentIssueId);
        const user = issue.assigneeId === undefined ? null : await ctx.db.get(issue.assigneeId);
        return {
          ...withKey(issue, team.key, parent?.number),
          assignee: user?.name ?? null,
          parentKey: parent === null ? null : formatIssueKey(team.key, parent),
        };
      })
    );
    return { issues, nextCursor: page.isDone ? null : page.continueCursor };
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
    ifMatch,
    idempotency,
  },
  returns: v.object({ issue: keyedIssue }),
  handler: (ctx, { agentName, idempotency, key, assignee, ifMatch, ...fields }) =>
    agentWrite(ctx, agentName, idempotency, async (scope) => {
      const { issueId, reread } = await resolveKeyedWrite(ctx, scope, key, ifMatch);
      const assigneeId = await assigneeIdFor(ctx, scope, assignee);
      await updateIssueWithRules(ctx, scope, { ...fields, issueId, assigneeId });
      return { issue: await reread() };
    }),
});

export const setProof = internalMutation({
  args: { agentName: v.string(), key: v.string(), proofUrl: v.string(), ifMatch, idempotency },
  returns: v.object({ issue: keyedIssue }),
  handler: (ctx, { agentName, idempotency, key, proofUrl, ifMatch }) =>
    agentWrite(ctx, agentName, idempotency, async (scope) => {
      const { issueId, reread } = await resolveKeyedWrite(ctx, scope, key, ifMatch);
      await setIssueProof(ctx, scope, { issueId, proofUrl });
      return { issue: await reread() };
    }),
});

export const createComment = internalMutation({
  args: { agentName: v.string(), key: v.string(), body: v.string(), ifMatch, idempotency },
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
  handler: (ctx, { agentName, idempotency, key, body, ifMatch }) =>
    agentWrite(ctx, agentName, idempotency, async (scope) => {
      const { issueId } = await resolveKeyedWrite(ctx, scope, key, ifMatch);
      const commentId = await createCommentWithRules(ctx, scope, { issueId, body });
      const comment = await ctx.db.get(commentId);
      if (comment === null) {
        throw new Error(`Comment ${commentId} not found`);
      }
      return { comment };
    }),
});

export const askDecision = internalMutation({
  args: {
    agentName: v.string(),
    key: v.string(),
    question: v.string(),
    choices: v.optional(v.array(v.string())),
    recommended: v.optional(v.string()),
    ifMatch,
    idempotency,
  },
  returns: v.object({ decision: decisionValidator }),
  handler: (ctx, { agentName, idempotency, key, ifMatch, ...ask }) =>
    agentWrite(ctx, agentName, idempotency, async (scope) => {
      const { issueId } = await resolveKeyedWrite(ctx, scope, key, ifMatch);
      return { decision: await askDecisionWithRules(ctx, scope, { ...ask, issueId }) };
    }),
});

export const listDecisions = internalQuery({
  args: { agentName: v.string(), key: v.string() },
  returns: v.object({ decisions: v.array(listedDecisionValidator) }),
  handler: async (ctx, { agentName, key }) => {
    const org = await resolveAgentReadScope(ctx, agentName);
    const { issue } = await findIssueByKey(ctx, org._id, key);
    return { decisions: await listIssueDecisions(ctx, org._id, issue._id) };
  },
});

/** The hourly cron's TTL sweep of stored Idempotency-Key results. */
export const expireIdempotencyKeys = internalMutation({
  args: {},
  returns: v.number(),
  handler: (ctx) => expireKeys(ctx, Date.now()),
});
