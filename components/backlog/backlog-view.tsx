"use client";

import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
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
import { LOAD_MORE_TO_PLACE } from "@/lib/sort-order";
import { moveRank, rankAnnouncements, rankCollision, updateBacklog } from "./backlog-dnd";
import { BacklogRow } from "./backlog-row";

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
    patch: { issueId: Id<"issues">; sortOrder?: number; cycleId?: Id<"cycles"> },
    failure: string
  ) => {
    updateIssue(patch).catch((error: unknown) => {
      toast.error(errorMessage(error, failure));
    });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) {
      return;
    }
    const from = issues.findIndex((issue) => issue._id === active.id);
    const to = issues.findIndex((issue) => issue._id === over.id);
    if (from === -1 || to === -1) {
      return;
    }
    const drop = moveRank(issues, from, to, moreToLoad);
    if ("refused" in drop) {
      toast(LOAD_MORE_TO_PLACE);
      return;
    }
    if (drop.sortOrder !== issues[from].sortOrder) {
      update({ issueId: issues[from]._id, sortOrder: drop.sortOrder }, "Failed to rank story");
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
