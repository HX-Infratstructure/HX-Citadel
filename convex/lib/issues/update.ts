import { ObjectType, v } from "convex/values";
import { Doc } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { PARENT_KIND } from "../../../lib/issue-key";
import { ActivityActor, changedFields, FieldLogOptions, logFieldChanges } from "../activity";
import { patchIssue } from "../issueVersion";
import { OrgScope } from "../orgScope";
import { refuse } from "../refusals";
import { assertCycleInTeam } from "../rules/cycles";
import { assertDoneGateAfterUpdate } from "../rules/doneGate";
import { assertValidParent, cascadeProject } from "../rules/levels";
import { assertWipFreeAfterUpdate } from "../rules/wip";
import { issuePriorityValidator, issueStatusValidator } from "../../schema";
import { assertAssignee, issueTitle } from "./fields";
import { placeRank } from "./ranking";
import { getOrgIssue } from "./shape";

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
};

export type UpdateIssueArgs = ObjectType<typeof updateArgs>;

type Updates = Partial<Doc<"issues">>;

/** Title, description, status and priority: a change only when the value differs, except description. */
function textUpdates(issue: Doc<"issues">, args: UpdateIssueArgs): Updates {
  const updates: Updates = {};
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
  return updates;
}

/** Estimate and due date: null clears, and a cleared field stays in the patch as undefined. */
function scheduleUpdates(args: UpdateIssueArgs): Updates {
  const updates: Updates = {};
  if (args.estimate !== undefined) {
    updates.estimate = args.estimate ?? undefined;
  }
  if (args.dueDate !== undefined) {
    updates.dueDate = args.dueDate ?? undefined;
  }
  return updates;
}

async function assigneeUpdate(ctx: MutationCtx, scope: OrgScope, args: UpdateIssueArgs): Promise<Updates> {
  if (args.assigneeId === undefined) {
    return {};
  }
  if (args.assigneeId !== null) {
    await assertAssignee(ctx, scope.org._id, args.assigneeId);
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
  scope: OrgScope,
  issue: Doc<"issues">,
  args: UpdateIssueArgs
): Promise<Updates> {
  if (args.cycleId === undefined) {
    return {};
  }
  if (args.cycleId !== null) {
    await assertCycleInTeam(ctx, scope.org._id, args.cycleId, issue.teamId);
  }
  return { cycleId: args.cycleId ?? undefined };
}

async function rankUpdate(ctx: MutationCtx, issue: Doc<"issues">, args: UpdateIssueArgs): Promise<Updates> {
  if (args.sortOrder === undefined || args.sortOrder === issue.sortOrder) {
    return {};
  }
  return { sortOrder: await placeRank(ctx, issue, args.sortOrder) };
}

/** Every update rule in one place; the Clerk session and agent calls both come through here. */
export async function updateIssue(
  ctx: MutationCtx,
  scope: OrgScope,
  args: UpdateIssueArgs,
  log: FieldLogOptions = {}
): Promise<void> {
  const issue = await getOrgIssue(ctx, scope.org._id, args.issueId);
  const actor = { orgId: scope.org._id, actorId: scope.actorId };
  // Spread in this order: each helper's refusal and write lands where the single function had it.
  const updates: Updates = {
    ...textUpdates(issue, args),
    ...(await assigneeUpdate(ctx, scope, args)),
    ...(await projectUpdate(ctx, actor, issue, args)),
    ...(await cycleUpdate(ctx, scope, issue, args)),
    ...scheduleUpdates(args),
    ...(await rankUpdate(ctx, issue, args)),
  };
  await assertWipFreeAfterUpdate(ctx, issue, updates);
  await assertDoneGateAfterUpdate(ctx, issue, updates);
  await patchIssue(ctx, issue._id, updates);
  await logFieldChanges(ctx, actor, issue._id, changedFields(issue, updates), log);
}
