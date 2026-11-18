import { Doc, Id, TableNames } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

export async function deleteRows(ctx: MutationCtx, rows: { _id: Id<TableNames> }[]) {
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
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
async function loadRelations(ctx: MutationCtx, issueId: Id<"issues">) {
  const outgoing = await ctx.db
    .query("issueRelations")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  const incoming = await ctx.db
    .query("issueRelations")
    .withIndex("by_related", (q) => q.eq("relatedIssueId", issueId))
    .collect();
  return [...outgoing, ...incoming];
}

async function loadIssueOwnedRows(ctx: MutationCtx, issueId: Id<"issues">) {
  return {
    comments: await ctx.db
      .query("comments")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect(),
    activity: await ctx.db
      .query("activity")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect(),
    attachments: await ctx.db
      .query("attachments")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect(),
    issueLabels: await ctx.db
      .query("issueLabels")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect(),
    decisions: await ctx.db
      .query("decisions")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect(),
    issueRelations: await loadRelations(ctx, issueId),
  };
}

type IssueOwnedRows = Awaited<ReturnType<typeof loadIssueOwnedRows>>;
type IssueOwnedTable = keyof IssueOwnedRows;
export type IssueOwnedCounts = Record<IssueOwnedTable, number>;

const NO_OWNED_ROWS: IssueOwnedCounts = {
  comments: 0,
  activity: 0,
  attachments: 0,
  issueLabels: 0,
  decisions: 0,
  issueRelations: 0,
};
const ISSUE_OWNED_TABLES = Object.keys(NO_OWNED_ROWS) as IssueOwnedTable[];

function countRows(owned: IssueOwnedRows): IssueOwnedCounts {
  const entries = ISSUE_OWNED_TABLES.map((table) => [table, owned[table].length]);
  return Object.fromEntries(entries) as IssueOwnedCounts;
}

function addCounts(total: IssueOwnedCounts, counts: IssueOwnedCounts): IssueOwnedCounts {
  const entries = ISSUE_OWNED_TABLES.map((table) => [table, total[table] + counts[table]]);
  return Object.fromEntries(entries) as IssueOwnedCounts;
}

/** Deletes every row that belongs to one issue, and its stored files. The issue row is the caller's. */
export async function deleteIssueOwnedRows(ctx: MutationCtx, issueId: Id<"issues">): Promise<IssueOwnedCounts> {
  const owned = await loadIssueOwnedRows(ctx, issueId);
  await deleteAttachmentFiles(ctx, owned.attachments);
  for (const rows of Object.values(owned)) {
    await deleteRows(ctx, rows);
  }
  return countRows(owned);
}

/**
 * Deletes the issues with the rows each owns. One issue at a time, so a
 * relation between two of them is read and deleted once.
 */
export async function deleteIssuesWithOwnedRows(ctx: MutationCtx, issues: Doc<"issues">[]) {
  let total = NO_OWNED_ROWS;
  for (const issue of issues) {
    total = addCounts(total, await deleteIssueOwnedRows(ctx, issue._id));
  }
  await deleteRows(ctx, issues);
  return { ...total, issues: issues.length };
}
