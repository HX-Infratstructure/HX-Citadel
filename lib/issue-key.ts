export type IssueKind = "epic" | "feature" | "story" | "subtask";

const KINDS: IssueKind[] = ["epic", "feature", "story", "subtask"];

/** Each level's parent level; the server's rule table and the UI pickers both read it. */
export const PARENT_KIND: Record<IssueKind, IssueKind | null> = {
  epic: null,
  feature: "epic",
  story: "feature",
  subtask: "story",
};

/** The level a new child of this issue takes, or null when it can have none. */
export function childKindOf(kind: IssueKind): IssueKind | null {
  return KINDS.find((child) => PARENT_KIND[child] === kind) ?? null;
}

/** The issues a new issue of this kind may sit under: those one level up. */
export function validParents<T extends { kind: IssueKind }>(issues: T[], kind: IssueKind): T[] {
  return issues.filter((issue) => issue.kind === PARENT_KIND[kind]);
}

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
