import { closestCenter, CollisionDetection, pointerWithin, UniqueIdentifier } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { OptimisticLocalStore } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { byRank, type DropOutcome, rankInLoaded, REFUSAL_MESSAGE } from "@/lib/sort-order";

type RankedIssue = { _id: string; sortOrder: number; _creationTime: number };
type RankedStory = RankedIssue & { title: string };
type BacklogUpdate = { issueId: Id<"issues">; sortOrder?: number; cycleId?: Id<"cycles"> | null };
type Dragged = { active: { id: UniqueIdentifier } };
type DraggedOver = Dragged & { over: { id: UniqueIdentifier } | null };

/**
 * What a drop does to the story `activeId` dropped on the story `overId` of the loaded backlog, in rank order; its last
 * story is the floor. `gone` when either story is not loaded, `inPlace` when it is dropped on its own place.
 */
export function backlogDrop({ stories, activeId, overId, moreToLoad }: {
  stories: RankedIssue[];
  activeId: UniqueIdentifier;
  overId: UniqueIdentifier;
  moreToLoad: boolean;
}): DropOutcome {
  const from = stories.findIndex((story) => story._id === activeId);
  const to = stories.findIndex((story) => story._id === overId);
  if (from === -1 || to === -1) {
    return { kind: "gone" };
  }
  if (from === to) {
    return { kind: "inPlace" };
  }
  const moved = arrayMove(stories, from, to);
  return rankInLoaded({
    above: moved[to - 1]?.sortOrder,
    below: moved[to + 1]?.sortOrder,
    own: stories[from].sortOrder,
    floor: stories.at(-1)?.sortOrder,
    moreToLoad,
  });
}

/** Screen-reader announcements for ranking: story titles and 1-based positions, never internal ids. */
export function rankAnnouncements(stories: RankedStory[], moreToLoad: boolean) {
  const title = (id: UniqueIdentifier) =>
    stories.find((story) => story._id === id)?.title ?? "Story";
  const position = (id: UniqueIdentifier) =>
    `position ${stories.findIndex((story) => story._id === id) + 1} of ${stories.length}`;
  const drop = (activeId: UniqueIdentifier, overId: UniqueIdentifier) =>
    backlogDrop({ stories, activeId, overId, moreToLoad });
  const loaded = (id: UniqueIdentifier) => drop(id, id).kind !== "gone";
  const dropped = (active: UniqueIdentifier, over: UniqueIdentifier) => {
    const outcome = drop(active, over);
    if (outcome.kind === "gone") {
      return `${title(active)} was not moved: the backlog changed during the drag.`;
    }
    return outcome.kind === "refused"
      ? `${title(active)} stays at ${position(active)}. ${REFUSAL_MESSAGE[outcome.reason]}`
      : `${title(active)} dropped at ${position(over)}.`;
  };
  const over = (active: UniqueIdentifier, target: UniqueIdentifier) =>
    loaded(target)
      ? `${title(active)} is over ${position(target)}.`
      : `${title(active)} is over a story that left the backlog.`;

  return {
    onDragStart: ({ active }: Dragged) =>
      loaded(active.id) ? `Picked up ${title(active.id)} at ${position(active.id)}.` : `Picked up ${title(active.id)}.`,
    onDragOver: ({ active, over: target }: DraggedOver) =>
      target ? over(active.id, target.id) : `${title(active.id)} is outside the backlog.`,
    onDragEnd: ({ active, over }: DraggedOver) =>
      over
        ? dropped(active.id, over.id)
        : `${title(active.id)} dropped outside the backlog. Its rank is unchanged.`,
    onDragCancel: ({ active }: Dragged) =>
      loaded(active.id)
        ? `Ranking cancelled. ${title(active.id)} stays at ${position(active.id)}.`
        : `Ranking cancelled. ${title(active.id)} is no longer in the backlog.`,
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
