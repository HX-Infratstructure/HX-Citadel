import type { Doc } from "../convex/_generated/dataModel";
import { isGatedStatus } from "./issue-status";

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

type ParentCandidate = { kind: IssueKind; status: Doc<"issues">["status"] };

/** The issues a new issue of this kind may sit under: those one level up that are not In Review or Done. */
export function validParents<T extends ParentCandidate>(issues: T[], kind: IssueKind): T[] {
  return issues.filter((issue) => issue.kind === PARENT_KIND[kind] && !isGatedStatus(issue.status));
}

/** Whether each level must sit under a parent; the server's rule table and the UI pickers both read it. */
export const PARENT_REQUIRED: Record<IssueKind, boolean> = {
  epic: false,
  feature: true,
  story: false,
  subtask: true,
};

/** Whether each level must belong to a project; the server's rule table and the create form both read it. */
export const PROJECT_REQUIRED: Record<IssueKind, boolean> = {
  epic: true,
  feature: false,
  story: false,
  subtask: false,
};

export type ParentChoices<T> = { parents: T[]; allowsNone: boolean };

/** Where an existing issue may move: its valid parents, and whether it may stand alone; null for a level with no parent. */
export function parentChoices<T extends ParentCandidate>(
  issues: T[],
  kind: IssueKind
): ParentChoices<T> | null {
  if (PARENT_KIND[kind] === null) {
    return null;
  }
  return { parents: validParents(issues, kind), allowsNone: !PARENT_REQUIRED[kind] };
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

const HAS_DISPLAY_KEY: Record<IssueKind, boolean> = {
  epic: false,
  feature: false,
  story: true,
  subtask: true,
};

/** Stories and subtasks have a display key; epics and features show their kind badge alone. */
export function hasDisplayKey(kind: IssueKind): boolean {
  return HAS_DISPLAY_KEY[kind];
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
