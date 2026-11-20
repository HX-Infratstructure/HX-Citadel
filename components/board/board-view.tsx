"use client";

import { errorMessage } from "@/lib/error-message";
import { type LoadedOrder, REFUSAL_MESSAGE } from "@/lib/sort-order";
import {
  closestCorners,
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { IssueStatus, STATUSES, TeamIssue } from "@/components/shared/issue-meta";
import { BoardCardContent, CardAssignee, CardLabel } from "./board-card";
import { BoardColumn, cardLabels, COLUMN_ID_PREFIX } from "./board-column";
import { boardAnchor, boardColumns, Columns, dropRank, updateBoard } from "./board-dnd";

const STATUS_SET = new Set<string>(STATUSES.map((s) => s.value));

function statusFromDroppableId(id: UniqueIdentifier): IssueStatus | null {
  if (typeof id !== "string" || !id.startsWith(COLUMN_ID_PREFIX)) {
    return null;
  }
  const status = id.slice(COLUMN_ID_PREFIX.length);
  return STATUS_SET.has(status) ? (status as IssueStatus) : null;
}

function findContainer(
  columns: Columns,
  id: UniqueIdentifier
): IssueStatus | null {
  for (const { value } of STATUSES) {
    if (columns[value].includes(id as Id<"issues">)) {
      return value;
    }
  }
  return null;
}

/**
 * Kanban board: one column per status, drag-and-drop via @dnd-kit. Drops
 * persist through `issues.update` with a fractional sortOrder between the
 * new neighbors, applied optimistically. A drop into a tie can show in
 * creation order until the server answers. `issues` are the filtered
 * loaded pages of the team's list, and `loaded` is the order of every
 * loaded issue, unfiltered.
 */
export function BoardView({
  issues,
  loaded,
  teamId,
  teamKey,
  orgSlug,
  labelsById,
  assigneesById,
}: {
  issues: TeamIssue[];
  loaded: LoadedOrder;
  teamId: Id<"teams">;
  teamKey: string;
  orgSlug: string;
  labelsById: Map<Id<"labels">, CardLabel>;
  assigneesById: Map<string, CardAssignee>;
}) {
  const router = useRouter();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const updateIssue = useMutation(api.issues.update).withOptimisticUpdate(
    (localStore, args) => updateBoard(localStore, teamId, args)
  );

  const issueById = useMemo(
    () => new Map(issues.map((issue) => [issue._id, issue])),
    [issues]
  );

  const serverColumns = useMemo(() => boardColumns(issues), [issues]);

  const [dragState, setDragState] = useState<{
    activeId: Id<"issues">;
    columns: Columns;
  } | null>(null);

  // Suppresses the click that browsers fire right after a drop, so dropping
  // a card doesn't navigate to the issue page. Plain clicks never activate
  // the drag sensor (4px constraint), so they are unaffected.
  const suppressClickRef = useRef(false);

  const columns = dragState?.columns ?? serverColumns;
  const activeIssue = dragState ? issueById.get(dragState.activeId) : undefined;

  const openIssue = (issueId: Id<"issues">) => {
    if (suppressClickRef.current) {
      return;
    }
    router.push(`/${orgSlug}/issue/${issueId}`);
  };

  const handleDragStart = (event: DragStartEvent) => {
    suppressClickRef.current = true;
    setDragState({
      activeId: event.active.id as Id<"issues">,
      columns: serverColumns,
    });
  };

  const releaseClickSuppression = () => {
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 120);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) {
      return;
    }
    const activeId = active.id as Id<"issues">;
    setDragState((prev) => {
      if (!prev) {
        return prev;
      }
      const activeContainer = findContainer(prev.columns, activeId);
      const overStatus = statusFromDroppableId(over.id);
      const overContainer = overStatus ?? findContainer(prev.columns, over.id);
      if (
        !activeContainer ||
        !overContainer ||
        activeContainer === overContainer
      ) {
        return prev;
      }

      // Move the card into the hovered column at the hovered position.
      const overItems = prev.columns[overContainer];
      let newIndex = overItems.length;
      if (!overStatus) {
        const overIndex = overItems.indexOf(over.id as Id<"issues">);
        const isBelowOverItem =
          active.rect.current.translated !== null &&
          active.rect.current.translated !== undefined &&
          active.rect.current.translated.top > over.rect.top + over.rect.height / 2;
        newIndex = overIndex >= 0 ? overIndex + (isBelowOverItem ? 1 : 0) : overItems.length;
      }

      return {
        ...prev,
        columns: {
          ...prev.columns,
          [activeContainer]: prev.columns[activeContainer].filter(
            (id) => id !== activeId
          ),
          [overContainer]: [
            ...overItems.slice(0, newIndex),
            activeId,
            ...overItems.slice(newIndex),
          ],
        },
      };
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const state = dragState;
    setDragState(null);
    releaseClickSuppression();
    if (!state || !over) {
      return;
    }

    const activeId = active.id as Id<"issues">;
    let workingColumns = state.columns;
    const activeContainer = findContainer(workingColumns, activeId);
    if (!activeContainer) {
      return;
    }

    // Same-column reorder: cross-column moves already happened in onDragOver.
    const overStatus = statusFromDroppableId(over.id);
    if (!overStatus && over.id !== activeId) {
      const overContainer = findContainer(workingColumns, over.id);
      if (overContainer === activeContainer) {
        const items = workingColumns[activeContainer];
        const oldIndex = items.indexOf(activeId);
        const newIndex = items.indexOf(over.id as Id<"issues">);
        if (oldIndex !== -1 && newIndex !== -1) {
          workingColumns = {
            ...workingColumns,
            [activeContainer]: arrayMove(items, oldIndex, newIndex),
          };
        }
      }
    }

    const column = workingColumns[activeContainer].flatMap(
      (id) => issueById.get(id) ?? []
    );
    const index = column.findIndex((card) => card._id === activeId);
    if (index === -1) {
      return;
    }
    const issue = column[index];
    const statusChanged = activeContainer !== issue.status;
    if (!statusChanged && serverColumns[activeContainer][index] === activeId) {
      return;
    }
    const drop = dropRank({ column, index, loaded, fromOtherColumn: statusChanged });
    if (drop.kind === "refused") {
      toast(REFUSAL_MESSAGE[drop.reason]);
      return;
    }
    const orderChanged = drop.kind === "ranked";
    if (!statusChanged && !orderChanged) {
      return;
    }

    updateIssue({
      issueId: activeId,
      ...(statusChanged ? { status: activeContainer } : {}),
      ...(orderChanged ? { sortOrder: drop.sortOrder, aboveId: boardAnchor(column, index) } : {}),
    }).catch((error: unknown) => {
      toast.error(
        errorMessage(error, "Failed to move issue")
      );
    });
  };

  const handleDragCancel = () => {
    setDragState(null);
    releaseClickSuppression();
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto p-3">
        {STATUSES.map(({ value, label }) => (
          <BoardColumn
            key={value}
            status={value}
            label={label}
            issues={columns[value]
              .map((id) => issueById.get(id))
              .filter((issue): issue is TeamIssue => issue !== undefined)}
            moreToLoad={loaded.moreToLoad}
            teamId={teamId}
            teamKey={teamKey}
            labelsById={labelsById}
            assigneesById={assigneesById}
            onOpenIssue={openIssue}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <BoardCardContent
            issue={activeIssue}
            teamKey={teamKey}
            labels={cardLabels(activeIssue, labelsById)}
            assignee={
              activeIssue.assigneeId
                ? assigneesById.get(activeIssue.assigneeId)
                : undefined
            }
            overlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
