"use client";

import { useQuery } from "convex/react";
import { Columns3, List, Loader2, Plus } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { BacklogLink } from "@/components/backlog/backlog-link";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCommands } from "@/components/commands/command-provider";
import { usePagedList } from "@/components/shared/use-paged-list";
import { FilteredIssueList } from "@/components/views/filtered-issue-list";

/**
 * Team issues list — the foundation vertical slice. Track A adds the board
 * view, filtering, and saved views on top of this route's sibling pages.
 */
export default function TeamIssuesPage() {
  const params = useParams<{ orgSlug: string; teamId: string }>();
  const router = useRouter();
  const teamId = params.teamId as Id<"teams">;
  const team = useQuery(api.teams.get, { teamId });
  const { results: issues, firstPageLoading, paging } = usePagedList(
    api.issues.listByTeam,
    team ? { teamId } : "skip"
  );
  const { openCreateIssue } = useCommands();

  if (team === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Team not found.
      </div>
    );
  }

  if (team === undefined || firstPageLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{team.name}</span>
          <span className="text-muted-foreground">Issues</span>
        </div>
        <div className="flex items-center gap-2">
          <Tabs
            value="list"
            onValueChange={(value) => {
              if (value === "board") {
                router.push(`/${params.orgSlug}/team/${teamId}/board`);
              }
            }}
          >
            <TabsList className="h-7">
              <TabsTrigger value="board" className="h-6 gap-1 px-2 text-xs">
                <Columns3 className="size-3.5" />
                Board
              </TabsTrigger>
              <TabsTrigger value="list" className="h-6 gap-1 px-2 text-xs">
                <List className="size-3.5" />
                List
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <BacklogLink orgSlug={params.orgSlug} teamId={teamId} />
          <Button size="sm" variant="outline" onClick={openCreateIssue}>
            <Plus className="size-4" />
            New issue
          </Button>
        </div>
      </header>
      <FilteredIssueList issues={issues} teamKey={team.key} hasActiveFilters={false} paging={paging} />
    </>
  );
}
