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
