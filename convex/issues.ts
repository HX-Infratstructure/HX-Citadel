import { ObjectType, v } from "convex/values";
import { notFound, refuse } from "./lib/refusals";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { formatIssueKey, PARENT_KIND } from "../lib/issue-key";
import { isGatedStatus } from "../lib/issue-status";
import { respaceTie, SORT_GAP } from "../lib/sort-order";
import { changedFields, fieldText, FieldLogOptions, logActivity, logFieldChanges } from "./lib/activity";
import { orgAdminMutation, orgMutation, orgQuery } from "./lib/customFunctions";
import { deleteIssueOwnedRows } from "./lib/issueCleanup";
import { FIRST_VERSION, patchIssue } from "./lib/issueVersion";
import { findMembership } from "./lib/mirror";
import { inOrg, orgChildren, orgRow, requireOrgRow } from "./lib/orgRows";
import { OrgScope } from "./lib/orgScope";
import { assertCycleInTeam } from "./lib/rules/cycles";
import {
  assertDoneGate,
  assertDoneGateAfterUpdate,
  CLOSED_STATUSES,
} from "./lib/rules/doneGate";
import {
  assertNoChildren,
  assertParentOpen,
  assertValidParent,
  cascadeProject,
  nextSubNumber,
  retireSubNumber,
} from "./lib/rules/levels";
import {
  assertNotTestingSubtask,
  assertProofUrl,
  assertTestingSubtask,
  createTestingSubtask,
} from "./lib/rules/testing";
import { assertWipFree, assertWipFreeAfterUpdate } from "./lib/rules/wip";
import {
  issueKindValidator,
  issuePriorityValidator,
  issueStatusValidator,
  issueTypeValidator,
} from "./schema";

export const issueShape = {
  _id: v.id("issues"),
  _creationTime: v.number(),
  orgId: v.id("organizations"),
  teamId: v.id("teams"),
  kind: issueKindValidator,
  type: v.optional(issueTypeValidator),
  number: v.optional(v.number()),
  subNumber: v.optional(v.number()),
  nextSubNumber: v.optional(v.number()),
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
  dueDate: v.optional(v.number()),
  sortOrder: v.number(),
  testing: v.optional(v.boolean()),
  proofUrl: v.optional(v.string()),
  version: v.optional(v.number()),
};

/** Verify an issue belongs to the caller's org before any read/write. */
export async function getOrgIssue(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  issueId: Id<"issues">
): Promise<Doc<"issues">> {
  return await requireOrgRow(ctx, orgId, issueId, "Issue");
}

/** The most issues one list returns, newest first. */
export const LIST_LIMIT = 500;

/** A team's issues, newest first, inside the caller's workspace. */
export async function listTeamIssues(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  teamId: Id<"teams">
): Promise<Doc<"issues">[]> {
  await requireOrgRow(ctx, orgId, teamId, "Team");
  return await inOrg(
    ctx.db.query("issues").withIndex("by_team", (q) => q.eq("teamId", teamId)).order("desc"),
    orgId
  ).take(LIST_LIMIT);
}

export const listByTeam = orgQuery({
  args: { teamId: v.id("teams") },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => await listTeamIssues(ctx, ctx.org._id, args.teamId),
});

const OPEN_STATUSES = issueStatusValidator.members
  .map((member) => member.value)
  .filter((status) => !CLOSED_STATUSES.has(status));

/**
 * The backlog: open stories with no cycle, highest `sortOrder` (owner's rank) first.
 * Reads open statuses only, so a long closed history never counts against the read limit.
 */
export const listBacklog = orgQuery({
  args: { teamId: v.id("teams") },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.teamId, "Team");
    const byStatus = await Promise.all(
      OPEN_STATUSES.map((status) =>
        inOrg(
          ctx.db.query("issues").withIndex("by_team_and_status", (q) => q.eq("teamId", args.teamId).eq("status", status)),
          ctx.org._id
        ).collect()
      )
    );
    return byStatus
      .flat()
      .filter((issue) => issue.kind === "story" && issue.cycleId === undefined)
      .sort((a, b) => b.sortOrder - a.sortOrder);
  },
});

const PARENT_STATUSES = issueStatusValidator.members
  .map((member) => member.value)
  .filter((status) => !isGatedStatus(status));

