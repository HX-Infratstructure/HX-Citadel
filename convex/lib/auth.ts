import { Doc } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import {
  findUserByClerkId,
  getMembershipOrThrow,
  getOrgByClerkIdOrThrow,
  getUserByClerkIdOrThrow,
} from "./mirror";

/** Custom claims we add via the Clerk "convex" JWT template. */
type OrgClaims = {
  org_id?: string;
  org_slug?: string;
  org_role?: string;
};

export type AuthContext = {
  user: Doc<"users">;
  org: Doc<"organizations">;
  membership: Doc<"members">;
};

/**
 * Resolve the signed-in user from the Clerk JWT. Returns null while the
 * Clerk → Convex webhook sync hasn't landed yet (caller decides how to wait).
 */
export async function getCurrentUserOrNull(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }
  return await findUserByClerkId(ctx, identity.subject);
}

export async function getCurrentUser(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Not authenticated");
  }
  return await getUserByClerkIdOrThrow(ctx, identity.subject, "User not synced yet");
}

/**
 * Resolve the full auth context: user + active organization + membership.
 * The active org comes from the `org_id` claim in the Clerk JWT and is
 * verified against the synced members table — never trust the client.
 */
export async function getAuthContext(
  ctx: QueryCtx | MutationCtx
): Promise<AuthContext> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Not authenticated");
  }

  const user = await getUserByClerkIdOrThrow(ctx, identity.subject, "User not synced yet");

  const claims = identity as unknown as OrgClaims;
  if (!claims.org_id) {
    throw new Error("No active organization");
  }

  const org = await getOrgByClerkIdOrThrow(ctx, claims.org_id, "Organization not synced yet");
  const membership = await getMembershipOrThrow(
    ctx,
    org._id,
    user._id,
    "Not a member of this organization"
  );

  return { user, org, membership };
}
