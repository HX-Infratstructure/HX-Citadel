import type { Doc } from "../convex/_generated/dataModel";
import type { IssueKind } from "./issue-key";

type IssueStatus = Doc<"issues">["status"];

/** An issue enters these statuses only through the Done gate (`convex/lib/rules/doneGate.ts`). */
export const GATED_STATUSES = ["in_review", "done"] as const satisfies readonly IssueStatus[];

export type GatedStatus = (typeof GATED_STATUSES)[number];

export const STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

export const GATED_LABELS: Record<GatedStatus, string> = {
  in_review: STATUS_LABELS.in_review,
  done: STATUS_LABELS.done,
};

export function isGatedStatus(status: IssueStatus): status is GatedStatus {
  return (GATED_STATUSES as readonly IssueStatus[]).includes(status);
}

/** The statuses a new issue of this kind may start in. A new story has an open testing sub-task, so the gate refuses it a gated status. */
export function statusesFor<T extends { value: IssueStatus }>(statuses: T[], kind: IssueKind): T[] {
  return statuses.filter((status) => kind !== "story" || !isGatedStatus(status.value));
}
