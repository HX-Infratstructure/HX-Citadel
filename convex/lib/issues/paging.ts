import { PaginationOptions } from "convex/server";
import { MAX_LABELS_PER_ISSUE } from "../../../lib/api-contract";

/** The most issues one list or page returns. */
export const LIST_LIMIT = 500;

/** Convex fails a query or mutation past this many documents read. */
const CONVEX_DOCUMENT_READS = 32_000;

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

/** The documents every `listByTeam` call reads before its page: the caller's user, workspace and membership, and the team (4), rounded up. */
const PAGE_FIXED_READS = 8;

/**
 * The most rows a `listByTeam` page pinned by an end cursor can hold and still read inside `CONVEX_DOCUMENT_READS`.
 * Such a page reads its whole interval, ignoring `numItems` and `maximumRowsRead` (convex-backend
 * `crates/database/src/query/index_range.rs:168-170`), and `usePaginatedQuery` splits it only above 2 ×
 * `initialNumItems` rows, after a read that returned them, so it grows past 2 × LIST_LIMIT rows before a split; a test
 * in `issues.test.ts` holds this bound at 2 × LIST_LIMIT or more. It reads PAGE_FIXED_READS, at most
 * PAGE_READ_ROWS rows its filter drops, and for each row the row itself and its label links (at most
 * `MAX_LABELS_PER_ISSUE`, enforced when a label is added). A page of 2 × LIST_LIMIT rows then has
 * `PINNED_PAGE_MAX_ROWS - 2 * LIST_LIMIT` rows of headroom. Its index ranges, 1 + rows besides the fixed reads, stay
 * inside Convex's 4,096.
 */
export const PINNED_PAGE_MAX_ROWS = Math.floor(
  (CONVEX_DOCUMENT_READS - PAGE_FIXED_READS - PAGE_READ_ROWS) / (MAX_LABELS_PER_ISSUE + 1)
);
