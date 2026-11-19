"use client";

import { Doc } from "@/convex/_generated/dataModel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IssueRow } from "@/components/issues/issue-row";
import { STATUSES } from "@/components/shared/issue-meta";
import { LoadMoreButton } from "@/components/shared/load-more-button";
import { StatusIcon } from "@/components/shared/status-icon";
import { emptyListText, loadedCount, Paging } from "@/components/shared/use-paged-list";
import { byRank } from "@/lib/sort-order";

/**
 * A team's loaded issues grouped by status, pre-filtered by the caller, with Load more at the bottom. The team page
 * and the board route's list display render it.
 */
export function FilteredIssueList({
  issues,
  teamKey,
  hasActiveFilters,
  paging,
}: {
  issues: Doc<"issues">[];
  teamKey: string;
  hasActiveFilters: boolean;
  paging: Paging;
}) {
  const grouped = STATUSES.map((status) => ({
    status,
    issues: issues
      .filter((issue) => issue.status === status.value)
      .sort(byRank),
  })).filter((group) => group.issues.length > 0);
  const loadMore = <LoadMoreButton paging={paging} className="mx-3 my-2" />;

  if (issues.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
        {emptyListText(hasActiveFilters, paging.moreToLoad)}
        {loadMore}
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      {grouped.map(({ status, issues: groupIssues }) => (
        <section key={status.value}>
          <div className="flex h-9 items-center gap-2 bg-muted/50 px-4 text-sm">
            <StatusIcon status={status.value} />
            <span className="font-medium">{status.label}</span>
            <span className="text-xs text-muted-foreground">
              {loadedCount(groupIssues.length, paging.moreToLoad)}
            </span>
          </div>
          {groupIssues.map((issue) => (
            <IssueRow key={issue._id} issue={issue} teamKey={teamKey} />
          ))}
        </section>
      ))}
      {loadMore}
    </ScrollArea>
  );
}
