import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ObjectType, v } from "convex/values";
import { invalid, notFound, refuse } from "./lib/refusals";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { PARENT_KIND } from "../lib/issue-key";
import { SORT_GAP } from "../lib/sort-order";
import { changedFields, fieldText, FieldLogOptions, logActivity, logFieldChanges } from "./lib/activity";
import { orgAdminMutation, orgMutation, orgQuery } from "./lib/customFunctions";
import { IssueKeys } from "./lib/issueKeys";
import { LIST_LIMIT } from "./lib/issues/paging";
import { setIssueProof } from "./lib/issues/proof";
import { backlogPage, parentCandidates, storyByNumber, teamPage } from "./lib/issues/queries";
import { placeRank } from "./lib/issues/ranking";
import { getOrgIssue, issueShape } from "./lib/issues/shape";
import { patchIssue } from "./lib/issueVersion";
import { findMembership } from "./lib/mirror";
import { inOrg, orgRow, requireOrgRow } from "./lib/orgRows";
import { OrgScope } from "./lib/orgScope";
import { assertCycleInTeam } from "./lib/rules/cycles";
import { assertDoneGate, assertDoneGateAfterUpdate } from "./lib/rules/doneGate";
import {
  assertParentOpen,
  assertValidParent,
  cascadeProject,
  FIRST_SUB_NUMBER,
  nextSubNumber,
} from "./lib/rules/levels";
import { createTestingSubtask } from "./lib/rules/testing";
import { assertWipFree, assertWipFreeAfterUpdate } from "./lib/rules/wip";
import {
  issueKindValidator,
  issuePriorityValidator,
  issueStatusValidator,
  issueTypeValidator,
} from "./schema";

export { capPage, LIST_LIMIT, PAGE_READ_ROWS, PINNED_PAGE_MAX_ROWS } from "./lib/issues/paging";
export { setIssueProof } from "./lib/issues/proof";
export { getOrgIssue, issueShape } from "./lib/issues/shape";

export const listBacklog = orgQuery({
  args: { teamId: v.id("teams"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object(issueShape)),
  handler: async (ctx, args) => await backlogPage(ctx, args),
});

export const listByTeam = orgQuery({
  args: { teamId: v.id("teams"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ ...issueShape, labelIds: v.array(v.id("labels")) })),
  handler: async (ctx, args) => await teamPage(ctx, args),
});

export const listParentCandidates = orgQuery({
  args: { teamId: v.id("teams"), kind: issueKindValidator },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => await parentCandidates(ctx, args),
});

export const get = orgQuery({
  args: { issueId: v.id("issues") },
  returns: v.union(v.object(issueShape), v.null()),
  handler: async (ctx, args) => await orgRow(ctx, ctx.org._id, args.issueId),
});

export const getByNumber = orgQuery({
  args: { teamId: v.id("teams"), number: v.number() },
  returns: v.union(v.object(issueShape), v.null()),
  handler: async (ctx, args) => await storyByNumber(ctx, args),
});

/** An assignee must be a member of the workspace. A non-member is never loaded, so the refusal can't name them. */
async function assertAssignee(ctx: MutationCtx, orgId: Id<"organizations">, userId: Id<"users">): Promise<void> {
  if ((await findMembership(ctx, orgId, userId)) === null) {
    notFound("Assignee not found");
  }
}

/** A title as stored: trimmed, and never empty. Every create and update path comes through here. */
function issueTitle(text: string): string {
  const title = text.trim();
  if (title === "") {
    invalid("Title cannot be empty");
  }
  return title;
}

/** Stories carry a type (default story); other levels carry none. */
export function storyType(
  kind: Doc<"issues">["kind"],
  type: Doc<"issues">["type"]
): Doc<"issues">["type"] {
  return kind === "story" ? (type ?? "story") : undefined;
}

/**
 * Stories take the next team number (ENG-1, ENG-2, ...) and start their own subtask counter;
 * subtasks take the next number under their story.
 */
