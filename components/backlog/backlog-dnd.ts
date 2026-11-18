import { closestCenter, CollisionDetection, pointerWithin, UniqueIdentifier } from "@dnd-kit/core";

type RankedStory = { _id: string; title: string };
type Dragged = { active: { id: UniqueIdentifier } };
type DraggedOver = Dragged & { over: { id: UniqueIdentifier } | null };

/** Screen-reader announcements for ranking: story titles and 1-based positions, never internal ids. */
export function rankAnnouncements(stories: RankedStory[]) {
  const title = (id: UniqueIdentifier) =>
    stories.find((story) => story._id === id)?.title ?? "Story";
  const position = (id: UniqueIdentifier) =>
    `position ${stories.findIndex((story) => story._id === id) + 1} of ${stories.length}`;

  return {
    onDragStart: ({ active }: Dragged) =>
      `Picked up ${title(active.id)} at ${position(active.id)}.`,
    onDragOver: ({ active, over }: DraggedOver) =>
      over
        ? `${title(active.id)} is over ${position(over.id)}.`
        : `${title(active.id)} is outside the backlog.`,
    onDragEnd: ({ active, over }: DraggedOver) =>
      over
        ? `${title(active.id)} dropped at ${position(over.id)}.`
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
