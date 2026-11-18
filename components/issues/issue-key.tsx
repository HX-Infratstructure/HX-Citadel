"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { formatIssueKey } from "@/lib/issue-key";

type LabelledIssue = Pick<Doc<"issues">, "kind" | "type">;
type KeyIssue = Pick<
  Doc<"issues">,
  "kind" | "type" | "number" | "subNumber" | "parentIssueId"
>;

export const KIND_LABELS: Record<Doc<"issues">["kind"], string> = {
  epic: "Epic",
  feature: "Feature",
  story: "Story",
  subtask: "Sub-task",
};

export const STORY_TYPE_LABELS: Record<NonNullable<Doc<"issues">["type"]>, string> = {
  story: "Story",
  bug: "Bug",
  chore: "Chore",
};

export function issueKindLabel(issue: LabelledIssue): string {
  if (issue.kind === "story" && issue.type) {
    return STORY_TYPE_LABELS[issue.type];
  }
  return KIND_LABELS[issue.kind];
}

export function IssueKindBadge({ issue }: { issue: LabelledIssue }) {
  return (
    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
      {issueKindLabel(issue)}
    </Badge>
  );
}

/** Subtask keys (KEY-12.3) need the parent story's number. */
function useParentNumber(issue: KeyIssue): number | undefined {
  const parentId = issue.kind === "subtask" ? issue.parentIssueId : undefined;
  const parent = useQuery(api.issues.get, parentId ? { issueId: parentId } : "skip");
  return parent?.number;
}

/** The issue's display key and kind badge; epics and features have no key, so they show the badge alone. */
export function IssueKey({
  teamKey,
  issue,
  className,
}: {
  teamKey: string;
  issue: KeyIssue;
  className?: string;
}) {
  const parentNumber = useParentNumber(issue);
  const key = formatIssueKey(teamKey, issue, parentNumber);
  return (
    <>
      {key && <span className={className}>{key}</span>}
      <IssueKindBadge issue={issue} />
    </>
  );
}

/** The issue's key as plain text, for titles and breadcrumbs; empty for epics and features. */
export function useIssueKeyText(teamKey: string, issue: KeyIssue): string {
  const parentNumber = useParentNumber(issue);
  return formatIssueKey(teamKey, issue, parentNumber) ?? issueKindLabel(issue);
}
