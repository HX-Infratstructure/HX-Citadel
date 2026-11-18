import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { orgAdminMutation, orgQuery } from "./lib/customFunctions";
import { answerDecision, listedDecisionValidator, pageIssueDecisions } from "./lib/decisions";

/** The owner's admins answer on the story; no REST route or MCP tool answers, so agents never answer their own. */
export const answer = orgAdminMutation({
  args: { decisionId: v.id("decisions"), choice: v.optional(v.string()), text: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await answerDecision(ctx, { org: ctx.org, actorId: ctx.user._id }, args, "story");
    return null;
  },
});

export const listForIssue = orgQuery({
  args: { issueId: v.id("issues"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(listedDecisionValidator),
  handler: (ctx, { issueId, paginationOpts }) => pageIssueDecisions(ctx, ctx.org._id, issueId, paginationOpts),
});