async function claimNumbering(
  ctx: MutationCtx,
  team: Doc<"teams">,
  kind: Doc<"issues">["kind"],
  parentIssueId: Id<"issues"> | undefined
): Promise<Pick<Doc<"issues">, "number" | "subNumber" | "nextSubNumber">> {
  if (kind === "story") {
    const number = team.nextIssueNumber;
    await ctx.db.patch(team._id, { nextIssueNumber: number + 1 });
    return { number, nextSubNumber: FIRST_SUB_NUMBER };
  }
  if (kind === "subtask" && parentIssueId) {
    return { subNumber: await nextSubNumber(ctx, team.orgId, parentIssueId) };
  }
  return {};
}

const createArgs = {
  teamId: v.id("teams"),
  kind: v.optional(issueKindValidator),
  type: v.optional(issueTypeValidator),
  title: v.string(),
  description: v.optional(v.string()),
  status: v.optional(issueStatusValidator),
  priority: v.optional(issuePriorityValidator),
  assigneeId: v.optional(v.id("users")),
  projectId: v.optional(v.id("projects")),
  cycleId: v.optional(v.id("cycles")),
  parentIssueId: v.optional(v.id("issues")),
  estimate: v.optional(v.number()),
  dueDate: v.optional(v.number()),
};

export type CreateIssueArgs = ObjectType<typeof createArgs>;

/** Every create rule in one place; the Clerk session and agent calls both come through here. */
export async function createIssue(
  ctx: MutationCtx,
  scope: OrgScope,
  args: CreateIssueArgs
): Promise<Id<"issues">> {
  const { org, actorId } = scope;
  const title = issueTitle(args.title);
  const team = await requireOrgRow(ctx, org._id, args.teamId, "Team");

  const kind = args.kind ?? "story";
  const parent = args.parentIssueId ? await getOrgIssue(ctx, org._id, args.parentIssueId) : null;
  const placement = await assertValidParent(ctx, org._id, kind, {
    teamId: args.teamId,
    parentIssueId: args.parentIssueId,
    projectId: args.projectId,
  });
  if (parent !== null) {
    await assertParentOpen(ctx, parent, kind);
  }
  if (args.cycleId !== undefined) {
    await assertCycleInTeam(ctx, org._id, args.cycleId, placement.teamId);
  }
  if (args.assigneeId !== undefined) {
    await assertAssignee(ctx, org._id, args.assigneeId);
  }
  const status = args.status ?? "todo";
  await assertWipFree(ctx, { orgId: org._id, assigneeId: args.assigneeId, kind, status });
  const numbering = await claimNumbering(ctx, team, kind, args.parentIssueId);

  // New issues sort to the top of their column.
  const highest = await inOrg(
    ctx.db.query("issues").withIndex("by_team_and_sort_order", (q) => q.eq("teamId", placement.teamId)).order("desc"),
    org._id
  ).first();
  const sortOrder = (highest?.sortOrder ?? 0) + SORT_GAP;

  const issueId = await ctx.db.insert("issues", {
    orgId: org._id,
    teamId: placement.teamId,
    kind,
    type: storyType(kind, args.type),
    ...numbering,
    title,
    description: args.description,
    status,
    priority: args.priority ?? "none",
    assigneeId: args.assigneeId,
    creatorId: actorId,
    projectId: placement.projectId,
    cycleId: args.cycleId,
    parentIssueId: args.parentIssueId,
    estimate: args.estimate,
    dueDate: args.dueDate,
    sortOrder,
  });
  const created = await ctx.db.get(issueId);
  if (created?.kind === "story") {
    await createTestingSubtask(ctx, created);
  }
  if (created !== null) {
    await assertDoneGate(ctx, created, status);
  }

  await logActivity(ctx, { orgId: org._id, issueId, actorId, type: "created" });

  return issueId;
}

export const create = orgMutation({
  args: createArgs,
  returns: v.id("issues"),
  handler: async (ctx, args) =>
    await createIssue(ctx, { org: ctx.org, actorId: ctx.user._id }, args),
});

