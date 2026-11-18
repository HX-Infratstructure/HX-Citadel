import { getDocumentSize } from "convex/values";
import { Doc, Id, TableNames } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { inOrg } from "./orgRows";

export async function deleteRows(ctx: MutationCtx, rows: { _id: Id<TableNames> }[]) {
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

/** One count per table. */
export function countTables<T extends string>(tables: readonly T[], count: (table: T) => number) {
  return Object.fromEntries(tables.map((table) => [table, count(table)])) as Record<T, number>;
}

/**
 * Rows written before `attachments.create` refused shared files can still share one, so a file is deleted
 * only with the last row that uses it. Looks up the files in turn, each within `left`, and returns the rows
 * whose files it looked up; the rest keep their files for a later run. The first file is always looked up,
 * so a run whose rows spent `left` still deletes one.
 */
export async function deleteAttachmentFiles(
  ctx: MutationCtx,
  attachments: Doc<"attachments">[],
  left: Budget = { ...CLEANUP_BUDGET }
) {
  const leaving = new Set(attachments.map((attachment) => attachment._id));
  const checked = new Set<Id<"_storage">>();
  for (const storageId of new Set(attachments.map((attachment) => attachment.storageId))) {
    if (checked.size > 0 && spent(left)) {
      break;
    }
    checked.add(storageId);
    if (!(await usedByAnotherRow(ctx, storageId, leaving, left))) {
      await ctx.storage.delete(storageId);
    }
  }
  return attachments.filter((attachment) => checked.has(attachment.storageId));
}

/**
 * Whether a row outside `leaving` uses the file, reading its rows in order up to the first that stays.
 * Charges `left` its query, each row and the bytes of that first row: `readOwnedRows` charged the bytes of
 * the leaving rows when it read them.
 */
async function usedByAnotherRow(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
  leaving: Set<Id<"attachments">>,
  left: Budget
) {
  left.queries -= 1;
  for await (const row of ctx.db.query("attachments").withIndex("by_storage", (q) => q.eq("storageId", storageId))) {
    left.rows -= 1;
    if (!leaving.has(row._id)) {
      left.bytes -= getDocumentSize(row);
      return true;
    }
  }
  return false;
}

/**
 * Every table whose rows belong to one issue, and the queries that read them: the one list the deletes,
 * the counts and the admin validators derive from. Rows are read in the issue's own workspace, so a row
 * from another workspace that points at it is left alone.
 */
const ISSUE_OWNED_ROWS = {
  comments: (ctx: MutationCtx, issue: Doc<"issues">) => [
    inOrg(ctx.db.query("comments").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId),
  ],
  activity: (ctx: MutationCtx, issue: Doc<"issues">) => [
    inOrg(ctx.db.query("activity").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId),
  ],
  attachments: (ctx: MutationCtx, issue: Doc<"issues">) => [
    inOrg(ctx.db.query("attachments").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId),
  ],
  issueLabels: (ctx: MutationCtx, issue: Doc<"issues">) => [
    ctx.db.query("issueLabels").withIndex("by_issue", (q) => q.eq("issueId", issue._id)),
  ],
  decisions: (ctx: MutationCtx, issue: Doc<"issues">) => [
    inOrg(ctx.db.query("decisions").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId),
  ],
  issueRelations: (ctx: MutationCtx, issue: Doc<"issues">) => [
    ctx.db.query("issueRelations").withIndex("by_issue", (q) => q.eq("issueId", issue._id)),
    ctx.db.query("issueRelations").withIndex("by_related", (q) => q.eq("relatedIssueId", issue._id)),
  ],
};

type IssueOwnedTable = keyof typeof ISSUE_OWNED_ROWS;
type IssueOwnedRows = { [T in IssueOwnedTable]: Doc<T>[] };
export type IssueOwnedCounts = Record<IssueOwnedTable, number>;

export const ISSUE_OWNED_TABLES = Object.keys(ISSUE_OWNED_ROWS) as IssueOwnedTable[];

type Budget = { rows: number; bytes: number; queries: number };

/**
 * What one admin run's cleanup may read. Convex fails a mutation whole, changing nothing, past 4,096
 * queries, 16 MiB or 32,000 documents read, or 16,000 written; the rest is the caller's.
 * - `queries`: each owned-table query, and each file's `by_storage` lookup. The caller makes about 110
 *   more: its page queries, a cycle query per team on a page and six org-only tables.
 * - `bytes`: a row is read once and again by its delete, and an attachment once more by its file's
 *   lookup. A lookup also reads the first row that stays, up to one document (1 MiB), and charges it
 *   then. A run stops on the read that passes the budget, and an issue's first file is looked up even
 *   past it, so a run reads at most four documents (4 MiB) more. The caller's pages hold the rest.
 * - `rows`: a run writes at most `rows` owned rows and a page each of issues, cycles, saved views and
 *   org-only rows, well under 16,000 writes. It reads those, its file lookups' rows, which count in
 *   `rows`, and the caller's pages: under 20,000 reads.
 */
export const CLEANUP_BUDGET: Readonly<Budget> = { rows: 4_000, bytes: 6 * 1024 * 1024, queries: 3_000 };

function spent(left: Budget) {
  return left.rows <= 0 || left.bytes <= 0 || left.queries <= 0;
}

/**
 * Reads the rows one issue owns, table by table, charging each query and row to `left`, and stops on the
 * row that spends any part of it. An attachment is charged a third read, for its file's lookup reading it
 * again. `finished` says every table was read whole.
 */
async function readOwnedRows(ctx: MutationCtx, issue: Doc<"issues">, left: Budget) {
  const owned = Object.fromEntries(ISSUE_OWNED_TABLES.map((table) => [table, [] as Doc<IssueOwnedTable>[]])) as IssueOwnedRows;
  for (const table of ISSUE_OWNED_TABLES) {
    const rows: Doc<IssueOwnedTable>[] = owned[table];
    for (const query of ISSUE_OWNED_ROWS[table](ctx, issue)) {
      if (spent(left)) {
        return { owned, finished: false };
      }
      left.queries -= 1;
      for await (const row of query) {
        rows.push(row);
        left.rows -= 1;
        left.bytes -= (table === "attachments" ? 3 : 2) * getDocumentSize(row);
        if (spent(left)) {
          return { owned, finished: false };
        }
      }
    }
  }
  return { owned, finished: true };
}

/**
 * Deletes the rows `readOwnedRows` reads within `left`, and the files only they use, but no attachment
 * whose file `left` had no room to look up. `finished` says the issue owns nothing more.
 */
async function deleteOwnedRows(ctx: MutationCtx, issue: Doc<"issues">, left: Budget) {
  const { owned, finished } = await readOwnedRows(ctx, issue, left);
  const attachments = await deleteAttachmentFiles(ctx, owned.attachments, left);
  const deleting = { ...owned, attachments };
  for (const rows of Object.values(deleting)) {
    await deleteRows(ctx, rows);
  }
  return {
    counts: countTables(ISSUE_OWNED_TABLES, (table) => deleting[table].length),
    finished: finished && attachments.length === owned.attachments.length,
  };
}

/**
 * Deletes the issues in order, each with the rows it owns, within one `CLEANUP_BUDGET`. The issue it
 * runs out on loses the rows it read and stays, with those after it, so the next run starts there and
 * reads on from its first row left. One issue at a time, so a relation between two of them is read and
 * deleted once. `finished` says every issue went.
 */
export async function deleteIssuesWithOwnedRows(ctx: MutationCtx, issues: Doc<"issues">[]) {
  const perIssue: IssueOwnedCounts[] = [];
  const left = { ...CLEANUP_BUDGET };
  let deleted = 0;
  for (const issue of issues) {
    const { counts, finished } = await deleteOwnedRows(ctx, issue, left);
    perIssue.push(counts);
    if (!finished) {
      break;
    }
    await ctx.db.delete(issue._id);
    deleted += 1;
  }
  const owned = countTables(ISSUE_OWNED_TABLES, (table) => perIssue.reduce((sum, counts) => sum + counts[table], 0));
  return { counts: { ...owned, issues: deleted }, finished: deleted === issues.length };
}
