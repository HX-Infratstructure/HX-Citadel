import { Doc } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { respaceTie } from "../../../lib/sort-order";
import { patchIssue } from "../issueVersion";
import { inOrg } from "../orgRows";
import { refuse } from "../refusals";

/**
 * The team's issues at `rank`, other than `issue`, in creation order. Bounded by design: create takes the highest +
 * `SORT_GAP`, `placeRank` re-spaces every row it ties and the seed spaces by position, so a rank holds one story,
 * its Complete testing sub-task (which takes the story's rank, `createTestingSubtask`) and rows a legacy write left tied.
 */
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

/** The team's closest rank above `rank`, if any. */
async function nextHigherRank(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  rank: number
): Promise<number | undefined> {
  const nextHigher = await inOrg(
    ctx.db
      .query("issues")
      .withIndex("by_team_and_sort_order", (q) => q.eq("teamId", issue.teamId).gt("sortOrder", rank))
      .order("asc"),
    issue.orgId
  ).first();
  return nextHigher?.sortOrder;
}

/**
 * The rank to store for an issue moved to `rank`. Other issues in the team that already hold `rank` are re-spaced
 * upward first (`respaceTie`), and the moved issue takes the middle of their run, so it never ties a neighbour and no
 * issue ends below `rank`. When the gap to the next higher rank can't hold distinct numbers, the issues at that rank
 * join the run and the gap widens to the rank above them.
 */
export async function placeRank(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  rank: number
): Promise<number> {
  const run = await othersAtRank(ctx, issue, rank);
  if (run.length === 0) {
    return rank;
  }
  let ceiling = await nextHigherRank(ctx, issue, rank);
  let ranks = respaceTie(rank, run, ceiling);
  while (ranks === undefined && ceiling !== undefined) {
    run.push(...(await othersAtRank(ctx, issue, ceiling)));
    ceiling = await nextHigherRank(ctx, issue, ceiling);
    ranks = respaceTie(rank, run, ceiling);
  }
  if (ranks === undefined) {
    // Unreachable while ranks stay within ±2^62: with no ceiling the run steps by SORT_GAP, wider than a float's
    // spacing there.
    refuse("There is no room to rank this issue here");
  }
  for (const { row, sortOrder } of ranks.others) {
    await patchIssue(ctx, row, { sortOrder });
  }
  return ranks.moved;
}