const updateArgs = {
  issueId: v.id("issues"),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  status: v.optional(issueStatusValidator),
  priority: v.optional(issuePriorityValidator),
  assigneeId: v.optional(v.union(v.id("users"), v.null())),
  projectId: v.optional(v.union(v.id("projects"), v.null())),
  cycleId: v.optional(v.union(v.id("cycles"), v.null())),
  estimate: v.optional(v.union(v.number(), v.null())),
  dueDate: v.optional(v.union(v.number(), v.null())),
  sortOrder: v.optional(v.number()),
};

export type UpdateIssueArgs = ObjectType<typeof updateArgs>;

/** Every update rule in one place; the Clerk session and agent calls both come through here. */
export async function updateIssue(
  ctx: MutationCtx,
  scope: OrgScope,
  args: UpdateIssueArgs,
  log: FieldLogOptions = {}
): Promise<void> {
  const issue = await getOrgIssue(ctx, scope.org._id, args.issueId);

  const actor = { orgId: scope.org._id, actorId: scope.actorId };
  const updates: Partial<Doc<"issues">> = {};

  if (args.title !== undefined) {
    const title = issueTitle(args.title);
    if (title !== issue.title) {
      updates.title = title;
    }
  }
  if (args.description !== undefined) {
    updates.description = args.description;
  }
  if (args.status !== undefined && args.status !== issue.status) {
    updates.status = args.status;
  }
  if (args.priority !== undefined && args.priority !== issue.priority) {
    updates.priority = args.priority;
  }
  if (args.assigneeId !== undefined) {
    if (args.assigneeId !== null) {
      await assertAssignee(ctx, scope.org._id, args.assigneeId);
    }
    updates.assigneeId = args.assigneeId ?? undefined;
  }
  if (args.projectId !== undefined) {
    const placement = await assertValidParent(ctx, scope.org._id, issue.kind, {
      teamId: issue.teamId,
      parentIssueId: issue.parentIssueId,
      projectId: args.projectId ?? undefined,
    });
    if (args.projectId === null && placement.projectId !== undefined) {
      const parentKind = PARENT_KIND[issue.kind];
      refuse(
        `This ${issue.kind}'s project comes from its ${parentKind}; move it out of the ${parentKind} to clear the project`
      );
    }
    updates.projectId = placement.projectId;
    await cascadeProject(ctx, issue, placement.projectId, actor);
  }
  if (args.cycleId !== undefined) {
    if (args.cycleId !== null) {
      await assertCycleInTeam(ctx, scope.org._id, args.cycleId, issue.teamId);
    }
    updates.cycleId = args.cycleId ?? undefined;
  }
  if (args.estimate !== undefined) {
    updates.estimate = args.estimate ?? undefined;
  }
  if (args.dueDate !== undefined) {
    updates.dueDate = args.dueDate ?? undefined;
  }
  if (args.sortOrder !== undefined && args.sortOrder !== issue.sortOrder) {
    updates.sortOrder = await placeRank(ctx, issue, args.sortOrder);
  }

  await assertWipFreeAfterUpdate(ctx, issue, updates);
  await assertDoneGateAfterUpdate(ctx, issue, updates);
  await patchIssue(ctx, issue._id, updates);
  await logFieldChanges(ctx, actor, issue._id, changedFields(issue, updates), log);
}

export const update = orgMutation({
  args: updateArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await updateIssue(ctx, { org: ctx.org, actorId: ctx.user._id }, args);
    return null;
  },
});

function literalOf<T extends string>(validator: { members: { value: T }[] }, text: string | undefined): T {
  const member = validator.members.find((candidate) => candidate.value === text);
  if (!member) {
    refuse(`Unknown value ${text}`);
  }
  return member.value;
}

/** A recorded assignee: absent means unassigned. `updateIssue` checks that anyone else is still a member. */
function assigneeOf(ctx: MutationCtx, text: string | undefined) {
  if (text === undefined) {
    return null;
  }
  const userId = ctx.db.normalizeId("users", text);
  if (!userId) {
    refuse(`Unknown value ${text}`);
  }
  return userId;
}

