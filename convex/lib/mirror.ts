import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { notFound } from "./refusals";

type Ctx = QueryCtx | MutationCtx;

export async function findUserByClerkId(
  ctx: Ctx,
  clerkUserId: string
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkUserId))
    .unique();
}

export async function findOrgByClerkId(
  ctx: Ctx,
  clerkOrgId: string
): Promise<Doc<"organizations"> | null> {
  return await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
}

export async function findMembership(
  ctx: Ctx,
  orgId: Id<"organizations">,
  userId: Id<"users">
): Promise<Doc<"members"> | null> {
  return await ctx.db
    .query("members")
    .withIndex("by_org_and_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
    .unique();
}

/**
 * Reconcile deletes only rows that already existed when it started reading
 * Clerk; a row created after that read (syncCurrent on an accepted
 * invitation) is missing from the directory without being gone from Clerk.
 */
export function existedBeforeRead(
  doc: { _creationTime: number },
  readStartedAt: number | undefined
) {
  return readStartedAt === undefined || doc._creationTime < readStartedAt;
}

export function isStaleClerkWrite(stored: number | undefined, incoming: number | undefined) {
  return stored !== undefined && incoming !== undefined && incoming < stored;
}

export async function getUserByClerkIdOrThrow(
  ctx: Ctx,
  clerkUserId: string,
  message: string
): Promise<Doc<"users">> {
  const user = await findUserByClerkId(ctx, clerkUserId);
  if (!user) {
    notFound(message);
  }
  return user;
}

export async function getOrgByClerkIdOrThrow(
  ctx: Ctx,
  clerkOrgId: string,
  message: string
): Promise<Doc<"organizations">> {
  const org = await findOrgByClerkId(ctx, clerkOrgId);
  if (!org) {
    notFound(message);
  }
  return org;
}

export async function getMembershipOrThrow(
  ctx: Ctx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  message: string
): Promise<Doc<"members">> {
  const membership = await findMembership(ctx, orgId, userId);
  if (!membership) {
    notFound(message);
  }
  return membership;
}
