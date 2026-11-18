import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { agentClerkId, ensureAgent, normalizeAgentName } from "./agents";
import { findMembership, findUserByClerkId, getOrgByClerkIdOrThrow } from "./mirror";

/** Who acts and in which workspace; the Clerk session and agent calls both resolve to it. */
export type OrgScope = { org: Doc<"organizations">; actorId: Id<"users"> };

/** The pinned HX workspace, from the server-side `HX_WORKSPACE_ORG_ID` (the Clerk org id). */
export async function resolveWorkspace(ctx: QueryCtx | MutationCtx): Promise<Doc<"organizations">> {
  const clerkOrgId = process.env.HX_WORKSPACE_ORG_ID;
  if (!clerkOrgId) {
    throw new Error("HX_WORKSPACE_ORG_ID is not configured");
  }
  return await getOrgByClerkIdOrThrow(ctx, clerkOrgId, "HX_WORKSPACE_ORG_ID matches no workspace");
}

/** A read names its agent too; the name is checked, but no row is written. */
export async function resolveAgentReadScope(
  ctx: QueryCtx,
  agentName: string
): Promise<Doc<"organizations">> {
  normalizeAgentName(agentName);
  return await resolveWorkspace(ctx);
}

/** A write creates the agent on its first call and reuses it after, inside the same mutation. */
export async function resolveAgentScope(ctx: MutationCtx, agentName: string): Promise<OrgScope> {
  const org = await resolveWorkspace(ctx);
  const actorId = await ensureAgent(ctx, org._id, agentName);
  return { org, actorId };
}

/** An assignee named in an agent call must already be an agent in the workspace; it is never created here. */
export async function resolveAgentAssignee(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  name: string
): Promise<Id<"users">> {
  const user = await findUserByClerkId(ctx, agentClerkId(name));
  if (!user || !(await findMembership(ctx, orgId, user._id))) {
    throw new Error(`Assignee ${name} not found`);
  }
  return user._id;
}
