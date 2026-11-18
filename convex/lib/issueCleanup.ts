import { Doc, Id, TableNames } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { relationsOf } from "./issueRelations";
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
 * Rows written before `attachments.create` refused shared files can still share one,
 * so a file is deleted only with the last row that uses it. Each file's read is bounded:
 * a file attached since then has one row.
 */
export async function deleteAttachmentFiles(ctx: MutationCtx, attachments: Doc<"attachments">[]) {
  const leaving = new Set(attachments.map((attachment) => attachment._id));
  const files = new Set(attachments.map((attachment) => attachment.storageId));
  for (const storageId of files) {
    const users = await ctx.db
      .query("attachments")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .collect();
    if (users.every((row) => leaving.has(row._id))) {
      await ctx.storage.delete(storageId);
    }
  }
}

/**
 * Every table whose rows belong to one issue, and how to read up to `limit` of them: the one
 * list the deletes, the counts and the admin validators derive from. Rows are read in the
 * issue's own workspace, so a row from another workspace that points at it is left alone.
 * An issue's relations are one bounded read of at most twice `RELATION_LIMIT` rows, so they
 * are read whole whatever the limit.
 */
const ISSUE_OWNED_ROWS = {
  comments: (ctx: MutationCtx, issue: Doc<"issues">, limit: number) =>
    inOrg(ctx.db.query("comments").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId).take(limit),
  activity: (ctx: MutationCtx, issue: Doc<"issues">, limit: number) =>
    inOrg(ctx.db.query("activity").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId).take(limit),
  attachments: (ctx: MutationCtx, issue: Doc<"issues">, limit: number) =>
    inOrg(ctx.db.query("attachments").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId).take(limit),
  issueLabels: (ctx: MutationCtx, issue: Doc<"issues">, limit: number) =>
    ctx.db.query("issueLabels").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).take(limit),
  decisions: (ctx: MutationCtx, issue: Doc<"issues">, limit: number) =>
    inOrg(ctx.db.query("decisions").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId).take(limit),
  issueRelations: (ctx: MutationCtx, issue: Doc<"issues">) => relationsOf(ctx, issue._id),
};

type IssueOwnedTable = keyof typeof ISSUE_OWNED_ROWS;
type IssueOwnedRows = { [T in IssueOwnedTable]: Awaited<ReturnType<(typeof ISSUE_OWNED_ROWS)[T]>> };
export type IssueOwnedCounts = Record<IssueOwnedTable, number>;

export const ISSUE_OWNED_TABLES = Object.keys(ISSUE_OWNED_ROWS) as IssueOwnedTable[];

/**
 * Owned rows one admin run deletes. Convex fails a mutation whole, changing nothing, past 16,000
 * documents written or 32,000 read. A run writes at most 4,000 owned rows, 200 relations past the
 * budget on the issue it stops at, and a page each of issues, cycles and saved views (`PAGE_SIZE`
 * in admin.ts): about 4,500 writes. It reads each of those rows, counts each delete as a read
 * as well, and reads one more row per attachment for its file: under 14,000 reads.
 */
export const ROW_BUDGET = 4_000;

/**
 * Deletes up to `budget` of the rows one issue owns, table by table, and the files only they use.
 * `left` is the budget it did not use: above zero, every table was read whole, so the issue owns nothing.
 */
async function deleteOwnedRows(ctx: MutationCtx, issue: Doc<"issues">, budget: number) {
  const entries = [];
  let left = budget;
  for (const table of ISSUE_OWNED_TABLES) {
    const rows = left > 0 ? await ISSUE_OWNED_ROWS[table](ctx, issue, left) : [];
    entries.push([table, rows]);
    left -= rows.length;
  }
  const owned = Object.fromEntries(entries) as IssueOwnedRows;
  await deleteAttachmentFiles(ctx, owned.attachments);
  for (const rows of Object.values(owned)) {
    await deleteRows(ctx, rows);
  }
  return { counts: countTables(ISSUE_OWNED_TABLES, (table) => owned[table].length), left };
}

/**
 * Deletes every row that belongs to one issue, and its stored files, in the caller's one mutation.
 * The issue row is the caller's. `issues.remove` stays atomic: no UI or route deletes an issue that
 * owns more rows than one mutation can delete.
 */
export async function deleteIssueOwnedRows(ctx: MutationCtx, issue: Doc<"issues">) {
  let left: number;
  do {
    ({ left } = await deleteOwnedRows(ctx, issue, ROW_BUDGET));
  } while (left <= 0);
}

/**
 * Deletes the issues in order, each with the rows it owns, up to `ROW_BUDGET` owned rows in all.
 * The issue the budget runs out on loses a chunk of its rows and stays, with those after it, so
 * the next run starts there. One issue at a time, so a relation between two of them is read and
 * deleted once. `finished` says every issue went.
 */
export async function deleteIssuesWithOwnedRows(ctx: MutationCtx, issues: Doc<"issues">[]) {
  const perIssue: IssueOwnedCounts[] = [];
  let budget = ROW_BUDGET;
  let deleted = 0;
  for (const issue of issues) {
    const { counts, left } = await deleteOwnedRows(ctx, issue, budget);
    perIssue.push(counts);
    budget = left;
    if (budget <= 0) {
      break;
    }
    await ctx.db.delete(issue._id);
    deleted += 1;
  }
  const owned = countTables(ISSUE_OWNED_TABLES, (table) => perIssue.reduce((sum, counts) => sum + counts[table], 0));
  return { counts: { ...owned, issues: deleted }, finished: deleted === issues.length };
}
