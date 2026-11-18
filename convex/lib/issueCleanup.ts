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
 * What one admin run's cleanup may read of the rows its issues own. Convex fails a mutation whole, changing
 * nothing, past 4,096 queries, 16 MiB or 32,000 documents read, or 16,000 written; the rest is the caller's.
 * - `queries`: one per owned-table query. The caller makes about 110 more.
 * - `rows`: a run deletes at most `rows` owned rows and as many files, plus the caller's pages: under
 *   10,000 reads and writes.
 * - `bytes`: a row is read once and again by its delete, and a run stops on the row that passes the
 *   budget, at most 1 MiB read twice. So owned rows read at most 6 + 2 = 8 MiB; a budget of 8 MiB would read 10.
 */
export const CLEANUP_BUDGET: Readonly<Budget> = { rows: 4_000, bytes: 6 * 1024 * 1024, queries: 3_000 };

function spent(left: Budget) {
  return left.rows <= 0 || left.bytes <= 0 || left.queries <= 0;
}

/**
 * Reads the rows one issue owns, table by table, charging each query and row to `left`, and stops on the
 * row that spends any part of it. `finished` says every table was read whole.
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
        left.bytes -= 2 * getDocumentSize(row);
        if (spent(left)) {
          return { owned, finished: false };
        }
      }
    }
  }
  return { owned, finished: true };
}

/**
 * Deletes the rows `readOwnedRows` reads within `left`, each attachment with its file: `attachments.create`
 * refuses a file another row uses. `finished` says the issue owns nothing more.
 */
async function deleteOwnedRows(ctx: MutationCtx, issue: Doc<"issues">, left: Budget) {
  const { owned, finished } = await readOwnedRows(ctx, issue, left);
  for (const attachment of owned.attachments) {
    await ctx.storage.delete(attachment.storageId);
  }
  for (const rows of Object.values(owned)) {
    await deleteRows(ctx, rows);
  }
  return { counts: countTables(ISSUE_OWNED_TABLES, (table) => owned[table].length), finished };
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
