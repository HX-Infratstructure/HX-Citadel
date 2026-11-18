"use client";

import { useMutation } from "convex/react";
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

/** The fields an owner may revert, each naming its old value for the confirm prompt. */
const REVERTIBLE_FIELDS: Record<string, (value: string | undefined) => string> = {
  status: (value) => statusLabel((value ?? "") as IssueStatus),
  priority: (value) => priorityLabel((value ?? "") as IssuePriority),
  title: (value) => value ?? "",
  assignee: (value) => value ?? "unassigned",
};

export function revertibleValueLabel(field: string, value: string | undefined): string {
  return REVERTIBLE_FIELDS[field]?.(value) ?? value ?? "";
}

export function isRevertible(entry: { type: string; field?: string }): boolean {
  return entry.type === `${entry.field}_changed` && entry.field! in REVERTIBLE_FIELDS;
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
  const prompt = `Revert ${field} to ${revertibleValueLabel(field, oldValue)}?`;

  const handleRevert = () => {
    revertChange({ activityId }).catch((error: unknown) => {
      toast.error(errorMessage(error, "Failed to revert the change"));
    });
  };

  return (
    <AlertDialog>
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
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleRevert}>Revert</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
