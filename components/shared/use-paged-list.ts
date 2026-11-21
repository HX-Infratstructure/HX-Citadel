import type { PaginationStatus } from "convex/browser";
import { type PaginatedQueryArgs, type PaginatedQueryReference, usePaginatedQuery } from "convex/react";
import { LIST_LIMIT } from "@/lib/api-contract";

/** Rows per page of a team's issue list. */
const PAGE_SIZE = LIST_LIMIT;

/** A paginated list's paging state, as `LoadMoreButton` and the list views read it. */
export type Paging = { status: PaginationStatus; moreToLoad: boolean; loadMore: () => void };

/**
 * `usePaginatedQuery` with one page size. `firstPageLoading` also holds while the first page loads again as two
 * halves: the query hook drops a `SplitRequired` page and reports `LoadingMore` with no rows until the halves arrive.
 */
export function usePagedList<Query extends PaginatedQueryReference>(
  query: Query,
  args: PaginatedQueryArgs<Query> | "skip",
  pageSize = PAGE_SIZE
) {
  const { results, status, loadMore } = usePaginatedQuery(query, args, { initialNumItems: pageSize });
  const paging: Paging = {
    status,
    moreToLoad: status === "CanLoadMore" || status === "LoadingMore",
    loadMore: () => loadMore(pageSize),
  };
  const firstPageLoading = status === "LoadingFirstPage" || (status === "LoadingMore" && results.length === 0);
  return { results, firstPageLoading, paging };
}

/** A count of loaded rows, marked as a lower bound while more is to load. */
export function loadedCount(count: number, moreToLoad: boolean): string {
  return moreToLoad ? `${count}+` : `${count}`;
}

/** The empty-list text, which says when only the loaded issues were searched. */
export function emptyListText(hasActiveFilters: boolean, moreToLoad: boolean): string {
  if (moreToLoad) {
    return "No matches in the loaded issues.";
  }
  return hasActiveFilters ? "No issues match the current filters." : "No issues yet. Press C to create one.";
}
