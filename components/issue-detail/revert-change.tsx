"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  IssuePriority,
  IssueStatus,
  priorityLabel,
  statusLabel,
} from "@/components/shared/issue-meta";
import { errorMessage } from "@/lib/error-message";

/** How a revertible field's recorded value reads in the confirm prompt and the feed. */
const VALUE_LABELS: Record<string, (value: string | undefined) => string> = {
  status: (value) => statusLabel((value ?? "") as IssueStatus),
  priority: (value) => priorityLabel((value ?? "") as IssuePriority),
  title: (value) => value ?? "",
  assignee: (value) => value ?? "unassigned",
};

export function revertValueLabel(field: string, value: string | undefined): string {
  return VALUE_LABELS[field]?.(value) ?? value ?? "";
}

export function RevertChange({
  activityId,
  field,
  oldValue,
}: {
  activityId: Id<"activity">;
  field: string;
  oldValue: string | undefined;
}) {
  const revertChange = useMutation(api.issues.revertChange);
  const [open, setOpen] = useState(false);
  const [reverting, setReverting] = useState(false);
  const prompt = `Revert ${field} to ${revertValueLabel(field, oldValue)}?`;

  const handleRevert = async () => {
    if (reverting) {
      return;
    }
    setReverting(true);
    try {
      await revertChange({ activityId });
      setOpen(false);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to revert the change"));
    } finally {
      setReverting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!reverting) {
          setOpen(next);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <button type="button" className="shrink-0 underline-offset-2 hover:underline">
          Revert
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{prompt}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={reverting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={reverting}
            onClick={(event) => {
              event.preventDefault();
              void handleRevert();
            }}
          >
            Revert
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
