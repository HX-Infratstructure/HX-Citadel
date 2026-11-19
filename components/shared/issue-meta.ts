import { Doc, Id } from "@/convex/_generated/dataModel";
import { STATUS_LABELS } from "@/lib/issue-status";

export type IssueStatus = Doc<"issues">["status"];
export type IssuePriority = Doc<"issues">["priority"];
/** A row of `issues.listByTeam`: the issue with its label ids. */
export type TeamIssue = Doc<"issues"> & { labelIds: Id<"labels">[] };

const STATUS_ORDER: IssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"];

export const STATUSES: { value: IssueStatus; label: string }[] = STATUS_ORDER.map((value) => ({
  value,
  label: STATUS_LABELS[value],
}));

export const PRIORITIES: { value: IssuePriority; label: string }[] = [
  { value: "none", label: "No priority" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export function statusLabel(status: IssueStatus): string {
  return STATUSES.find((s) => s.value === status)?.label ?? status;
}

export function priorityLabel(priority: IssuePriority): string {
  return PRIORITIES.find((p) => p.value === priority)?.label ?? priority;
}
