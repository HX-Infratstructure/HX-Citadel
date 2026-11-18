import type { IssuePriority, IssueStatus } from "@/components/shared/issue-meta";
import type { levelFields } from "./create-issue-level";

type LevelFields = ReturnType<typeof levelFields>;

/** The fields a create sends, apart from the team; `level` is `levelFields()` of the choice. */
export type IssueDraft = {
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  level: LevelFields;
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
  const { level: aLevel, ...aFields } = a;
  const { level: bLevel, ...bFields } = b;
  return sameFields(aFields, bFields) && sameFields(aLevel, bLevel);
}

function sameFields<T extends object>(a: T, b: T) {
  return (Object.keys(a) as (keyof T)[]).every((key) => a[key] === b[key]);
}
