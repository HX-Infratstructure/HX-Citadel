import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { formatIssueKey, PARENT_KIND } from "../lib/issue-key";
import { isGatedStatus } from "../lib/issue-status";
import { respaceTie, SORT_GAP } from "../lib/sort-order";
import { changedFields, logActivity, logFieldChanges } from "./lib/activity";
import { orgMutation, orgQuery } from "./lib/customFunctions";
import { deleteIssueOwnedRows } from "./lib/issueCleanup";
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
};

/** Verify an issue belongs to the caller's org before any read/write. */
export async function getOrgIssue(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  issueId: Id<"issues">
): Promise<Doc<"issues">> {
  const issue = await ctx.db.get(issueId);
  if (!issue || issue.orgId !== orgId) {
    throw new Error("Issue not found");
  }
  return issue;
}

export const listByTeam = orgQuery({
  args: { teamId: v.id("teams") },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.teamId);
    if (!team || team.orgId !== ctx.org._id) {
      throw new Error("Team not found");
    }
    return await ctx.db
      .query("issues")
      .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
      .order("desc")
      .take(500);
  },
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
    const team = await ctx.db.get(args.teamId);
    if (!team || team.orgId !== ctx.org._id) {
      throw new Error("Team not found");
    }
    const byStatus = await Promise.all(
      OPEN_STATUSES.map((status) =>
        ctx.db
          .query("issues")
          .withIndex("by_team_and_status", (q) =>
            q.eq("teamId", args.teamId).eq("status", status)
          )
          .collect()
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
    const team = await ctx.db.get(args.teamId);
    if (!team || team.orgId !== ctx.org._id) {
      throw new Error("Team not found");
    }
    const parentKind = PARENT_KIND[args.kind];
    if (parentKind === null) {
      return [];
    }
    const byStatus = await Promise.all(
      PARENT_STATUSES.map((status) =>
        ctx.db
          .query("issues")
          .withIndex("by_team_kind_status", (q) =>
            q.eq("teamId", args.teamId).eq("kind", parentKind).eq("status", status)
          )
          .collect()
      )
    );
    return byStatus.flat().sort((a, b) => b._creationTime - a._creationTime);
  },
});

export const get = orgQuery({
  args: { issueId: v.id("issues") },
  returns: v.union(v.object(issueShape), v.null()),
  handler: async (ctx, args) => {
    const issue = await ctx.db.get(args.issueId);
    if (!issue || issue.orgId !== ctx.org._id) {
      return null;
    }
    return issue;
  },
});

/** Look up a story by its display identifier (team key + number, e.g. ENG-42). */
export const getByNumber = orgQuery({
  args: { teamId: v.id("teams"), number: v.number() },
  returns: v.union(v.object(issueShape), v.null()),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.teamId);
    if (!team || team.orgId !== ctx.org._id) {
      return null;
    }
    const issue = await ctx.db
      .query("issues")
      .withIndex("by_team_and_number", (q) =>
        q.eq("teamId", args.teamId).eq("number", args.number)
      )
      .unique();
    return issue?.kind === "story" ? issue : null;
  },
});

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

export const create = orgMutation({
  args: {
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
  },
  returns: v.id("issues"),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.teamId);
    if (!team || team.orgId !== ctx.org._id) {
      throw new Error("Team not found");
    }

    const kind = args.kind ?? "story";
    const parent = args.parentIssueId
      ? await getOrgIssue(ctx, ctx.org._id, args.parentIssueId)
      : null;
    const placement = await assertValidParent(ctx, kind, {
      teamId: args.teamId,
      parentIssueId: args.parentIssueId,
      projectId: args.projectId,
    });
    if (parent !== null) {
      await assertParentOpen(ctx, parent, kind);
    }
    const status = args.status ?? "todo";
    await assertWipFree(ctx, { orgId: ctx.org._id, assigneeId: args.assigneeId, kind, status });
    const numbering = await claimNumbering(ctx, team, kind, args.parentIssueId);

    // New issues sort to the top of their column.
    const highest = await ctx.db
      .query("issues")
      .withIndex("by_team_and_sort_order", (q) => q.eq("teamId", placement.teamId))
      .order("desc")
      .first();
    const sortOrder = (highest?.sortOrder ?? 0) + SORT_GAP;

    const issueId = await ctx.db.insert("issues", {
      orgId: ctx.org._id,
      teamId: placement.teamId,
      kind,
      type: storyType(kind, args.type),
      ...numbering,
      title: args.title.trim(),
      description: args.description,
      status,
      priority: args.priority ?? "none",
      assigneeId: args.assigneeId,
      creatorId: ctx.user._id,
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

    await logActivity(ctx, {
      orgId: ctx.org._id,
      issueId,
      actorId: ctx.user._id,
      type: "created",
    });

    return issueId;
  },
});

/** The team's issues at `rank`, other than `issue`, in creation order. */
async function othersAtRank(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  rank: number
): Promise<Doc<"issues">[]> {
  const atRank = await ctx.db
    .query("issues")
    .withIndex("by_team_and_sort_order", (q) =>
      q.eq("teamId", issue.teamId).eq("sortOrder", rank)
    )
    .collect();
  return atRank.filter((other) => other._id !== issue._id);
}

