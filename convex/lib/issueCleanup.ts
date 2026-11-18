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
    issueRelations: await loadRelations(ctx, issueId),
  };
}

/** Deletes every row that belongs to one issue, and its stored files. The issue row is the caller's. */
export async function deleteIssueOwnedRows(ctx: MutationCtx, issueId: Id<"issues">): Promise<void> {
  const owned = await loadIssueOwnedRows(ctx, issueId);
  await deleteAttachmentFiles(ctx, owned.attachments);
  for (const rows of Object.values(owned)) {
    await deleteRows(ctx, rows);
  }
}
