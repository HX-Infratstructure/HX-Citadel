import { closestCenter, CollisionDetection, pointerWithin, UniqueIdentifier } from "@dnd-kit/core";

type RankedStory = { _id: string; title: string };
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
