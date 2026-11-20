import { ObjectType, v } from "convex/values";
import { WithoutSystemFields } from "convex/server";
import { Doc, Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { SORT_GAP } from "../../../lib/sort-order";
import { logActivity } from "../activity";
import { getOrgIssue, inOrg, requireOrgRow } from "../orgRows";
import { OrgScope } from "../orgScope";
import { assertCycleInTeam } from "../rules/cycles";
import { assertDoneGate } from "../rules/doneGate";
import { assertParentOpen, resolvePlacement } from "../rules/levels";
import { FIRST_SUB_NUMBER, nextSubNumber } from "../rules/subNumbers";
import { createTestingSubtask } from "../rules/testing";
import { assertWipFree } from "../rules/wip";
import { issueKindValidator, issuePriorityValidator, issueStatusValidator, issueTypeValidator } from "../../schema";
import { assertAssignee, issueTitle } from "./fields";

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

/** The counters a create claims after every check has passed. */
type Numbering = Pick<Doc<"issues">, "number" | "subNumber" | "nextSubNumber">;

/**
 * The row every check before the first write settled; only the counters and the rank are claimed after. A new issue
 * never carries the testing flag, a proof link or a version.
 */
type NewIssue = Omit<
  WithoutSystemFields<Doc<"issues">>,
  keyof Numbering | "sortOrder" | "testing" | "proofUrl" | "version"
>;

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
async function claimNumbering(ctx: MutationCtx, row: NewIssue): Promise<Numbering> {
  if (row.kind === "story") {
    const team = await requireOrgRow(ctx, row.orgId, row.teamId, "Team");
    const number = team.nextIssueNumber;
    await ctx.db.patch(team._id, { nextIssueNumber: number + 1 });
    return { number, nextSubNumber: FIRST_SUB_NUMBER };
  }
  if (row.kind === "subtask" && row.parentIssueId) {
    return { subNumber: await nextSubNumber(ctx, row.orgId, row.parentIssueId) };
  }
  return {};
}

/** Every create rule that runs before the first write, in refusal order. */
async function planCreate(ctx: MutationCtx, scope: OrgScope, args: CreateIssueArgs): Promise<NewIssue> {
  const orgId = scope.org._id;
  const title = issueTitle(args.title);
  // Checked here so a missing team is refused before the level checks; `claimNumbering` reads it again for a story.
  await requireOrgRow(ctx, orgId, args.teamId, "Team");
  const kind = args.kind ?? "story";
  const placement = await resolvePlacement(ctx, orgId, kind, {
    teamId: args.teamId,
    parentIssueId: args.parentIssueId,
    projectId: args.projectId,
  });
  if (placement.parent !== null) {
    await assertParentOpen(ctx, placement.parent, kind);
  }
  if (args.cycleId !== undefined) {
    await assertCycleInTeam(ctx, orgId, args.cycleId, placement.teamId);
  }
  if (args.assigneeId !== undefined) {
    await assertAssignee(ctx, orgId, args.assigneeId);
  }
  const status = args.status ?? "todo";
  await assertWipFree(ctx, { orgId, assigneeId: args.assigneeId, kind, status });
  return {
    orgId,
    teamId: placement.teamId,
    kind,
    type: storyType(kind, args.type),
    title,
    description: args.description,
    status,
    priority: args.priority ?? "none",
    assigneeId: args.assigneeId,
    creatorId: scope.actorId,
    projectId: placement.projectId,
    cycleId: args.cycleId,
    parentIssueId: args.parentIssueId,
    estimate: args.estimate,
    dueDate: args.dueDate,
  };
}

/** New issues sort to the top of their column. */
async function topSortOrder(ctx: MutationCtx, orgId: Id<"organizations">, teamId: Id<"teams">): Promise<number> {
  const highest = await inOrg(
    ctx.db.query("issues").withIndex("by_team_and_sort_order", (q) => q.eq("teamId", teamId)).order("desc"),
    orgId
  ).first();
  return (highest?.sortOrder ?? 0) + SORT_GAP;
}

async function insertIssue(ctx: MutationCtx, row: NewIssue): Promise<Doc<"issues">> {
  const numbering = await claimNumbering(ctx, row);
  const sortOrder = await topSortOrder(ctx, row.orgId, row.teamId);
  const issueId = await ctx.db.insert("issues", { ...row, ...numbering, sortOrder });
  // A re-read of the row just inserted, so the caller gets the stored document.
  return await getOrgIssue(ctx, row.orgId, issueId);
}

/** After the insert: a story's Complete testing sub-task, then the Done gate, which counts it as a child. */
async function finishCreate(ctx: MutationCtx, created: Doc<"issues">): Promise<void> {
  if (created.kind === "story") {
    await createTestingSubtask(ctx, created);
  }
  await assertDoneGate(ctx, created, created.status);
}

/** Every create rule in one place; the Clerk session and agent calls both come through here. */
export async function createIssue(
  ctx: MutationCtx,
  scope: OrgScope,
  args: CreateIssueArgs
): Promise<Id<"issues">> {
  const row = await planCreate(ctx, scope, args);
  const created = await insertIssue(ctx, row);
  await finishCreate(ctx, created);
  await logActivity(ctx, { orgId: scope.org._id, issueId: created._id, actorId: scope.actorId, type: "created" });
  return created._id;
}
