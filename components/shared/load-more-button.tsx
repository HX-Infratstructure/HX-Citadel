"use client";

import { Button } from "@/components/ui/button";
import type { Paging } from "@/components/shared/use-paged-list";
import { cn } from "@/lib/utils";

/** The Load more button of a paginated list, shown only while more is to load. */
export function LoadMoreButton({ paging, className }: { paging: Paging; className?: string }) {
  if (!paging.moreToLoad) {
    return null;
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={paging.status === "LoadingMore"}
      onClick={paging.loadMore}
      className={cn("text-muted-foreground", className)}
    >
      Load more
    </Button>
  );
}
