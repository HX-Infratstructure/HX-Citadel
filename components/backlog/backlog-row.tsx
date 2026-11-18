"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { CycleSelect } from "@/components/cycles/cycle-select";
import { IssueRow } from "@/components/issues/issue-row";
import { cn } from "@/lib/utils";

export function BacklogRow({
  issue,
  teamKey,
  cycles,
  onMoveToCycle,
}: {
  issue: Doc<"issues">;
  teamKey: string;
  cycles: Doc<"cycles">[] | undefined;
  onMoveToCycle: (cycleId: Id<"cycles">) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: issue._id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex items-center bg-background", isDragging && "opacity-60")}
    >
      <button
        type="button"
        aria-label="Drag to rank"
        className="cursor-grab px-1 text-muted-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <IssueRow issue={issue} teamKey={teamKey} />
      </div>
      <CycleSelect
        cycles={cycles}
        value={undefined}
        noneLabel="Move to cycle"
        onChange={(cycleId) => cycleId && onMoveToCycle(cycleId)}
      />
    </div>
  );
}
