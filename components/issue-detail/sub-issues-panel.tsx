"use client";

import { errorMessage } from "@/lib/error-message";
import { useMutation, useQuery } from "convex/react";
import { CornerUpLeft, Plus } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { IssueKey, IssueKindBadge } from "@/components/issues/issue-key";
import { IssueDetailSlotProps } from "@/components/issue-detail/slots";
import { PriorityIcon } from "@/components/shared/priority-icon";
import { StatusIcon } from "@/components/shared/status-icon";
import { UserAvatar } from "@/components/shared/user-avatar";
import { childKindOf, hasDisplayKey, ParentChoices, parentChoices } from "@/lib/issue-key";
import { isGatedStatus } from "@/lib/issue-status";

const NO_PARENT = "none";

function ParentLink({
  parentId,
  teamKey,
}: {
  parentId: Id<"issues">;
  teamKey: string;
}) {
  const params = useParams<{ orgSlug: string }>();
  const parent = useQuery(api.issues.get, { issueId: parentId });
  if (!parent) {
    return null;
  }

  return (
    <Link
      href={`/${params.orgSlug}/issue/${parent._id}`}
      className="flex min-w-0 items-center gap-1.5 hover:text-foreground"
    >
      <IssueKey teamKey={teamKey} issue={parent} className="font-mono" />
      <span className="truncate">{parent.title}</span>
    </Link>
  );
}

/** Moves the issue under another valid parent, or to none where its level may stand alone. */
function ParentPicker({
  issue,
  teamKey,
  choices,
}: {
  issue: Doc<"issues">;
  teamKey: string;
  choices: ParentChoices<Doc<"issues">>;
}) {
  const setParent = useMutation(api.issueRelations.setParent);
  const projects = useQuery(api.projects.list);
  const move = (value: string) => {
    const parentIssueId = value === NO_PARENT ? null : (value as Id<"issues">);
    setParent({ issueId: issue._id, parentIssueId }).catch((error: unknown) => {
      toast.error(errorMessage(error, "Failed to move issue"));
    });
  };

  return (
    <Select value={issue.parentIssueId ?? NO_PARENT} onValueChange={move}>
      <SelectTrigger
        size="sm"
        aria-label="Move to another parent"
        className="h-6 w-auto gap-1 border-none px-1.5 text-xs shadow-none"
      >
        Move
      </SelectTrigger>
      <SelectContent>
        {choices.allowsNone && (
          <SelectItem value={NO_PARENT}>No parent</SelectItem>
        )}
        {!choices.allowsNone && choices.parents.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No other open parent
          </div>
        )}
        {choices.parents.map((parent) => {
          const project = projects?.find(
            (candidate) => candidate._id === parent.projectId
          );
          return (
            <SelectItem key={parent._id} value={parent._id}>
              <IssueKey
                teamKey={teamKey}
                issue={parent}
                className="font-mono text-xs text-muted-foreground"
              />
              <span className="truncate">{parent.title}</span>
              {project && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {project.name}
                </span>
              )}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** The issue's parent, with a picker to move it; a testing sub-task cannot move, so it gets none. */
function ParentRow({ issue, team }: IssueDetailSlotProps) {
  const candidates = useQuery(
    api.issues.listParentCandidates,
    issue.testing ? "skip" : { teamId: team._id, kind: issue.kind }
  );
  const choices = issue.testing ? null : parentChoices(candidates ?? [], issue.kind);
  if (!issue.parentIssueId && !choices) {
    return null;
  }

  return (
    <div className="flex h-7 items-center gap-2 text-xs text-muted-foreground">
      <CornerUpLeft className="size-3.5 shrink-0" />
      <span className="shrink-0">Parent</span>
      {issue.parentIssueId ? (
        <ParentLink parentId={issue.parentIssueId} teamKey={team.key} />
      ) : (
        <span>None</span>
      )}
      {choices && (
        <ParentPicker issue={issue} teamKey={team.key} choices={choices} />
      )}
    </div>
  );
}

/** Parent link + sub-issue list with inline creation, under the description. */
export function SubIssuesPanel({ issue, team }: IssueDetailSlotProps) {
  const params = useParams<{ orgSlug: string }>();
  const hierarchy = useQuery(api.issueRelations.hierarchy, {
    issueId: issue._id,
  });
  const members = useQuery(api.organizations.listMembers);
  const createIssue = useMutation(api.issues.create);

  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const childKind = childKindOf(issue.kind);
  const gated = isGatedStatus(issue.status);
  const subIssues = hierarchy?.subIssues ?? [];
  const doneCount = subIssues.filter((sub) => sub.status === "done").length;

  const addSubIssue = async () => {
    const trimmed = title.trim();
    if (!trimmed || submitting || !childKind || gated) {
      return;
    }
    setSubmitting(true);
    try {
      await createIssue({
        teamId: team._id,
        title: trimmed,
        kind: childKind,
        parentIssueId: issue._id,
      });
      setTitle("");
    } catch (error) {
      toast.error(
        errorMessage(error, "Failed to create sub-issue")
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="flex flex-col gap-1">
      <ParentRow issue={issue} team={team} />

      <div className="flex h-7 items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          Sub-issues
        </h3>
        {subIssues.length > 0 && (
          <span className="text-xs text-muted-foreground/70">
            {doneCount}/{subIssues.length} done
          </span>
        )}
        {childKind && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setAdding((value) => !value)}
            disabled={gated}
            aria-label="Add sub-issue"
            className="size-6 text-muted-foreground"
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>

      {subIssues.length > 0 && (
        <div className="flex flex-col">
          {subIssues.map((sub) => {
            const assignee = members?.find(
              (member) => member.userId === sub.assigneeId
            );
            return (
              <Link
                key={sub._id}
                href={`/${params.orgSlug}/issue/${sub._id}`}
                className="-mx-2 flex h-9 items-center gap-2.5 rounded-md px-2 text-sm transition-colors hover:bg-accent/50"
              >
                <StatusIcon status={sub.status} />
                {hasDisplayKey(sub.kind) && (
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {sub.identifier}
                  </span>
                )}
                <IssueKindBadge issue={sub} />
                <span className="min-w-0 flex-1 truncate">{sub.title}</span>
                {sub.priority !== "none" && (
                  <PriorityIcon priority={sub.priority} />
                )}
                {assignee && (
                  <UserAvatar
                    name={assignee.name}
                    imageUrl={assignee.imageUrl}
                  />
                )}
              </Link>
            );
          })}
        </div>
      )}

      {adding && childKind && !gated && (
        <div className="-mx-2 flex h-9 items-center gap-2 rounded-md border border-dashed px-2">
          <StatusIcon status="todo" className="opacity-50" />
          <Input
            autoFocus
            value={title}
            disabled={submitting}
            placeholder="Sub-issue title… (Enter to create)"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addSubIssue();
              }
              if (e.key === "Escape") {
                setAdding(false);
                setTitle("");
              }
            }}
            className="h-7 border-none px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
      )}
    </section>
  );
}
