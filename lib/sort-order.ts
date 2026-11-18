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