/** The team's closest rank below `rank`, if any. */
async function nextLowerRank(
  ctx: MutationCtx,
  teamId: Id<"teams">,
  rank: number
): Promise<number | undefined> {
  const nextLower = await ctx.db
    .query("issues")
    .withIndex("by_team_and_sort_order", (q) => q.eq("teamId", teamId).lt("sortOrder", rank))
    .order("desc")
    .first();
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
  let floor = await nextLowerRank(ctx, issue.teamId, rank);
  let ranks = respaceTie(rank, tied.length, floor, below.length);
  while (ranks === undefined && floor !== undefined) {
    below.push(...(await othersAtRank(ctx, issue, floor)));
    floor = await nextLowerRank(ctx, issue.teamId, floor);
    ranks = respaceTie(rank, tied.length, floor, below.length);
  }
  if (ranks === undefined) {
    throw new Error("There is no room to rank this issue here");
  }
  for (const [index, other] of tied.entries()) {
    await ctx.db.patch(other._id, { sortOrder: ranks.tied[index] });
  }
  for (const [index, other] of below.entries()) {
    await ctx.db.patch(other._id, { sortOrder: ranks.below[index] });
  }
  return ranks.moved;
}

export const update = orgMutation({
  args: {
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const issue = await getOrgIssue(ctx, ctx.org._id, args.issueId);

    const actor = { orgId: ctx.org._id, actorId: ctx.user._id };
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
      updates.assigneeId = args.assigneeId ?? undefined;
    }
    if (args.projectId !== undefined) {
      const placement = await assertValidParent(ctx, issue.kind, {
        teamId: issue.teamId,
        parentIssueId: issue.parentIssueId,
        projectId: args.projectId ?? undefined,
      });
      if (args.projectId === null && placement.projectId !== undefined) {
        const parentKind = PARENT_KIND[issue.kind];
        throw new Error(
          `This ${issue.kind}'s project comes from its ${parentKind}; move it out of the ${parentKind} to clear the project`
        );
      }
      updates.projectId = placement.projectId;
      if (placement.projectId !== issue.projectId) {
        await cascadeProject(ctx, issue._id, placement.projectId, actor);
      }
    }
    if (args.cycleId !== undefined) {
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
    await ctx.db.patch(issue._id, updates);
    await logFieldChanges(ctx, actor, issue._id, changedFields(issue, updates));
    return null;
  },
});

/** Deletes an issue and every row that belongs to it. */
async function deleteIssueRow(ctx: MutationCtx, issueId: Id<"issues">): Promise<void> {
  await deleteIssueOwnedRows(ctx, issueId);
  await ctx.db.delete(issueId);
}

/** A story's subtasks go with it, the Complete testing one included. */
async function deleteStorySubtasks(ctx: MutationCtx, story: Doc<"issues">): Promise<void> {
  if (story.kind !== "story") {
    return;
  }
  const subtasks = await ctx.db
    .query("issues")
    .withIndex("by_parent", (q) => q.eq("parentIssueId", story._id))
    .collect();
  for (const subtask of subtasks) {
    await deleteIssueRow(ctx, subtask._id);
  }
}

/** "KEY-12.2 Write API" for keyed levels, the title alone for epics and features. */
async function keyedTitle(ctx: MutationCtx, issue: Doc<"issues">): Promise<string> {
  const team = await ctx.db.get(issue.teamId);
  const parent = issue.parentIssueId ? await ctx.db.get(issue.parentIssueId) : null;
  const key = team ? formatIssueKey(team.key, issue, parent?.number) : null;
  return key ? `${key} ${issue.title}` : issue.title;
}

/** A deleted issue's rows go with it, so the deletion is logged on the surviving parent. */
async function logChildDeleted(
  ctx: MutationCtx,
  child: Doc<"issues">,
  actorId: Id<"users">
): Promise<void> {
  if (!child.parentIssueId) {
    return;
  }
  await logActivity(ctx, {
    orgId: child.orgId,
    issueId: child.parentIssueId,
    actorId,
    type: "child_deleted",
    field: "child",
    oldValue: await keyedTitle(ctx, child),
  });
}

export const remove = orgMutation({
  args: { issueId: v.id("issues") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const issue = await getOrgIssue(ctx, ctx.org._id, args.issueId);
    assertNotTestingSubtask(issue, "deleted");
    await assertNoChildren(ctx, issue);
    await deleteStorySubtasks(ctx, issue);
    await deleteIssueRow(ctx, issue._id);
    await logChildDeleted(ctx, issue, ctx.user._id);
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
export const setProof = orgMutation({
  args: { issueId: v.id("issues"), proofUrl: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const issue = await getOrgIssue(ctx, ctx.org._id, args.issueId);
    assertTestingSubtask(issue);
    const proofUrl = args.proofUrl.trim();
    if (proofUrl !== "") {
      assertProofUrl(proofUrl);
    }
    await ctx.db.patch(issue._id, { proofUrl: proofUrl || undefined });
    await logProofChange(ctx, issue, proofUrl, ctx.user._id);
    return null;
  },
});
