"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { IssueKey, useIssueKeyText } from "@/components/issues/issue-key";
import { StatusIcon } from "@/components/shared/status-icon";

/**
 * "Add issues" picker shared by the project and cycle detail pages. The
 * actual assignment goes through `issues.update` (projectId/cycleId) in the
 * caller — this component only renders candidates and reports selections.
 * Stays open after a pick so several issues can be added in a row; the
 * candidate list shrinks reactively as issues are assigned.
 */
export function AddIssuesPopover({
  candidates,
  teamKeyFor,
  onAdd,
  emptyText = "No issues to add.",
}: {
  candidates: Doc<"issues">[] | undefined;
  teamKeyFor: (teamId: Id<"teams">) => string;
  onAdd: (issueId: Id<"issues">) => void;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="size-4" />
          Add issues
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <Command>
          <CommandInput placeholder="Add existing issues…" />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {candidates?.map((issue) => (
              <CandidateItem
                key={issue._id}
                issue={issue}
                teamKey={teamKeyFor(issue.teamId)}
                onAdd={onAdd}
              />
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CandidateItem({
  issue,
  teamKey,
  onAdd,
}: {
  issue: Doc<"issues">;
  teamKey: string;
  onAdd: (issueId: Id<"issues">) => void;
}) {
  const keyText = useIssueKeyText(teamKey, issue);
  return (
    <CommandItem value={`${keyText} ${issue.title}`} onSelect={() => onAdd(issue._id)}>
      <StatusIcon status={issue.status} />
      <IssueKey
        teamKey={teamKey}
        issue={issue}
        className="font-mono text-xs text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
    </CommandItem>
  );
}
