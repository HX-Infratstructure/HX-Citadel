/** Spacing between neighbors when a row lands at the top or bottom of a list. */
export const SORT_GAP = 1000;

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

/**
 * New ranks for `count` rows that share the rank `tie` plus one row moved into
 * their run, so no two of them tie. The run keeps `tie` at its top and steps
 * down evenly toward `nextLower`, the closest lower rank, without reaching it;
 * the moved row takes the middle of the run.
 */
export function respaceTie(
  tie: number,
  count: number,
  nextLower?: number
): { tied: number[]; moved: number } {
  const step = nextLower === undefined ? SORT_GAP : (tie - nextLower) / (count + 1);
  const ranks = Array.from({ length: count + 1 }, (_, slot) => tie - slot * step);
  const movedSlot = Math.ceil(count / 2);
  return {
    tied: ranks.filter((_, slot) => slot !== movedSlot),
    moved: ranks[movedSlot],
  };
}
