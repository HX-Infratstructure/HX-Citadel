export type IssueKind = "epic" | "feature" | "story" | "subtask";

export type KeyedIssue = {
  kind: IssueKind;
  number?: number;
  subNumber?: number;
};

/** Display key: KEY-12 for a story, KEY-12.3 for a subtask, none for epics and features. */
export function formatIssueKey(
  teamKey: string,
  issue: KeyedIssue,
  parentNumber?: number
): string | null {
  switch (issue.kind) {
    case "story":
      return `${teamKey}-${issue.number}`;
    case "subtask":
      return `${teamKey}-${parentNumber}.${issue.subNumber}`;
    default:
      return null;
  }
}
