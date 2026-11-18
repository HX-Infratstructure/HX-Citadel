import { closestCenter, CollisionDetection, pointerWithin, UniqueIdentifier } from "@dnd-kit/core";
import type { OptimisticLocalStore } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type RankedStory = { _id: string; title: string };
type RankedIssue = { _id: string; sortOrder: number; _creationTime: number };
type BacklogUpdate = { issueId: Id<"issues">; sortOrder?: number; cycleId?: Id<"cycles"> | null };
type Dragged = { active: { id: UniqueIdentifier } };
type DraggedOver = Dragged & { over: { id: UniqueIdentifier } | null };

export const LOAD_MORE_TO_PLACE = "Load more to place a story here.";

/**
 * Whether a story dropped at index `to` of `loaded` stories can be ranked. While more of
 * the backlog is still to load, the last loaded story's lower neighbour is unknown, so a
 * drop there would rank the story below stories not loaded yet.
 */
export function canDropAt(to: number, loaded: number, moreToLoad: boolean): boolean {
  return !moreToLoad || to < loaded - 1;
}

/** Screen-reader announcements for ranking: story titles and 1-based positions, never internal ids. */
export function rankAnnouncements(stories: RankedStory[], moreToLoad: boolean) {
  const title = (id: UniqueIdentifier) =>
    stories.find((story) => story._id === id)?.title ?? "Story";
  const index = (id: UniqueIdentifier) => stories.findIndex((story) => story._id === id);
  const position = (id: UniqueIdentifier) => `position ${index(id) + 1} of ${stories.length}`;
  const dropped = (active: UniqueIdentifier, over: UniqueIdentifier) =>
    canDropAt(index(over), stories.length, moreToLoad)
      ? `${title(active)} dropped at ${position(over)}.`
      : `${title(active)} stays at ${position(active)}. ${LOAD_MORE_TO_PLACE}`;

  return {
    onDragStart: ({ active }: Dragged) =>
      `Picked up ${title(active.id)} at ${position(active.id)}.`,
    onDragOver: ({ active, over }: DraggedOver) =>
      over
        ? `${title(active.id)} is over ${position(over.id)}.`
        : `${title(active.id)} is outside the backlog.`,
    onDragEnd: ({ active, over }: DraggedOver) =>
      over
        ? dropped(active.id, over.id)
        : `${title(active.id)} dropped outside the backlog. Its rank is unchanged.`,
    onDragCancel: ({ active }: Dragged) =>
      `Ranking cancelled. ${title(active.id)} stays at ${position(active.id)}.`,
  };
}

/**
 * The nearest row, except that a pointer outside every row finds none, so a
 * drop outside the list ranks nothing. Keyboard moves carry no pointer.
 */
export const rankCollision: CollisionDetection = (args) =>
  args.pointerCoordinates && pointerWithin(args).length === 0 ? [] : closestCenter(args);

/** Highest first, in the order `listBacklog` reads `by_team_and_sort_order`: rank, then creation time. */
const byRank = (a: RankedIssue, b: RankedIssue) => b.sortOrder - a.sortOrder || b._creationTime - a._creationTime;

/**
 * The page that holds `story`. Loaded pages are consecutive rank ranges, so it is the top page whose
 * lowest row sorts at or below `story`, or the bottom page when none does. Empty pages hold no range.
 */
function pageHolding(pages: RankedIssue[][], story: RankedIssue): number {
  const ends = pages.flatMap((page, index) => (page.length > 0 ? [{ index, lowest: page[page.length - 1] }] : []));
  ends.sort((a, b) => byRank(a.lowest, b.lowest));
  return (ends.find(({ lowest }) => byRank(lowest, story) >= 0) ?? ends[ends.length - 1]).index;
}

/**
 * The pages of one loaded list after an update: a planned story leaves the backlog, and a reranked
 * story moves to the page that holds its new rank, in rank order.
 */
function backlogAfterUpdate<T extends RankedIssue>(pages: T[][], update: BacklogUpdate): T[][] {
  const without = pages.map((page) => page.filter((issue) => issue._id !== update.issueId));
  if (update.cycleId) {
    return without;
  }
  const { sortOrder } = update;
  const story = pages.flat().find((issue) => issue._id === update.issueId);
  if (sortOrder === undefined || story === undefined) {
    return pages;
  }
  const moved = { ...story, sortOrder };
  const target = pageHolding(pages, moved);
  return without.map((page, index) => (index === target ? [...page, moved].sort(byRank) : page));
}

/** Applies an update to every loaded backlog list of the team, each `usePaginatedQuery` on its own. */
export function updateBacklog(localStore: OptimisticLocalStore, teamId: Id<"teams">, update: BacklogUpdate) {
  const loaded = localStore
    .getAllQueries(api.issues.listBacklog)
    .flatMap(({ args, value }) => (value && args.teamId === teamId ? [{ args, value }] : []));
  const lists = new Map<number | undefined, typeof loaded>();
  for (const query of loaded) {
    const { id } = query.args.paginationOpts;
    lists.set(id, [...(lists.get(id) ?? []), query]);
  }
  for (const list of lists.values()) {
    const pages = backlogAfterUpdate(list.map(({ value }) => value.page), update);
    list.forEach(({ args, value }, index) => {
      localStore.setQuery(api.issues.listBacklog, args, { ...value, page: pages[index] });
    });
  }
}
