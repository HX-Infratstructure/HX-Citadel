import { ObjectType, v } from "convex/values";
import { Doc, Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { SORT_GAP } from "../../../lib/sort-order";
import { logActivity } from "../activity";
import { inOrg, requireOrgRow } from "../orgRows";
import { OrgScope } from "../orgScope";
import { assertCycleInTeam } from "../rules/cycles";
import { assertDoneGate } from "../rules/doneGate";
import {
  assertParentOpen,
  assertValidParent,
  FIRST_SUB_NUMBER,
  nextSubNumber,
  ResolvedPlacement,
} from "../rules/levels";
import { createTestingSubtask } from "../rules/testing";
import { assertWipFree } from "../rules/wip";
import { issueKindValidator, issuePriorityValidator, issueStatusValidator, issueTypeValidator } from "../../schema";
import { assertAssignee, issueTitle } from "./fields";
import { getOrgIssue } from "./shape";

export const createArgs = {
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

/** What every check before the first write settled. */
type CreatePlan = {
  title: string;
  team: Doc<"teams">;
  kind: Doc<"issues">["kind"];
  status: Doc<"issues">["status"];
  placement: ResolvedPlacement;
};

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

/** Every create rule that runs before the first write, in the order the refusals have always come. */
async function planCreate(ctx: MutationCtx, orgId: Id<"organizations">, args: CreateIssueArgs): Promise<CreatePlan> {
  const title = issueTitle(args.title);
  const team = await requireOrgRow(ctx, orgId, args.teamId, "Team");
  const kind = args.kind ?? "story";
  const parent = args.parentIssueId ? await getOrgIssue(ctx, orgId, args.parentIssueId) : null;
  const placement = await assertValidParent(ctx, orgId, kind, {
    teamId: args.teamId,
    parentIssueId: args.parentIssueId,
    projectId: args.projectId,
  });
  if (parent !== null) {
    await assertParentOpen(ctx, parent, kind);
  }
  if (args.cycleId !== undefined) {
    await assertCycleInTeam(ctx, orgId, args.cycleId, placement.teamId);
  }
  if (args.assigneeId !== undefined) {
    await assertAssignee(ctx, orgId, args.assigneeId);
  }
  const status = args.status ?? "todo";
  await assertWipFree(ctx, { orgId, assigneeId: args.assigneeId, kind, status });
  return { title, team, kind, status, placement };
}

/** New issues sort to the top of their column. */
async function topSortOrder(ctx: MutationCtx, orgId: Id<"organizations">, teamId: Id<"teams">): Promise<number> {
  const highest = await inOrg(
    ctx.db.query("issues").withIndex("by_team_and_sort_order", (q) => q.eq("teamId", teamId)).order("desc"),
    orgId
  ).first();
  return (highest?.sortOrder ?? 0) + SORT_GAP;
}

async function insertIssue(ctx: MutationCtx, scope: OrgScope, args: CreateIssueArgs, plan: CreatePlan) {
  const numbering = await claimNumbering(ctx, plan.team, plan.kind, args.parentIssueId);
  const sortOrder = await topSortOrder(ctx, scope.org._id, plan.placement.teamId);
  return await ctx.db.insert("issues", {
    orgId: scope.org._id,
    teamId: plan.placement.teamId,
    kind: plan.kind,
    type: storyType(plan.kind, args.type),
    ...numbering,
    title: plan.title,
    description: args.description,
    status: plan.status,
    priority: args.priority ?? "none",
    assigneeId: args.assigneeId,
    creatorId: scope.actorId,
    projectId: plan.placement.projectId,
    cycleId: args.cycleId,
    parentIssueId: args.parentIssueId,
    estimate: args.estimate,
    dueDate: args.dueDate,
    sortOrder,
  });
}

/** After the insert: a story's Complete testing sub-task, then the Done gate, which counts it as a child. */
async function finishCreate(ctx: MutationCtx, issueId: Id<"issues">, status: Doc<"issues">["status"]) {
  const created = await ctx.db.get(issueId);
  if (created?.kind === "story") {
    await createTestingSubtask(ctx, created);
  }
  if (created !== null) {
    await assertDoneGate(ctx, created, status);
  }
}

/** Every create rule in one place; the Clerk session and agent calls both come through here. */
export async function createIssue(
  ctx: MutationCtx,
  scope: OrgScope,
  args: CreateIssueArgs
): Promise<Id<"issues">> {
  const plan = await planCreate(ctx, scope.org._id, args);
  const issueId = await insertIssue(ctx, scope, args, plan);
  await finishCreate(ctx, issueId, plan.status);
  await logActivity(ctx, { orgId: scope.org._id, issueId, actorId: scope.actorId, type: "created" });
  return issueId;
}
