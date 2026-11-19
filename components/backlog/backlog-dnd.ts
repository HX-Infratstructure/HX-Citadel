import { closestCenter, CollisionDetection, pointerWithin, UniqueIdentifier } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { OptimisticLocalStore } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { byRank, type DropRank, rankInLoaded, REFUSAL_MESSAGE } from "@/lib/sort-order";

type RankedIssue = { _id: string; sortOrder: number; _creationTime: number };
type RankedStory = RankedIssue & { title: string };
type BacklogUpdate = { issueId: Id<"issues">; sortOrder?: number; cycleId?: Id<"cycles"> | null };
type Dragged = { active: { id: UniqueIdentifier } };
type DraggedOver = Dragged & { over: { id: UniqueIdentifier } | null };

/**
 * The rank for the story moved from index `from` to `to` of the loaded backlog, in rank order; its last story is the floor.
 * `from` and `to` are indexes of loaded stories.
 * A move inside a run of stories at the story's own rank is refused as no room: that rank is unchanged, so the server
 * would not move the story.
 */
export function moveRank({ stories, from, to, moreToLoad }: {
  stories: RankedIssue[];
  from: number;
  to: number;
  moreToLoad: boolean;
}): DropRank {
  const moved = arrayMove(stories, from, to);
  const drop = rankInLoaded({
    above: moved[to - 1]?.sortOrder,
    below: moved[to + 1]?.sortOrder,
    floor: stories.at(-1)?.sortOrder,
    moreToLoad,
  });
  const rankUnchanged = from !== to && "sortOrder" in drop && drop.sortOrder === stories[from].sortOrder;
  return rankUnchanged ? { refused: "noRoom" } : drop;
}

/** Screen-reader announcements for ranking: story titles and 1-based positions, never internal ids. */
export function rankAnnouncements(stories: RankedStory[], moreToLoad: boolean) {
  const title = (id: UniqueIdentifier) =>
    stories.find((story) => story._id === id)?.title ?? "Story";
  const index = (id: UniqueIdentifier) => stories.findIndex((story) => story._id === id);
  const position = (id: UniqueIdentifier) => `position ${index(id) + 1} of ${stories.length}`;
  const dropped = (active: UniqueIdentifier, over: UniqueIdentifier) => {
    if (index(active) === -1 || index(over) === -1) {
      return `${title(active)} was not moved: the backlog changed during the drag.`;
    }
    const drop = moveRank({ stories, from: index(active), to: index(over), moreToLoad });
    return "refused" in drop
      ? `${title(active)} stays at ${position(active)}. ${REFUSAL_MESSAGE[drop.refused]}`
      : `${title(active)} dropped at ${position(over)}.`;
  };

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
