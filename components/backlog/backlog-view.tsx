"use client";

import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/error-message";
import { REFUSAL_MESSAGE } from "@/lib/sort-order";
import { backlogDrop, rankAnnouncements, rankCollision, updateBacklog } from "./backlog-dnd";
import { BacklogRow } from "./backlog-row";

/**
 * The loaded story right above the slot `activeId` lands in when dropped on `overId`, or `null` at the top: the target
 * itself when moving down, the story before the target when moving up.
 */
function storyAbove(stories: Doc<"issues">[], activeId: UniqueIdentifier, overId: UniqueIdentifier): Id<"issues"> | null {
  const from = stories.findIndex((story) => story._id === activeId);
  const to = stories.findIndex((story) => story._id === overId);
  return (from < to ? stories[to] : stories[to - 1])?._id ?? null;
}

export function BacklogView({
  team,
  issues,
  moreToLoad,
}: {
  team: Doc<"teams">;
  issues: Doc<"issues">[];
  moreToLoad: boolean;
}) {
  const cycles = useQuery(api.cycles.listByTeam, { teamId: team._id });
  const updateIssue = useMutation(api.issues.update).withOptimisticUpdate((localStore, args) =>
    updateBacklog(localStore, team._id, args)
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const update = (
    patch: { issueId: Id<"issues">; sortOrder?: number; aboveId?: Id<"issues"> | null; cycleId?: Id<"cycles"> },
    failure: string
  ) => {
    updateIssue(patch).catch((error: unknown) => {
      toast.error(errorMessage(error, failure));
    });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) {
      return;
    }
    const drop = backlogDrop({ stories: issues, activeId: active.id, overId: over.id, moreToLoad });
    if (drop.kind === "refused") {
      toast(REFUSAL_MESSAGE[drop.reason]);
    }
    if (drop.kind === "ranked") {
      const aboveId = storyAbove(issues, active.id, over.id);
      update({ issueId: active.id as Id<"issues">, sortOrder: drop.sortOrder, aboveId }, "Failed to rank story");
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={rankCollision}
      accessibility={{ announcements: rankAnnouncements(issues, moreToLoad) }}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={issues.map((issue) => issue._id)}
        strategy={verticalListSortingStrategy}
      >
        {issues.map((issue) => (
          <BacklogRow
            key={issue._id}
            issue={issue}
            teamKey={team.key}
            cycles={cycles}
            onMoveToCycle={(cycleId) =>
              update({ issueId: issue._id, cycleId }, "Failed to plan story")
            }
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}
