import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { ATTACHMENT_TOO_LARGE, MAX_ATTACHMENT_BYTES } from "../lib/api-contract";
import { invalid, refuse } from "./lib/refusals";
import { getOrgIssue, LIST_LIMIT } from "./issues";
import { logActivity } from "./lib/activity";
import { deleteAttachmentFiles } from "./lib/issueCleanup";
import { orgMutation, orgQuery } from "./lib/customFunctions";
import { inOrg, requireOrgRow } from "./lib/orgRows";

const attachmentValidator = v.object({
  _id: v.id("attachments"),
  _creationTime: v.number(),
  issueId: v.id("issues"),
  fileName: v.string(),
  fileType: v.string(),
  fileSize: v.number(),
  uploadedBy: v.id("users"),
  uploaderName: v.string(),
  /** Short-lived download URL from Convex storage (null if file is gone). */
  url: v.union(v.string(), v.null()),
});

/** Step 1 of an upload: mint a short-lived URL the client POSTs the file to. */
export const generateUploadUrl = orgMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

/** Step 2 of an upload: link the stored file to an issue. */
export const create = orgMutation({
  args: {
    issueId: v.id("issues"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    fileType: v.string(),
    fileSize: v.number(),
  },
  returns: v.id("attachments"),
  handler: async (ctx, args) => {
    const issue = await getOrgIssue(ctx, ctx.org._id, args.issueId);

    if (args.fileSize > MAX_ATTACHMENT_BYTES) {
      invalid(ATTACHMENT_TOO_LARGE);
    }

    // Every workspace's rows, on purpose: linking a file another workspace attached would hand us its download URL.
    const existing = await ctx.db
      .query("attachments")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .first();
    if (existing) {
      refuse("This file is already attached");
    }

    const fileName = args.fileName.trim() || "Untitled";
    const attachmentId = await ctx.db.insert("attachments", {
      orgId: ctx.org._id,
      issueId: issue._id,
      storageId: args.storageId,
      fileName,
      fileType: args.fileType,
      fileSize: args.fileSize,
      uploadedBy: ctx.user._id,
    });

    await logActivity(ctx, {
      orgId: ctx.org._id,
      issueId: issue._id,
      actorId: ctx.user._id,
      type: "attachment_added",
      field: "attachment",
      newValue: fileName,
    });

    return attachmentId;
  },
});

/** Newest first. The client picks the page size; the cap keeps one page a bounded read. */
export const listByIssue = orgQuery({
  args: { issueId: v.id("issues"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(attachmentValidator),
  handler: async (ctx, args) => {
    await getOrgIssue(ctx, ctx.org._id, args.issueId);

    const result = await inOrg(
      ctx.db.query("attachments").withIndex("by_issue", (q) => q.eq("issueId", args.issueId)).order("desc"),
      ctx.org._id
    ).paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, LIST_LIMIT) });

    const page = [];
    for (const attachment of result.page) {
      const uploader = await ctx.db.get(attachment.uploadedBy);
      page.push({
        _id: attachment._id,
        _creationTime: attachment._creationTime,
        issueId: attachment.issueId,
        fileName: attachment.fileName,
        fileType: attachment.fileType,
        fileSize: attachment.fileSize,
        uploadedBy: attachment.uploadedBy,
        uploaderName: uploader?.name ?? "Unknown user",
        url: await ctx.storage.getUrl(attachment.storageId),
      });
    }
    return { ...result, page };
  },
});

export const remove = orgMutation({
  args: { attachmentId: v.id("attachments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attachment = await requireOrgRow(ctx, ctx.org._id, args.attachmentId, "Attachment");
    const isUploader = attachment.uploadedBy === ctx.user._id;
    const isAdmin = ctx.membership.role === "admin";
    if (!isUploader && !isAdmin) {
      refuse("Only the uploader or an admin can delete an attachment");
    }

    await deleteAttachmentFiles(ctx, [attachment]);
    await ctx.db.delete(attachment._id);

    await logActivity(ctx, {
      orgId: ctx.org._id,
      issueId: attachment.issueId,
      actorId: ctx.user._id,
      type: "attachment_removed",
      field: "attachment",
      oldValue: attachment.fileName,
    });
    return null;
  },
});
