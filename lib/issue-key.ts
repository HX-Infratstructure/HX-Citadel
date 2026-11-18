export type IssueKind = "epic" | "feature" | "story" | "subtask";

export type KeyedIssue = {
  kind: IssueKind;
  number?: number;
  subNumber?: number;
};

function storyKey(teamKey: string, number: number | undefined): string | null {
  if (number === undefined) {
    return null;
  }
  return `${teamKey}-${number}`;
}

function subtaskKey(
  teamKey: string,
  parentNumber: number | undefined,
  subNumber: number | undefined
): string | null {
  if (parentNumber === undefined || subNumber === undefined) {
    return null;
  }
  return `${teamKey}-${parentNumber}.${subNumber}`;
}

/** Display key: KEY-12 for a story, KEY-12.3 for a subtask; null for epics, features or a missing number. */
export function formatIssueKey(
  teamKey: string,
  issue: KeyedIssue,
  parentNumber?: number
): string | null {
  switch (issue.kind) {
    case "story":
      return storyKey(teamKey, issue.number);
    case "subtask":
      return subtaskKey(teamKey, parentNumber, issue.subNumber);
    default:
      return null;
  }
}
