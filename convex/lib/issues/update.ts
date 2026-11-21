import { ObjectType, v } from "convex/values";
import { Doc, Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { PARENT_KIND } from "../../../lib/issue-key";
import { ActivityActor, changedFields, FieldLogOptions, logFieldChanges } from "../activity";
import { patchIssue } from "../issueVersion";
import { OrgScope } from "../orgScope";
import { invalid, refuse } from "../refusals";
import { assertCycleInTeam } from "../rules/cycles";
import { assertDoneGateAfterUpdate } from "../rules/doneGate";
import { cascadeProject } from "../rules/cascade";
import { assertValidParent } from "../rules/levels";
import { assertWipFreeAfterUpdate } from "../rules/wip";
import { issuePriorityValidator, issueStatusValidator } from "../../schema";
import { assertAssignee, issueTitle } from "./fields";
import { placeRank } from "./ranking";
import { getOrgIssue } from "../orgRows";

export const updateArgs = {
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
  aboveId: v.optional(v.union(v.id("issues"), v.null())),
};

export type UpdateIssueArgs = ObjectType<typeof updateArgs>;

type Updates = Partial<Doc<"issues">>;

function titleUpdate(args: UpdateIssueArgs): Updates {
  return args.title === undefined ? {} : { title: issueTitle(args.title) };
}

function statusUpdate(issue: Doc<"issues">, args: UpdateIssueArgs): Updates {
  // An unchanged status stays out, or it would re-run the Done gate and the WIP check.
  if (args.status === undefined || args.status === issue.status) {
    return {};
  }
  return { status: args.status };
}

/**
 * Fields with no rule of their own; only estimate and dueDate take null, which clears them. `patchIssue` and
 * `changedFields` drop an unchanged value.
 */
function plainUpdates(args: UpdateIssueArgs): Updates {
  const updates: Updates = {};
  if (args.description !== undefined) {
    updates.description = args.description;
  }
  if (args.priority !== undefined) {
    updates.priority = args.priority;
  }
  if (args.estimate !== undefined) {
    updates.estimate = args.estimate ?? undefined;
  }
  if (args.dueDate !== undefined) {
    updates.dueDate = args.dueDate ?? undefined;
  }
  return updates;
}

/**
 * Once `assigneeId` is sent, its key is always in the updates, even when it names the current assignee, so
 * re-sending the current assignee re-runs the WIP check (`assertWipFreeAfterUpdate`) on purpose.
 */
async function assigneeUpdate(ctx: MutationCtx, orgId: Id<"organizations">, args: UpdateIssueArgs): Promise<Updates> {
  if (args.assigneeId === undefined) {
    return {};
  }
  if (args.assigneeId !== null) {
    await assertAssignee(ctx, orgId, args.assigneeId);
  }
  return { assigneeId: args.assigneeId ?? undefined };
}

/** A project change also moves every descendant (`cascadeProject`), before any later rule runs. */
async function projectUpdate(
  ctx: MutationCtx,
  actor: ActivityActor,
  issue: Doc<"issues">,
  args: UpdateIssueArgs
): Promise<Updates> {
  if (args.projectId === undefined) {
    return {};
  }
  const placement = await assertValidParent(ctx, actor.orgId, issue.kind, {
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
  await cascadeProject(ctx, issue, placement.projectId, actor);
  return { projectId: placement.projectId };
}

async function cycleUpdate(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  issue: Doc<"issues">,
  args: UpdateIssueArgs
): Promise<Updates> {
  if (args.cycleId === undefined) {
    return {};
  }
  if (args.cycleId !== null) {
    await assertCycleInTeam(ctx, orgId, args.cycleId, issue.teamId);
  }
  return { cycleId: args.cycleId ?? undefined };
}

async function rankUpdate(ctx: MutationCtx, issue: Doc<"issues">, args: UpdateIssueArgs): Promise<Updates> {
  if (args.aboveId !== undefined && args.sortOrder === undefined) {
    invalid("aboveId needs a sortOrder");
  }
  // An unchanged rank stays out, or `placeRank` would re-space the story's testing sub-task, which shares it.
  if (args.sortOrder === undefined || args.sortOrder === issue.sortOrder) {
    return {};
  }
  return { sortOrder: await placeRank(ctx, issue, args.sortOrder, args.aboveId) };
}

/** Every update rule in one place; the Clerk session and agent calls both come through here. */
export async function updateIssue(
  ctx: MutationCtx,
  scope: OrgScope,
  args: UpdateIssueArgs,
  log: FieldLogOptions = {}
): Promise<void> {
  const issue = await getOrgIssue(ctx, scope.org._id, args.issueId);
  const actor: ActivityActor = { orgId: scope.org._id, actorId: scope.actorId };
  // Refusals come in this order: title, assignee, project, cycle, rank, then the WIP check and the Done gate.
  // projectUpdate moves descendants and rankUpdate re-spaces ties as they run; a later refusal rolls both back.
  const title = titleUpdate(args);
  const status = statusUpdate(issue, args);
  const plain = plainUpdates(args);
  const assignee = await assigneeUpdate(ctx, actor.orgId, args);
  const project = await projectUpdate(ctx, actor, issue, args);
  const cycle = await cycleUpdate(ctx, actor.orgId, issue, args);
  const rank = await rankUpdate(ctx, issue, args);
  const updates: Updates = { ...title, ...status, ...plain, ...assignee, ...project, ...cycle, ...rank };
  await assertWipFreeAfterUpdate(ctx, issue, updates);
  await assertDoneGateAfterUpdate(ctx, issue, updates);
  await patchIssue(ctx, issue._id, updates);
  await logFieldChanges(ctx, actor, issue._id, changedFields(issue, updates), log);
}
