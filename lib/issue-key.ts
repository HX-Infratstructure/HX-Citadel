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
      return issue.number === undefined ? null : formatParsedKey({ teamKey, number: issue.number });
    case "subtask":
      return parentNumber === undefined || issue.subNumber === undefined
        ? null
        : formatParsedKey({ teamKey, number: parentNumber, subNumber: issue.subNumber });
    default:
      return null;
  }
}

/** A team key: 1-5 upper-case letters and digits, starting with a letter. */
const TEAM_KEY_PATTERN = "[A-Z][A-Z0-9]{0,4}";

const TEAM_KEY = new RegExp(`^${TEAM_KEY_PATTERN}$`);

export const TEAM_KEY_RULE = "Team key must be 1-5 characters, letters and digits, starting with a letter";

export function isValidTeamKey(key: string): boolean {
  return TEAM_KEY.test(key);
}

/** The stored form of a typed team key: trimmed and upper-case, so "eng" names ENG. */
export function normalizeTeamKey(key: string): string {
  return key.trim().toUpperCase();
}

/** A valid team key from a team name's word initials, or "" when the name has no letter to start one. */
export function suggestTeamKey(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .replace(/^[0-9]+/, "")
    .slice(0, 5);
}

export type ParsedIssueKey = { teamKey: string; number: number; subNumber?: number };

const ISSUE_KEY = new RegExp(`^(${TEAM_KEY_PATTERN})-(\\d+)(?:\\.(\\d+))?$`, "i");

/** Reads KEY-12 or KEY-12.3, in any case, with leading zeros, and with whitespace around it; else null. */
export function parseIssueKey(key: string): ParsedIssueKey | null {
  const match = ISSUE_KEY.exec(key.trim());
  if (match === null) {
    return null;
  }
  const parsed: ParsedIssueKey = { teamKey: match[1].toUpperCase(), number: Number(match[2]) };
  if (match[3] !== undefined) {
    parsed.subNumber = Number(match[3]);
  }
  return parsed;
}

/** KEY-12, or KEY-12.3 with a sub-number: the one place an issue key is written. */
export function formatParsedKey({ teamKey, number, subNumber }: ParsedIssueKey): string {
  return subNumber === undefined ? `${teamKey}-${number}` : `${teamKey}-${number}.${subNumber}`;
}
