import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { orgAdminMutation, orgMutation, orgQuery } from "./lib/customFunctions";
import { createArgs, createIssue } from "./lib/issues/create";
import { setIssueProof } from "./lib/issues/proof";
import { backlogPage, parentCandidates, storyByNumber, teamPage } from "./lib/issues/queries";
import { revertActivity } from "./lib/issues/revert";
import { issueShape } from "./lib/issues/shape";
import { updateArgs, updateIssue } from "./lib/issues/update";
import { orgRow } from "./lib/orgRows";
import { issueKindValidator } from "./schema";

/** Documented by `backlogPage` in `convex/lib/issues/queries.ts`. */
export const listBacklog = orgQuery({
  args: { teamId: v.id("teams"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object(issueShape)),
  handler: async (ctx, args) => await backlogPage(ctx, args),
});

/** Documented by `teamPage` in `convex/lib/issues/queries.ts`. */
export const listByTeam = orgQuery({
  args: { teamId: v.id("teams"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ ...issueShape, labelIds: v.array(v.id("labels")) })),
  handler: async (ctx, args) => await teamPage(ctx, args),
});

/** Documented by `parentCandidates` in `convex/lib/issues/queries.ts`. */
export const listParentCandidates = orgQuery({
  args: { teamId: v.id("teams"), kind: issueKindValidator },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => await parentCandidates(ctx, args),
});

export const get = orgQuery({
  args: { issueId: v.id("issues") },
  returns: v.union(v.object(issueShape), v.null()),
  handler: async (ctx, args) => await orgRow(ctx, ctx.org._id, args.issueId),
});

/** Documented by `storyByNumber` in `convex/lib/issues/queries.ts`. */
export const getByNumber = orgQuery({
  args: { teamId: v.id("teams"), number: v.number() },
  returns: v.union(v.object(issueShape), v.null()),
  handler: async (ctx, args) => await storyByNumber(ctx, args),
});

export const create = orgMutation({
  args: createArgs,
  returns: v.id("issues"),
  handler: async (ctx, args) =>
    await createIssue(ctx, { org: ctx.org, actorId: ctx.user._id }, args),
});

export const update = orgMutation({
  args: updateArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await updateIssue(ctx, { org: ctx.org, actorId: ctx.user._id }, args);
    return null;
  },
});

/** Documented by `revertActivity` in `convex/lib/issues/revert.ts`. */
export const revertChange = orgAdminMutation({
  args: { activityId: v.id("activity") },
  returns: v.null(),
  handler: async (ctx, { activityId }) => {
    await revertActivity(ctx, { org: ctx.org, actorId: ctx.user._id }, activityId);
    return null;
  },
});

export const setProof = orgMutation({
  args: { issueId: v.id("issues"), proofUrl: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await setIssueProof(ctx, { org: ctx.org, actorId: ctx.user._id }, args);
    return null;
  },
});
