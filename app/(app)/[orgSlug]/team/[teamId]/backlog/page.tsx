"use client";

import { usePaginatedQuery, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BacklogView } from "@/components/backlog/backlog-view";

const PAGE_SIZE = 100;

/** Team backlog: open stories with no cycle, in the owner's rank order, one page at a time. */
export default function TeamBacklogPage() {
  const params = useParams<{ orgSlug: string; teamId: string }>();
  const teamId = params.teamId as Id<"teams">;
  const team = useQuery(api.teams.get, { teamId });
  const { results: issues, status, loadMore } = usePaginatedQuery(
    api.issues.listBacklog,
    team ? { teamId } : "skip",
    { initialNumItems: PAGE_SIZE }
  );

  const moreToLoad = status === "CanLoadMore" || status === "LoadingMore";

  if (team === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Team not found.
      </div>
    );
  }

  if (team === undefined || status === "LoadingFirstPage") {
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
        {issues.length === 0 && !moreToLoad ? (
          <p className="py-32 text-center text-sm text-muted-foreground">
            The backlog is empty.
          </p>
        ) : (
          <BacklogView team={team} issues={issues} moreToLoad={moreToLoad} />
        )}
        {moreToLoad && (
          <Button
            variant="ghost"
            size="xs"
            disabled={status === "LoadingMore"}
            onClick={() => loadMore(PAGE_SIZE)}
            className="mx-3 my-2 text-muted-foreground"
          >
            Load more
          </Button>
        )}
      </ScrollArea>
    </>
  );
}