/** The issues a child of `kind` may sit under: the team's issues one level up that are not In Review or Done, newest first. */
export const listParentCandidates = orgQuery({
  args: { teamId: v.id("teams"), kind: issueKindValidator },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.teamId, "Team");
    const parentKind = PARENT_KIND[args.kind];
    if (parentKind === null) {
      return [];
    }
    const byStatus = await Promise.all(
      PARENT_STATUSES.map((status) =>
        inOrg(
          ctx.db
            .query("issues")
            .withIndex("by_team_kind_status", (q) => q.eq("teamId", args.teamId).eq("kind", parentKind).eq("status", status)),
          ctx.org._id
        ).collect()
      )
    );
    return byStatus.flat().sort((a, b) => b._creationTime - a._creationTime);
  },
});

export const get = orgQuery({
  args: { issueId: v.id("issues") },
  returns: v.union(v.object(issueShape), v.null()),
  handler: async (ctx, args) => await orgRow(ctx, ctx.org._id, args.issueId),
});

/** Look up a story by its display identifier (team key + number, e.g. ENG-42). */
export const getByNumber = orgQuery({
  args: { teamId: v.id("teams"), number: v.number() },
  returns: v.union(v.object(issueShape), v.null()),
  handler: async (ctx, args) => {
    if ((await orgRow(ctx, ctx.org._id, args.teamId)) === null) {
      return null;
    }
    const issue = await inOrg(
      ctx.db.query("issues").withIndex("by_team_and_number", (q) => q.eq("teamId", args.teamId).eq("number", args.number)),
      ctx.org._id
    ).unique();
    return issue?.kind === "story" ? issue : null;
  },
});

/** An assignee must be a member of the workspace. */
async function assertAssignee(ctx: MutationCtx, orgId: Id<"organizations">, userId: Id<"users">): Promise<void> {
  if ((await findMembership(ctx, orgId, userId)) !== null) {
    return;
  }
  const user = await ctx.db.get(userId);
  notFound(`Assignee ${user?.name ?? userId} not found`);
}

/** Stories carry a type (default story); other levels carry none. */
export function storyType(
  kind: Doc<"issues">["kind"],
  type: Doc<"issues">["type"]
): Doc<"issues">["type"] {
  return kind === "story" ? (type ?? "story") : undefined;
}

