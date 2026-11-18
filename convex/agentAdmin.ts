import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { removeAgentMembership } from "./lib/agents";
import { getOrgByClerkIdOrThrow } from "./lib/mirror";

/** Operator-only, run with `npx convex run agentAdmin:removeAgent`: takes a mistyped or retired agent out of the workspace. */
export const removeAgent = internalMutation({
  args: { clerkOrgId: v.string(), agentName: v.string() },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, { clerkOrgId, agentName }) => {
    const org = await getOrgByClerkIdOrThrow(ctx, clerkOrgId, `Organization ${clerkOrgId} not found`);
    return { removed: await removeAgentMembership(ctx, org._id, agentName) };
  },
});
