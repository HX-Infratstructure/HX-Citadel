/** Spacing between neighbors when a row lands at the top or bottom of a list. */
export const SORT_GAP = 1000;

type Ranked = { sortOrder: number; _creationTime: number };

/** Highest first, in the order `by_team_and_sort_order` reads desc: rank, then creation time. */
export const byRank = (a: Ranked, b: Ranked) => b.sortOrder - a.sortOrder || b._creationTime - a._creationTime;

/**
 * The fractional `sortOrder` for a row dropped between two neighbors in a
 * list sorted highest first. Undefined when there are no neighbors.
 */
export function sortOrderBetween(
  above?: number,
  below?: number
): number | undefined {
  if (above !== undefined && below !== undefined) {
    return (above + below) / 2;
  }
  if (above !== undefined) {
    return above - SORT_GAP;
  }
  if (below !== undefined) {
    return below + SORT_GAP;
  }
  return undefined;
}

export const LOAD_MORE_TO_PLACE = "Load more to place it here.";

/**
 * The rank for a row dropped between its loaded neighbours in a list that shows part of one rank order. `floor` is
 * the lowest loaded rank of that order, every row not loaded yet ranks at or below it, and `taken` holds the rank of
 * every loaded row of that order except the moved one. While more is to load, the floor stands in for a missing lower
 * neighbour, and a rank is accepted only above the floor and outside `taken`: it then ties no row of the order, so
 * `placeRank` re-spaces nothing. Refused too when there is nothing to rank against.
 */
export function rankInLoaded({ above, below, floor, taken, moreToLoad }: {
  above?: number;
  below?: number;
  floor?: number;
  taken: ReadonlySet<number>;
  moreToLoad: boolean;
}): { sortOrder: number } | { refused: true } {
  if (!moreToLoad) {
    const sortOrder = sortOrderBetween(above, below);
    return sortOrder === undefined ? { refused: true } : { sortOrder };
  }
  const sortOrder = sortOrderBetween(above, below ?? floor);
  const placeable = sortOrder !== undefined && floor !== undefined && sortOrder > floor && !taken.has(sortOrder);
  return placeable ? { sortOrder } : { refused: true };
}

/**
 * New ranks for `count` rows that share the rank `tie` plus one row moved into
 * their run, followed by the `below` rows ranked between `tie` and
 * `nextLower`, so no two of them tie. The run keeps `tie` at its top and steps
 * down evenly toward `nextLower`, the closest lower rank, without reaching it;
 * the moved row takes the middle of the tied rows. Undefined when the gap is
 * too narrow to hold the run as distinct numbers.
 */
export function respaceTie(
  tie: number,
  count: number,
  nextLower?: number,
  below = 0
): { tied: number[]; moved: number; below: number[] } | undefined {
  const slots = count + 1 + below;
  const step = nextLower === undefined ? SORT_GAP : (tie - nextLower) / slots;
  const ranks = Array.from({ length: slots }, (_, slot) => tie - slot * step);
  const fits = ranks.every((rank, slot) => rank > (ranks[slot + 1] ?? nextLower ?? -Infinity));
  if (!fits) {
    return undefined;
  }
  const movedSlot = Math.ceil(count / 2);
  const run = ranks.slice(0, count + 1);
  return {
    tied: run.filter((_, slot) => slot !== movedSlot),
    moved: run[movedSlot],
    below: ranks.slice(count + 1),
  };
}
