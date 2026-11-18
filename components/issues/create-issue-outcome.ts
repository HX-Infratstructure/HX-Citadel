import type { IssuePriority, IssueStatus } from "@/components/shared/issue-meta";
import type { LevelChoice } from "./create-issue-level";

export type IssueDraft = {
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  level: LevelChoice;
};

/** After a successful create: finish the dialog, clear the submitted draft, or keep a newer draft. */
export type CreateOutcome = "finish" | "clear" | "keep";

export function createIssueOutcome(
  sameSession: boolean,
  submitted: IssueDraft,
  current: IssueDraft
): CreateOutcome {
  if (sameSession) {
    return "finish";
  }
  return sameDraft(submitted, current) ? "clear" : "keep";
}

function sameDraft(a: IssueDraft, b: IssueDraft) {
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.status === b.status &&
    a.priority === b.priority &&
    a.level.kind === b.level.kind &&
    a.level.type === b.level.type &&
    a.level.parentIssueId === b.level.parentIssueId &&
    a.level.projectId === b.level.projectId
  );
}
