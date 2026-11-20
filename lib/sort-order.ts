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
export const NO_ROOM_TO_PLACE = "There is no room to place it here.";

/** Why a drop is refused: `loadMore` when loading more could make it placeable, `noRoom` when it can't be placed there. */
export type DropRefusal = "loadMore" | "noRoom";

/** What the board and the backlog tell the user when a drop is refused, by reason. */
export const REFUSAL_MESSAGE: Record<DropRefusal, string> = { loadMore: LOAD_MORE_TO_PLACE, noRoom: NO_ROOM_TO_PLACE };

/** The loaded part of a rank order. Every row not loaded yet ranks at or below `floor`. */
export type LoadedOrder = { floor: number | undefined; moreToLoad: boolean };

/** What a drop does: nothing (`gone`, `inPlace`), a refusal with its reason, or a new rank. */
export type DropOutcome =
  | { kind: "gone" }
  | { kind: "inPlace" }
  | { kind: "refused"; reason: DropRefusal }
  | { kind: "ranked"; sortOrder: number };

type LoadedDrop = { above?: number; below?: number; own: number; floor?: number; moreToLoad: boolean };

/** The neighbour a drop ranks above: the row below it, or the floor in its place while more is to load. */
function lowerBound({ below, floor, moreToLoad }: LoadedDrop) {
  return moreToLoad ? below ?? floor : below;
}

/** Two loaded neighbours that differ but hold no distinct number between them: their midpoint `rank` equals one. */
function noRoomBetween(above: number | undefined, below: number | undefined, rank: number) {
  return above !== undefined && below !== undefined && above !== below && (rank === above || rank === below);
}

/** While more is to load: `rank` is above the floor and, where the floor stands in for the lower neighbour, below `above`. */
function aboveFloor({ above, below, floor }: LoadedDrop, rank: number) {
  if (floor === undefined || rank <= floor) {
    return false;
  }
  return below !== undefined || rank !== above;
}

/**
 * What a drop does to a row dropped between its loaded neighbours in a list that shows part of one rank order. `own`
 * is the row's current rank. `floor` is the lowest loaded rank of that order, and every row not loaded yet ranks at or
 * below it. While more is to load, the floor stands in for a missing lower neighbour, and a rank must lie above it:
 * `placeRank` re-spaces a tie upward, so every loaded row stays loaded. A drop between two loaded neighbours whose
 * midpoint equals one of them is refused, loaded or not, because the server can't tell which side was meant. A drop
 * between two loaded neighbours that both hold `own` is refused as no room: no rank between them differs from `own`,
 * so the server would not move the row. A rank equal to `own` leaves the row in place.
 */
export function rankInLoaded(drop: LoadedDrop): DropOutcome {
  const { above, below, own, moreToLoad } = drop;
  if (above === own && below === own) {
    return { kind: "refused", reason: "noRoom" };
  }
  const lower = lowerBound(drop);
  const sortOrder = sortOrderBetween(above, lower);
  if (sortOrder === undefined) {
    return { kind: "refused", reason: moreToLoad ? "loadMore" : "noRoom" };
  }
  if (noRoomBetween(above, below, sortOrder)) {
    return { kind: "refused", reason: "noRoom" };
  }
  if (moreToLoad && !aboveFloor(drop, sortOrder)) {
    return { kind: "refused", reason: "loadMore" };
  }
  return sortOrder === own ? { kind: "inPlace" } : { kind: "ranked", sortOrder };
}

/**
 * New ranks for `others` plus one row moved to the rank `tie`. `others` holds the rows at `tie` and any rows ranked
 * between it and `nextHigher` that joined the run. Listed by `byRank`, `others` keep their order and the moved row takes
 * the middle of the rows at `tie`, below a single one. The run steps up evenly from `tie`, which its bottom row keeps,
 * toward `nextHigher`, the closest higher rank, without reaching it; a full `SORT_GAP` apart when nothing ranks higher.
 * Undefined when the gap is too narrow to hold the run as distinct numbers.
 */
export function respaceTie<T extends Ranked>(
  tie: number,
  others: readonly T[],
  nextHigher?: number
): { moved: number; others: { row: T; sortOrder: number }[] } | undefined {
  const run = [...others].sort(byRank);
  const movedSlot = run.length - Math.floor(run.filter((row) => row.sortOrder === tie).length / 2);
  const slots = run.length + 1;
  const step = nextHigher === undefined ? SORT_GAP : (nextHigher - tie) / slots;
  const ranks = Array.from({ length: slots }, (_, slot) => tie + (slots - 1 - slot) * step);
  if (!ranks.every((rank, slot) => rank < (ranks[slot - 1] ?? nextHigher ?? Infinity))) {
    return undefined;
  }
  const rest = ranks.filter((_, slot) => slot !== movedSlot);
  return { moved: ranks[movedSlot], others: run.map((row, index) => ({ row, sortOrder: rest[index] })) };
}
