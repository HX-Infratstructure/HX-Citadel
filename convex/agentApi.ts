import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, MutationCtx, QueryCtx } from "./_generated/server";
import { parseIssueKey } from "../lib/issue-key";
import { createComment as createCommentWithRules } from "./comments";
import {
  capPage,
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
import { IssueKeys } from "./lib/issueKeys";
import { assertIfMatch, issueVersion } from "./lib/issueVersion";
import {
  askDecision as askDecisionWithRules,
  decisionValidator,
  listedDecisionValidator,
  listIssueDecisions,
} from "./lib/decisions";
import { inOrg, orgChildren } from "./lib/orgRows";
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
async function withKey(keys: IssueKeys, issue: Doc<"issues">) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { nextSubNumber, ...fields } = issue;
  return { ...fields, key: await keys.key(issue), version: issueVersion(issue) };
}

async function subtasksOf(ctx: Db, orgId: Id<"organizations">, issueId: Id<"issues">): Promise<Doc<"issues">[]> {
  const subtasks = await orgChildren(ctx, orgId, issueId);
  return subtasks.sort((a, b) => (a.subNumber ?? 0) - (b.subNumber ?? 0));
}

type FoundIssue = { issue: Doc<"issues">; team: Doc<"teams"> };

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
  return { issue: subtask, team };
}

/** The issue a write names, by key, checked against If-Match before any write. */
async function findWriteTarget(ctx: Db, orgId: Id<"organizations">, key: string, ifMatch: number | undefined): Promise<FoundIssue> {
  const found = await findIssueByKey(ctx, orgId, key);
  assertIfMatch(found.issue, key, ifMatch);
  return found;
}

export const createIssue = internalMutation({
  args: {
    agentName: v.string(),
    /** Required for a root issue; a child takes its parent's team, and a different one is refused. */
    teamKey: v.optional(v.string()),
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
      const namedTeam = teamKey === undefined ? undefined : await findTeamByKey(ctx, scope.org._id, teamKey);
      if (ifMatch !== undefined && parentKey === undefined) {
        invalid("If-Match applies only with parentKey");
      }
      const parent = parentKey === undefined ? undefined : await findWriteTarget(ctx, scope.org._id, parentKey, ifMatch);
      const team = namedTeam ?? parent?.team;
      if (team === undefined) {
        invalid("teamKey is required when there is no parentKey");
      }
      const assigneeId = assignee === undefined ? undefined : await resolveAgentAssignee(ctx, scope.org._id, assignee);
      const issueId = await createIssueWithRules(ctx, scope, {
        ...fields,
        teamId: team._id,
        parentIssueId: parent?.issue._id,
        assigneeId,
      });
      const issue = await getOrgIssue(ctx, scope.org._id, issueId);
      return { issue: await withKey(new IssueKeys(ctx, scope.org._id), issue) };
    }),
});

export const getIssue = internalQuery({
  args: { agentName: v.string(), key: v.string() },
  returns: v.object({ issue: keyedIssue, subtasks: v.array(keyedIssue) }),
  handler: async (ctx, { agentName, key }) => {
    const org = await resolveAgentReadScope(ctx, agentName);
    const { issue } = await findIssueByKey(ctx, org._id, key);
    const subtasks = await subtasksOf(ctx, org._id, issue._id);
    const keys = new IssueKeys(ctx, org._id);
    return {
      issue: await withKey(keys, issue),
      subtasks: await Promise.all(subtasks.map((subtask) => withKey(keys, subtask))),
    };
  },
});

/** The issue a write names, by key, checked against If-Match before any write and re-read after it. */
async function resolveKeyedWrite(ctx: MutationCtx, scope: OrgScope, key: string, ifMatch: number | undefined) {
  const found = await findWriteTarget(ctx, scope.org._id, key, ifMatch);
  const reread = async () => withKey(new IssueKeys(ctx, scope.org._id), await getOrgIssue(ctx, scope.org._id, found.issue._id));
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

/**
 * The self-hosted backend's whole answer to a cursor it cannot parse, with no data and no `InvalidCursor` name.
 * Captured on HX-18 at 2026-11-18T20:12Z for `cursor=garbage` and `cursor=["x",1]`.
 */
const BACKEND_BAD_CURSOR = "Failed to parse cursor";

/**
 * Convex's own invalid-cursor rule, as its client applies it (`usePaginatedQuery` in convex@1.41.0): a system
 * `ConvexError` with `paginationError: "InvalidCursor"`, or, from a backend that sends no data, that name in the
 * message. The self-hosted backend sends neither, only `BACKEND_BAD_CURSOR`. No typed error class exists, so these
 * two phrases are the only word matches here.
 */
function isInvalidCursor(error: unknown): boolean {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const flagged =
    typeof data === "object" &&
    data !== null &&
    "isConvexSystemError" in data &&
    data.isConvexSystemError === true &&
    "paginationError" in data &&
    data.paginationError === "InvalidCursor";
  const named = error instanceof Error && (error.message.includes("InvalidCursor") || error.message.includes(BACKEND_BAD_CURSOR));
  return flagged || named;
}

/** A failed `.paginate` is the client's only when it sent a cursor and Convex calls it invalid; anything else stays a 500. */
export function pageFailure(error: unknown, cursor: string | undefined): never {
  if (cursor !== undefined && isInvalidCursor(error)) {
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
      // No index covers team, workspace, an optional status and an assignee, so the filter runs inside the query.
      // `capPage` caps the rows it reads: a page can come back short, or empty, with a cursor that skips no match.
      // eslint-disable-next-line @convex-dev/no-filter-in-query
      .filter((q) =>
        q.and(
          q.eq(q.field("orgId"), org._id),
          q.or(status === undefined, q.eq(q.field("status"), status)),
          q.or(assigneeId === undefined, q.eq(q.field("assigneeId"), assigneeId))
        )
      )
      .paginate(capPage({ numItems: LIST_LIMIT, cursor: cursor ?? null }))
      .catch((error: unknown) => pageFailure(error, cursor));
    const keys = new IssueKeys(ctx, org._id);
    const issues = await Promise.all(
      page.page.map(async (issue) => {
        const user = issue.assigneeId === undefined ? null : await ctx.db.get(issue.assigneeId);
        return {
          ...(await withKey(keys, issue)),
          assignee: user?.name ?? null,
          parentKey: await keys.parentKey(issue),
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
