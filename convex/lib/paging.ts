import { PaginationOptions } from "convex/server";
import { LIST_LIMIT } from "../../lib/api-contract";

/**
 * Rows and bytes one page may read, rows its filter drops included: well inside `TRANSACTION_LIMITS`' `documentsRead`
 * and `bytesRead`.
 */
export const PAGE_READ_ROWS = 8_000;
const PAGE_READ_BYTES = 8 * 1024 * 1024;

/**
 * `paginationOpts` with the page held to at most `LIST_LIMIT` items and `PAGE_READ_ROWS` rows or `PAGE_READ_BYTES`
 * read, whatever the client asks for. A page that runs out of reads first comes back `SplitRequired`, holding every
 * match among the rows it read, and its `continueCursor` resumes after the last row read. A caller that follows
 * `continueCursor`, like the REST list, misses nothing; `usePaginatedQuery` replaces the page by its two halves at
 * `splitCursor`. A page pinned by an end cursor ignores `numItems` and `maximumRowsRead` (see `PINNED_PAGE_MAX_ROWS`).
 */
export function capPage(paginationOpts: PaginationOptions): PaginationOptions {
  return {
    ...paginationOpts,
    numItems: Math.min(paginationOpts.numItems, LIST_LIMIT),
    maximumRowsRead: PAGE_READ_ROWS,
    maximumBytesRead: PAGE_READ_BYTES,
  };
}
