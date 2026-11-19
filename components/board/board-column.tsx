"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { IssueStatus, TeamIssue } from "@/components/shared/issue-meta";
import { StatusIcon } from "@/components/shared/status-icon";
import { loadedCount } from "@/components/shared/use-paged-list";
import { isGatedStatus } from "@/lib/issue-status";
import { cn } from "@/lib/utils";
import { BoardCard, CardAssignee, CardLabel } from "./board-card";
import { QuickCreateCard } from "./quick-create-card";

export const COLUMN_ID_PREFIX = "column:";

/** An issue's labels as its card shows them, skipping ids that are not among the workspace's labels. */
export function cardLabels(issue: TeamIssue, labelsById: Map<Id<"labels">, CardLabel>): CardLabel[] {
  return issue.labelIds.flatMap((labelId) => labelsById.get(labelId) ?? []);
}

export function BoardColumn({
  status,
  label,
  issues,
  moreToLoad,
  teamId,
  teamKey,
  labelsById,
  assigneesById,
  onOpenIssue,
}: {
  status: IssueStatus;
  label: string;
  issues: TeamIssue[];
  moreToLoad: boolean;
  teamId: Id<"teams">;
  teamKey: string;
  labelsById: Map<Id<"labels">, CardLabel>;
  assigneesById: Map<string, CardAssignee>;
  onOpenIssue: (issueId: Id<"issues">) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${COLUMN_ID_PREFIX}${status}`,
    data: { type: "column", status },
  });
  const [composerOpen, setComposerOpen] = useState(false);
  const canQuickCreate = !isGatedStatus(status);

  return (
    <div className="flex max-h-full w-72 shrink-0 flex-col rounded-lg bg-muted/40">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <StatusIcon status={status} />
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">
          {loadedCount(issues.length, moreToLoad)}
        </span>
        {canQuickCreate ? (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-6 text-muted-foreground"
            onClick={() => setComposerOpen(true)}
            aria-label={`New ${label} issue`}
          >
            <Plus className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <SortableContext
        items={issues.map((issue) => issue._id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className={cn(
            "flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto rounded-b-lg p-2 pt-0 transition-colors",
            isOver && "bg-accent/40"
          )}
        >
          {composerOpen ? (
            <QuickCreateCard
              teamId={teamId}
              status={status}
              onClose={() => setComposerOpen(false)}
            />
          ) : null}
          {issues.map((issue) => (
            <BoardCard
              key={issue._id}
              issue={issue}
              teamKey={teamKey}
              labels={cardLabels(issue, labelsById)}
              assignee={
                issue.assigneeId
                  ? assigneesById.get(issue.assigneeId)
                  : undefined
              }
              onOpen={() => onOpenIssue(issue._id)}
            />
          ))}
          {canQuickCreate && issues.length === 0 && !composerOpen ? (
            <button
              onClick={() => setComposerOpen(true)}
              className="flex h-14 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground/70 transition-colors hover:border-muted-foreground/40 hover:text-muted-foreground"
            >
              Drop issues here or click to add
            </button>
          ) : null}
          {!canQuickCreate && issues.length === 0 ? (
            <div className="flex h-14 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground/70">
              Drop issues here
            </div>
          ) : null}
        </div>
      </SortableContext>
    </div>
  );
}
