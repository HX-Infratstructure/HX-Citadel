"use client";

import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BacklogView } from "@/components/backlog/backlog-view";
import { LoadMoreButton } from "@/components/shared/load-more-button";
import { usePagedList } from "@/components/shared/use-paged-list";

const PAGE_SIZE = 100;

/** Team backlog: open stories with no cycle, in the owner's rank order, one page at a time. */
export default function TeamBacklogPage() {
  const params = useParams<{ orgSlug: string; teamId: string }>();
  const teamId = params.teamId as Id<"teams">;
  const team = useQuery(api.teams.get, { teamId });
  const { results: issues, firstPageLoading, paging } = usePagedList(
    api.issues.listBacklog,
    team ? { teamId } : "skip",
    PAGE_SIZE
  );

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
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 text-sm">
        <Link href={`/${params.orgSlug}/team/${teamId}`} className="font-medium">
          {team.name}
        </Link>
        <span className="text-muted-foreground">Backlog</span>
      </header>
      <ScrollArea className="flex-1">
        {issues.length === 0 && !paging.moreToLoad ? (
          <p className="py-32 text-center text-sm text-muted-foreground">
            The backlog is empty.
          </p>
        ) : (
          <BacklogView team={team} issues={issues} moreToLoad={paging.moreToLoad} />
        )}
        <LoadMoreButton paging={paging} className="mx-3 my-2" />
      </ScrollArea>
    </>
  );
}
