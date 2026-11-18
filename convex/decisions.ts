import { v } from "convex/values";
import { orgAdminMutation, orgQuery } from "./lib/customFunctions";
import { answerDecision, listedDecisionValidator, listIssueDecisions } from "./lib/decisions";

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
  args: { issueId: v.id("issues") },
  returns: v.array(listedDecisionValidator),
  handler: (ctx, { issueId }) => listIssueDecisions(ctx, ctx.org._id, issueId),
});
