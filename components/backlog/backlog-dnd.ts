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

/** Where the story `id` sits in the loaded backlog, or undefined when it is not loaded. */
function loadedIndex(stories: RankedIssue[], id: UniqueIdentifier) {
  const index = stories.findIndex((story) => story._id === id);
  return index === -1 ? undefined : index;
}

type Landing<T> = { from: number; to: number; above?: T; below?: T };

/**
 * Where the story `activeId` lands when dropped on the story `overId`: its old and new place and its new neighbours in
 * the loaded backlog after the move. Undefined when either story is not loaded.
 */
function landing<T extends RankedIssue>(
  stories: T[],
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier
): Landing<T> | undefined {
  const from = loadedIndex(stories, activeId);
  const to = loadedIndex(stories, overId);
  if (from === undefined || to === undefined) {
    return undefined;
  }
  const moved = arrayMove(stories, from, to);
  return { from, to, above: moved[to - 1], below: moved[to + 1] };
}

/** The loaded story a drop of `activeId` on `overId` lands right under, the one `backlogDrop` ranks against; else null. */
export function backlogAnchor<T extends RankedIssue>(
  stories: T[],
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier
): T["_id"] | null {
  return landing(stories, activeId, overId)?.above?._id ?? null;
}

/** A drop in the backlog, or `gone`: a story left the loaded backlog during the drag. */
export type BacklogDrop = DropOutcome | { kind: "gone" };

/**
 * What a drop does to the story `activeId` dropped on the story `overId` of the loaded backlog, in rank order; its last
 * story is the floor. `gone` when either story is not loaded, `inPlace` when it is dropped on its own place.
 */
export function backlogDrop({ stories, activeId, overId, moreToLoad }: {
  stories: RankedIssue[];
  activeId: UniqueIdentifier;
  overId: UniqueIdentifier;
  moreToLoad: boolean;
}): BacklogDrop {
  const landed = landing(stories, activeId, overId);
  if (landed === undefined) {
    return { kind: "gone" };
  }
  const { from, to, above, below } = landed;
  if (from === to) {
    return { kind: "inPlace" };
  }
  return rankInLoaded({
    above: above?.sortOrder,
    below: below?.sortOrder,
    own: stories[from].sortOrder,
    floor: stories.at(-1)?.sortOrder,
    moreToLoad,
  });
}

/** Screen-reader announcements for ranking: story titles and 1-based positions, never internal ids. */
export function rankAnnouncements(stories: RankedStory[], moreToLoad: boolean) {
  const title = (id: UniqueIdentifier) =>
    stories.find((story) => story._id === id)?.title ?? "Story";
  /** "position K of N" for a loaded story, or undefined once it has left the backlog. */
  const position = (id: UniqueIdentifier) => {
    const index = loadedIndex(stories, id);
    return index === undefined ? undefined : `position ${index + 1} of ${stories.length}`;
  };
  const dropped = (active: UniqueIdentifier, over: UniqueIdentifier) => {
    const outcome = backlogDrop({ stories, activeId: active, overId: over, moreToLoad });
    if (outcome.kind === "gone") {
      return `${title(active)} was not moved: the backlog changed during the drag.`;
    }
    return outcome.kind === "refused"
      ? `${title(active)} stays at ${position(active)}. ${REFUSAL_MESSAGE[outcome.reason]}`
      : `${title(active)} dropped at ${position(over)}.`;
  };
  const overText = (active: UniqueIdentifier, target: UniqueIdentifier) => {
    const at = position(target);
    return at ? `${title(active)} is over ${at}.` : `${title(active)} is over a story that left the backlog.`;
  };

  return {
    onDragStart: ({ active }: Dragged) => {
      const at = position(active.id);
      return at ? `Picked up ${title(active.id)} at ${at}.` : `Picked up ${title(active.id)}.`;
    },
    onDragOver: ({ active, over }: DraggedOver) =>
      over ? overText(active.id, over.id) : `${title(active.id)} is outside the backlog.`,
    onDragEnd: ({ active, over }: DraggedOver) =>
      over
        ? dropped(active.id, over.id)
        : `${title(active.id)} dropped outside the backlog. Its rank is unchanged.`,
    onDragCancel: ({ active }: Dragged) => {
      const at = position(active.id);
      return at
        ? `Ranking cancelled. ${title(active.id)} stays at ${at}.`
        : `Ranking cancelled. ${title(active.id)} is no longer in the backlog.`;
    },
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
