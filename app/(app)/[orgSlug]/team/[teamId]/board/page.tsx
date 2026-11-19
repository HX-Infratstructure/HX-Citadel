"use client";

import { useQuery } from "convex/react";
import { Columns3, List, Loader2, Plus } from "lucide-react";
import Link from "next/link";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { Suspense, useMemo } from "react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { BacklogLink } from "@/components/backlog/backlog-link";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCommands } from "@/components/commands/command-provider";
import { BoardView } from "@/components/board/board-view";
import { CardAssignee, CardLabel } from "@/components/board/board-card";
import { LoadMoreButton } from "@/components/shared/load-more-button";
import { usePagedList } from "@/components/shared/use-paged-list";
import { FilterBar } from "@/components/views/filter-bar";
import { FilteredIssueList } from "@/components/views/filtered-issue-list";
import {
  countActiveFilters,
  DisplayMode,
  displayFromSearchParams,
  filtersFromSearchParams,
  IssueFilters,
  issueMatchesFilters,
  toQueryString,
} from "@/components/views/filters";
import { ViewSwitcher } from "@/components/views/view-switcher";

function CenteredSpinner() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Team board route (Track A): Kanban board + filtered list display with
 * URL-encoded filters and saved views. Lives alongside the foundation's
 * issues list at /team/[teamId].
 */
export default function TeamBoardPage() {
  return (
    <Suspense fallback={<CenteredSpinner />}>
      <TeamBoardContent />
    </Suspense>
  );
}

function TeamBoardContent() {
  const params = useParams<{ orgSlug: string; teamId: string }>();
  const teamId = params.teamId as Id<"teams">;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { openCreateIssue } = useCommands();

  const team = useQuery(api.teams.get, { teamId });
  const { results: issues, firstPageLoading, paging } = usePagedList(
    api.issues.listByTeam,
    team ? { teamId } : "skip"
  );
  const members = useQuery(api.organizations.listMembers);
  const orgLabels = useQuery(api.labels.list);

  const filters = useMemo(
    () => filtersFromSearchParams(searchParams),
    [searchParams]
  );
  const display = displayFromSearchParams(searchParams);

  const applyState = (nextFilters: IssueFilters, nextDisplay: DisplayMode) => {
    const query = toQueryString(nextFilters, nextDisplay);
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };

  const labelsById = useMemo(
    () =>
      new Map<Id<"labels">, CardLabel>(
        (orgLabels ?? []).map((label) => [label._id, { labelId: label._id, name: label.name, color: label.color }])
      ),
    [orgLabels]
  );

  const assigneesById = useMemo(() => {
    const map = new Map<string, CardAssignee>();
    for (const member of members ?? []) {
      map.set(member.userId, { name: member.name, imageUrl: member.imageUrl });
    }
    return map;
  }, [members]);

  // The lowest rank loaded and each loaded rank, over every status and before filtering: each issue not yet loaded
  // ranks below the floor.
  const floorRank = issues.reduce<number | undefined>(
    (floor, issue) => (floor === undefined || issue.sortOrder < floor ? issue.sortOrder : floor),
    undefined
  );
  const loadedRanks = new Map(issues.map((issue) => [issue._id, issue.sortOrder]));

  const filteredIssues = useMemo(
    () => issues.filter((issue) => issueMatchesFilters(issue, filters)),
    [issues, filters]
  );

  if (team === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Team not found.
      </div>
    );
  }

  if (team === undefined || firstPageLoading) {
    return <CenteredSpinner />;
  }

  return (
    <>
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Link
            href={`/${params.orgSlug}/team/${teamId}`}
            className="truncate font-medium text-muted-foreground hover:text-foreground"
          >
            {team.name}
          </Link>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium">
            {display === "board" ? "Board" : "List"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ViewSwitcher
            orgSlug={params.orgSlug}
            teamId={teamId}
            display={display}
            filters={filters}
          />
          <Tabs
            value={display}
            onValueChange={(value) =>
              applyState(filters, value as DisplayMode)
            }
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

      <div className="flex h-10 shrink-0 items-center border-b px-3">
        <FilterBar
          filters={filters}
          onFiltersChange={(next) => applyState(next, display)}
          members={members ?? []}
          labels={orgLabels ?? []}
        />
        {display === "board" ? (
          <LoadMoreButton paging={paging} className="ml-auto" />
        ) : null}
      </div>

      {display === "board" ? (
        <BoardView
          issues={filteredIssues}
          moreToLoad={paging.moreToLoad}
          floorRank={floorRank}
          loadedRanks={loadedRanks}
          teamId={teamId}
          teamKey={team.key}
          orgSlug={params.orgSlug}
          labelsById={labelsById}
          assigneesById={assigneesById}
        />
      ) : (
        <FilteredIssueList
          issues={filteredIssues}
          teamKey={team.key}
          hasActiveFilters={countActiveFilters(filters) > 0}
          paging={paging}
        />
      )}
    </>
  );
}