/** Stories take the next team number (ENG-1, ENG-2, ...); subtasks the next number under their story. */
async function claimNumbering(
  ctx: MutationCtx,
  team: Doc<"teams">,
  kind: Doc<"issues">["kind"],
  parentIssueId: Id<"issues"> | undefined
): Promise<Pick<Doc<"issues">, "number" | "subNumber">> {
  if (kind === "story") {
    const number = team.nextIssueNumber;
    await ctx.db.patch(team._id, { nextIssueNumber: number + 1 });
    return { number };
  }
  if (kind === "subtask" && parentIssueId) {
    return { subNumber: await nextSubNumber(ctx, parentIssueId) };
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
    title: args.title.trim(),
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
    version: FIRST_VERSION,
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

/** The team's issues at `rank`, other than `issue`, in creation order. */
async function othersAtRank(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  rank: number
): Promise<Doc<"issues">[]> {
  const atRank = await inOrg(
    ctx.db.query("issues").withIndex("by_team_and_sort_order", (q) => q.eq("teamId", issue.teamId).eq("sortOrder", rank)),
    issue.orgId
  ).collect();
  return atRank.filter((other) => other._id !== issue._id);
}

/** The team's closest rank below `rank`, if any. */
async function nextLowerRank(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  rank: number
): Promise<number | undefined> {
  const nextLower = await inOrg(
    ctx.db
      .query("issues")
      .withIndex("by_team_and_sort_order", (q) => q.eq("teamId", issue.teamId).lt("sortOrder", rank))
      .order("desc"),
    issue.orgId
  ).first();
  return nextLower?.sortOrder;
}

/**
 * The rank to store for an issue moved to `rank`. Other issues in the team that
 * already hold `rank` are re-spaced first, in creation order, and the moved
 * issue takes a rank inside their run, so it never ties a neighbour. When the
 * gap to the next lower rank can't hold distinct numbers, the issues at that
 * rank join the run and the gap widens to the rank below them.
 */
async function placeRank(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  rank: number
): Promise<number> {
  const tied = await othersAtRank(ctx, issue, rank);
  if (tied.length === 0) {
    return rank;
  }
  const below: Doc<"issues">[] = [];
  let floor = await nextLowerRank(ctx, issue, rank);
  let ranks = respaceTie(rank, tied.length, floor, below.length);
  while (ranks === undefined && floor !== undefined) {
    below.push(...(await othersAtRank(ctx, issue, floor)));
    floor = await nextLowerRank(ctx, issue, floor);
    ranks = respaceTie(rank, tied.length, floor, below.length);
  }
  if (ranks === undefined) {
    refuse("There is no room to rank this issue here");
  }
  for (const [index, other] of tied.entries()) {
    await patchIssue(ctx, other, { sortOrder: ranks.tied[index] });
  }
  for (const [index, other] of below.entries()) {
    await patchIssue(ctx, other, { sortOrder: ranks.below[index] });
  }
  return ranks.moved;
}

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

  if (args.title !== undefined && args.title !== issue.title) {
    updates.title = args.title.trim();
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
    if (placement.projectId !== issue.projectId) {
      await cascadeProject(ctx, issue._id, placement.projectId, actor);
    }
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

/** Whether `row` is the newest activity row for its field; the walk stops at `row` itself. */
async function isNewestForField(ctx: MutationCtx, issue: Doc<"issues">, row: Doc<"activity">) {
  for await (const newer of activityNewestFirst(ctx, issue)) {
    if (newer.field === row.field) {
      return newer._id === row._id;
    }
  }
  return false;
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
      const team = await orgRow(ctx, issue.orgId, issue.teamId);
      const key = team ? formatIssueKey(team.key, issue) : null;
      refuse(`${key ?? issue.title} ${change.field} has changed since; revert the latest change instead`);
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

/** Deletes an issue and every row that belongs to it. */
async function deleteIssueRow(ctx: MutationCtx, issue: Doc<"issues">): Promise<void> {
  await deleteIssueOwnedRows(ctx, issue);
  await ctx.db.delete(issue._id);
}

/** A story's subtasks go with it, the Complete testing one included. */
async function deleteStorySubtasks(ctx: MutationCtx, story: Doc<"issues">): Promise<void> {
  if (story.kind !== "story") {
    return;
  }
  const subtasks = await orgChildren(ctx, story.orgId, story._id);
  for (const subtask of subtasks) {
    await deleteIssueRow(ctx, subtask);
  }
}

/** "KEY-12.2 Write API" for keyed levels, the title alone for epics and features. */
async function keyedTitle(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  parent: Doc<"issues"> | null
): Promise<string> {
  const team = await orgRow(ctx, issue.orgId, issue.teamId);
  const key = team ? formatIssueKey(team.key, issue, parent?.number) : null;
  return key ? `${key} ${issue.title}` : issue.title;
}

/** A deleted issue's rows go with it, so the deletion is logged on the surviving parent. */
async function logChildDeleted(
  ctx: MutationCtx,
  child: Doc<"issues">,
  parent: Doc<"issues"> | null,
  actorId: Id<"users">
): Promise<void> {
  if (parent === null) {
    return;
  }
  await logActivity(ctx, {
    orgId: child.orgId,
    issueId: parent._id,
    actorId,
    type: "child_deleted",
    field: "child",
    oldValue: await keyedTitle(ctx, child, parent),
  });
}

export const remove = orgMutation({
  args: { issueId: v.id("issues") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const issue = await getOrgIssue(ctx, ctx.org._id, args.issueId);
    assertNotTestingSubtask(issue, "deleted");
    await assertNoChildren(ctx, issue);
    const parent = issue.parentIssueId ? await orgRow(ctx, ctx.org._id, issue.parentIssueId) : null;
    await deleteStorySubtasks(ctx, issue);
    await retireSubNumber(ctx, issue, parent);
    await deleteIssueRow(ctx, issue);
    await logChildDeleted(ctx, issue, parent, ctx.user._id);
    return null;
  },
});

async function logProofChange(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  proofUrl: string,
  actorId: Id<"users">
): Promise<void> {
  if (proofUrl === (issue.proofUrl ?? "")) {
    return;
  }
  await logActivity(ctx, {
    orgId: issue.orgId,
    issueId: issue._id,
    actorId,
    type: proofUrl === "" ? "proof_cleared" : "proof_set",
    field: "proof",
    oldValue: issue.proofUrl,
    newValue: proofUrl || undefined,
  });
}

/** Sets or clears (empty string) the proof URL on a Complete testing sub-task. */
export async function setIssueProof(
  ctx: MutationCtx,
  scope: OrgScope,
  args: { issueId: Id<"issues">; proofUrl: string }
): Promise<void> {
  const issue = await getOrgIssue(ctx, scope.org._id, args.issueId);
  assertTestingSubtask(issue);
  const proofUrl = args.proofUrl.trim();
  if (proofUrl !== "") {
    assertProofUrl(proofUrl);
  }
  await patchIssue(ctx, issue._id, { proofUrl: proofUrl || undefined });
  await logProofChange(ctx, issue, proofUrl, scope.actorId);
}

export const setProof = orgMutation({
  args: { issueId: v.id("issues"), proofUrl: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await setIssueProof(ctx, { org: ctx.org, actorId: ctx.user._id }, args);
    return null;
  },
});
