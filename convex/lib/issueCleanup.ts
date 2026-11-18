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
 * Rows written before `attachments.create` refused shared files can still share one,
 * so a file is deleted only with the last row that uses it.
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

/** Relations name the issue on either end, so both indexes are read. */
async function loadRelations(ctx: MutationCtx, issue: Doc<"issues">) {
  const outgoing = await ctx.db
    .query("issueRelations")
    .withIndex("by_issue", (q) => q.eq("issueId", issue._id))
    .collect();
  const incoming = await ctx.db
    .query("issueRelations")
    .withIndex("by_related", (q) => q.eq("relatedIssueId", issue._id))
    .collect();
  return [...outgoing, ...incoming];
}

/**
 * Every table whose rows belong to one issue, and how to find them: the one list the
 * deletes, the counts and the admin validators derive from. Rows are read in the issue's
 * own workspace, so a row from another workspace that points at it is left alone.
 */
const ISSUE_OWNED_ROWS = {
  comments: (ctx: MutationCtx, issue: Doc<"issues">) =>
    inOrg(ctx.db.query("comments").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId).collect(),
  activity: (ctx: MutationCtx, issue: Doc<"issues">) =>
    inOrg(ctx.db.query("activity").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId).collect(),
  attachments: (ctx: MutationCtx, issue: Doc<"issues">) =>
    inOrg(ctx.db.query("attachments").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId).collect(),
  issueLabels: (ctx: MutationCtx, issue: Doc<"issues">) =>
    ctx.db.query("issueLabels").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).collect(),
  decisions: (ctx: MutationCtx, issue: Doc<"issues">) =>
    inOrg(ctx.db.query("decisions").withIndex("by_issue", (q) => q.eq("issueId", issue._id)), issue.orgId).collect(),
  issueRelations: loadRelations,
};

type IssueOwnedTable = keyof typeof ISSUE_OWNED_ROWS;
type IssueOwnedRows = { [T in IssueOwnedTable]: Awaited<ReturnType<(typeof ISSUE_OWNED_ROWS)[T]>> };
export type IssueOwnedCounts = Record<IssueOwnedTable, number>;

export const ISSUE_OWNED_TABLES = Object.keys(ISSUE_OWNED_ROWS) as IssueOwnedTable[];

async function loadIssueOwnedRows(ctx: MutationCtx, issue: Doc<"issues">): Promise<IssueOwnedRows> {
  const entries = await Promise.all(
    ISSUE_OWNED_TABLES.map(async (table) => [table, await ISSUE_OWNED_ROWS[table](ctx, issue)])
  );
  return Object.fromEntries(entries) as IssueOwnedRows;
}

/** Deletes every row that belongs to one issue, and its stored files. The issue row is the caller's. */
export async function deleteIssueOwnedRows(ctx: MutationCtx, issue: Doc<"issues">): Promise<IssueOwnedCounts> {
  const owned = await loadIssueOwnedRows(ctx, issue);
  await deleteAttachmentFiles(ctx, owned.attachments);
  for (const rows of Object.values(owned)) {
    await deleteRows(ctx, rows);
  }
  return countTables(ISSUE_OWNED_TABLES, (table) => owned[table].length);
}

/**
 * Deletes the issues with the rows each owns. One issue at a time, so a
 * relation between two of them is read and deleted once.
 */
export async function deleteIssuesWithOwnedRows(ctx: MutationCtx, issues: Doc<"issues">[]) {
  const perIssue: IssueOwnedCounts[] = [];
  for (const issue of issues) {
    perIssue.push(await deleteIssueOwnedRows(ctx, issue));
  }
  await deleteRows(ctx, issues);
  const owned = countTables(ISSUE_OWNED_TABLES, (table) => perIssue.reduce((sum, counts) => sum + counts[table], 0));
  return { ...owned, issues: issues.length };
}
