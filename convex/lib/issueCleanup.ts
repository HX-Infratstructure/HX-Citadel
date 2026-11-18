import { Doc, Id, TableNames } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { inOrg } from "./orgRows";

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

/** The issue's rows in its own workspace; a row from another workspace that points at it is left alone. */
async function loadIssueOwnedRows(ctx: MutationCtx, issue: Doc<"issues">) {
  const issueId = issue._id;
  return {
    comments: await inOrg(ctx.db.query("comments").withIndex("by_issue", (q) => q.eq("issueId", issueId)), issue.orgId).collect(),
    activity: await inOrg(ctx.db.query("activity").withIndex("by_issue", (q) => q.eq("issueId", issueId)), issue.orgId).collect(),
    attachments: await inOrg(
      ctx.db.query("attachments").withIndex("by_issue", (q) => q.eq("issueId", issueId)),
      issue.orgId
    ).collect(),
    issueLabels: await ctx.db
      .query("issueLabels")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect(),
    decisions: await inOrg(ctx.db.query("decisions").withIndex("by_issue", (q) => q.eq("issueId", issueId)), issue.orgId).collect(),
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
export async function deleteIssueOwnedRows(ctx: MutationCtx, issue: Doc<"issues">): Promise<IssueOwnedCounts> {
  const owned = await loadIssueOwnedRows(ctx, issue);
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
    total = addCounts(total, await deleteIssueOwnedRows(ctx, issue));
  }
  await deleteRows(ctx, issues);
  return { ...total, issues: issues.length };
}
