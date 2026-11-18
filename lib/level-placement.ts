import { IssueKind, PARENT_REQUIRED, PROJECT_REQUIRED } from "./issue-key";

export type MissingPlacement = "project" | "parent";

/** What a new issue still lacks before the server accepts it: a required project or a required parent. */
export function missingPlacement(choice: {
  kind: IssueKind;
  parentIssueId?: string;
  projectId?: string;
}): MissingPlacement | null {
  if (PROJECT_REQUIRED[choice.kind] && !choice.projectId) {
    return "project";
  }
  if (PARENT_REQUIRED[choice.kind] && !choice.parentIssueId) {
    return "parent";
  }
  return null;
}
