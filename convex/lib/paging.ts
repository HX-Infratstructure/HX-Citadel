import { PaginationOptions } from "convex/server";

/** The most issues one list or page returns. */
export const LIST_LIMIT = 500;

/** Convex fails a query or mutation past this many documents read. */
export const CONVEX_DOCUMENT_READS = 32_000;

/** Rows and bytes one page may read, rows its filter drops included: well inside `CONVEX_DOCUMENT_READS` and 16 MiB. */
export const PAGE_READ_ROWS = 8_000;
const PAGE_READ_BYTES = 8 * 1024 * 1024;

/**
 * `paginationOpts` with the page held to at most `LIST_LIMIT` items and `PAGE_READ_ROWS` rows or `PAGE_READ_BYTES`
 * read, whatever the client asks for. A page that runs out of reads first comes back `SplitRequired`, holding every
 * match among the rows it read, and its `continueCursor` resumes after the last row read. A caller that follows
 * `continueCursor`, like the REST list, misses nothing; `usePaginatedQuery` replaces the page by its two halves at
 * `splitCursor`.
 */
export function capPage(paginationOpts: PaginationOptions): PaginationOptions {
  return {
    ...paginationOpts,
    numItems: Math.min(paginationOpts.numItems, LIST_LIMIT),
    maximumRowsRead: PAGE_READ_ROWS,
    maximumBytesRead: PAGE_READ_BYTES,
  };
}
