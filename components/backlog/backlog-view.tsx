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
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/error-message";
import { sortOrderBetween } from "@/lib/sort-order";
import { backlogAfterUpdate, canDropAt, LOAD_MORE_TO_PLACE, rankAnnouncements, rankCollision } from "./backlog-dnd";
import { BacklogRow } from "./backlog-row";

/** The new `sortOrder` for the row moved from `from` to `to`, or undefined when it stays put. */
function rankAfterMove(
  issues: Doc<"issues">[],
  from: number,
  to: number
): number | undefined {
  const moved = arrayMove(issues, from, to);
  const sortOrder = sortOrderBetween(
    moved[to - 1]?.sortOrder,
    moved[to + 1]?.sortOrder
  );
  return sortOrder === issues[from].sortOrder ? undefined : sortOrder;
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
  const updateIssue = useMutation(api.issues.update).withOptimisticUpdate(
    (localStore, args) => {
      const loaded = localStore
        .getAllQueries(api.issues.listBacklog)
        .flatMap(({ args: pageArgs, value }) =>
          value && pageArgs.teamId === team._id ? [{ pageArgs, value }] : []
        );
      const pages = backlogAfterUpdate(loaded.map(({ value }) => value.page), args);
      loaded.forEach(({ pageArgs, value }, index) => {
        localStore.setQuery(api.issues.listBacklog, pageArgs, { ...value, page: pages[index] });
      });
    }
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
    if (!canDropAt(to, issues.length, moreToLoad)) {
      toast(LOAD_MORE_TO_PLACE);
      return;
    }
    const sortOrder = rankAfterMove(issues, from, to);
    if (sortOrder !== undefined) {
      update({ issueId: issues[from]._id, sortOrder }, "Failed to rank story");
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
