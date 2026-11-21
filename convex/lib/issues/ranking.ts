import { Doc, Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { byRank, respaceTie } from "../../../lib/sort-order";
import { patchIssue } from "../issueVersion";
import { inOrg, orgRow } from "../orgRows";
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

/** The card a drop landed under: an issue, `null` for the top, or `undefined` when the caller didn't say. */
type AboveId = Id<"issues"> | null | undefined;

/** `aboveId`'s row when it is not in `run`, read once through the org-scoped loader; null when there is none. */
async function anchorOutsideRun(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  run: readonly Doc<"issues">[],
  aboveId: AboveId
): Promise<Doc<"issues"> | null> {
  if (!aboveId || run.some((row) => row._id === aboveId)) {
    return null;
  }
  return await orgRow(ctx, issue.orgId, aboveId);
}

/**
 * The moved issue's slot in `run` listed by `byRank`: right under `aboveId` when it is in the run, the top for `null`
 * or for `outside` in the same team ranking above the run, and undefined (the middle) for anything else.
 */
function slotUnder(run: readonly Doc<"issues">[], aboveId: AboveId, outside: Doc<"issues"> | null): number | undefined {
  if (aboveId === null) {
    return 0;
  }
  const sorted = [...run].sort(byRank);
  const index = sorted.findIndex((row) => row._id === aboveId);
  if (index !== -1) {
    return index + 1;
  }
  const [top] = sorted;
  return outside !== null && outside.teamId === top.teamId && byRank(outside, top) < 0 ? 0 : undefined;
}

/**
 * The rank to store for an issue moved to `rank`. Other issues in the team that already hold `rank` are re-spaced
 * upward first (`respaceTie`), and the moved issue takes the slot right under `aboveId` in their run (`slotUnder`),
 * or its middle when `aboveId` is missing or stale, so it never ties a neighbour and no issue ends below `rank`. When
 * the gap to the next higher rank can't hold distinct numbers, the issues at that rank join the run and the gap widens
 * to the rank above them.
 */
export async function placeRank(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  rank: number,
  aboveId?: AboveId
): Promise<number> {
  const run = await othersAtRank(ctx, issue, rank);
  if (run.length === 0) {
    return rank;
  }
  const outside = await anchorOutsideRun(ctx, issue, run, aboveId);
  let ceiling = await nextHigherRank(ctx, issue, rank);
  let ranks = respaceTie(rank, run, ceiling, slotUnder(run, aboveId, outside));
  while (ranks === undefined && ceiling !== undefined) {
    run.push(...(await othersAtRank(ctx, issue, ceiling)));
    ceiling = await nextHigherRank(ctx, issue, ceiling);
    ranks = respaceTie(rank, run, ceiling, slotUnder(run, aboveId, outside));
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