type RevertArgs = Omit<UpdateIssueArgs, "issueId">;
type ToRevertArgs = (ctx: MutationCtx, issue: Doc<"issues">, text: string | undefined) => Promise<RevertArgs>;

/** The fields a revert may touch, each turning recorded text back into its update argument. */
const REVERT_ARGS: Record<string, ToRevertArgs> = {
  title: async (_ctx, _issue, text) => ({ title: text ?? "" }),
  status: async (_ctx, _issue, text) => ({ status: literalOf(issueStatusValidator, text) }),
  priority: async (_ctx, _issue, text) => ({ priority: literalOf(issuePriorityValidator, text) }),
  assignee: async (ctx, _issue, text) => ({ assigneeId: assigneeOf(ctx, text) }),
};

/** The issue's activity, newest first: by creation time, then `_id`, the `by_issue` index order. */
export function activityNewestFirst(ctx: { db: QueryCtx["db"] }, issue: Doc<"issues">) {
  return inOrg(
    ctx.db.query("activity").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).order("desc"),
    issue.orgId
  );
}

/**
 * Why an owner can't revert `row`, or null when they can. Only a `<field>_changed` row of a field in
 * `REVERT_ARGS` can be reverted, while it is the newest row for its field and the issue still holds its new value.
 * A `reverted` row never is: to redo, make the change again.
 */
function revertRefusal(issue: Doc<"issues">, row: Doc<"activity">, newestForField: boolean) {
  if (row.field === undefined || !(row.field in REVERT_ARGS) || row.type !== `${row.field}_changed`) {
    return "not_revertible";
  }
  if (!newestForField || fieldText(issue, row.field) !== row.newValue) {
    return "changed_since";
  }
  return null;
}

/** The rows of `newestFirst`, an `activityNewestFirst` prefix, that an owner can revert. */
export function revertibleRows(issue: Doc<"issues">, newestFirst: Doc<"activity">[]): Set<Id<"activity">> {
  const seenFields = new Set<string | undefined>();
  const revertible = new Set<Id<"activity">>();
  for (const row of newestFirst) {
    if (revertRefusal(issue, row, !seenFields.has(row.field)) === null) {
      revertible.add(row._id);
    }
    seenFields.add(row.field);
  }
  return revertible;
}

/**
 * Whether `row` is the newest activity row for its field among the issue's newest `LIST_LIMIT` rows, the window
 * the feed offers Revert in. A row outside it is not offered, so `revertChange` refuses it too.
 */
async function isNewestForField(ctx: MutationCtx, issue: Doc<"issues">, row: Doc<"activity">) {
  const recent = await activityNewestFirst(ctx, issue).take(LIST_LIMIT);
  return recent.find((newer) => newer.field === row.field)?._id === row._id;
}

/** Apply an activity row's old value back through `updateIssue`, logged as one `reverted` row. */
export const revertChange = orgAdminMutation({
  args: { activityId: v.id("activity") },
  returns: v.null(),
  handler: async (ctx, { activityId }) => {
    const change = await requireOrgRow(ctx, ctx.org._id, activityId, "Change");
    const issue = await getOrgIssue(ctx, ctx.org._id, change.issueId);
    const refusal = revertRefusal(issue, change, await isNewestForField(ctx, issue, change));
    if (refusal === "not_revertible") {
      refuse("Only status, assignee, priority and title changes can be reverted");
    }
    if (refusal === "changed_since") {
      const name = await new IssueKeys(ctx, issue.orgId).name(issue);
      refuse(`${name} ${change.field} has changed since; revert the latest change instead`);
    }
    const toArgs = REVERT_ARGS[change.field!];
    await updateIssue(
      ctx,
      { org: ctx.org, actorId: ctx.user._id },
      { issueId: issue._id, ...(await toArgs(ctx, issue, change.oldValue)) },
      { type: "reverted" }
    );
    return null;
  },
});

export const setProof = orgMutation({
  args: { issueId: v.id("issues"), proofUrl: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await setIssueProof(ctx, { org: ctx.org, actorId: ctx.user._id }, args);
    return null;
  },
});
