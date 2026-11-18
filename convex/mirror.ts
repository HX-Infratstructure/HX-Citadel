import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, ActionCtx } from "./_generated/server";
import type { ClerkMembershipData, ClerkOrgData, ClerkUserData } from "./webhooks";

const CLERK_API = "https://api.clerk.com/v1";

type ClerkMembership = ClerkMembershipData & { organization: ClerkOrgData };

/**
 * Pulls the signed-in user's Clerk records into the mirror. Clerk cannot
 * reach the LAN deployment, so its webhooks never arrive; the shell calls
 * this at sign-in instead and the writes still go through handleClerkEvent.
 */
export const syncCurrent = action({
  args: {},
  returns: v.object({
    users: v.number(),
    organizations: v.number(),
    memberships: v.number(),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }
    const key = process.env.CLERK_SECRET_KEY;
    if (!key) {
      throw new Error("CLERK_SECRET_KEY is not set");
    }

    const userPath = `/users/${identity.subject}`;
    const [user, membershipPage] = await Promise.all([
      fetchClerk<ClerkUserData>(key, userPath),
      fetchClerk<{ data: ClerkMembership[] }>(
        key,
        `${userPath}/organization_memberships?limit=100`
      ),
    ]);
    const memberships = membershipPage.data;

    await applyEvent(ctx, "user.updated", userFields(user));
    for (const membership of memberships) {
      await applyEvent(
        ctx,
        "organization.updated",
        organizationFields(membership.organization)
      );
    }
    for (const membership of memberships) {
      await applyEvent(
        ctx,
        "organizationMembership.updated",
        membershipFields(membership)
      );
    }

    return {
      users: 1,
      organizations: memberships.length,
      memberships: memberships.length,
    };
  },
});

async function fetchClerk<T>(key: string, path: string): Promise<T> {
  const response = await fetch(`${CLERK_API}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Clerk API ${response.status}`);
  }
  return (await response.json()) as T;
}

async function applyEvent(ctx: ActionCtx, eventType: string, data: unknown) {
  await ctx.runMutation(internal.webhooks.handleClerkEvent, { eventType, data });
}

function userFields(user: ClerkUserData): ClerkUserData {
  return {
    id: user.id,
    first_name: user.first_name,
    last_name: user.last_name,
    image_url: user.image_url,
    primary_email_address_id: user.primary_email_address_id,
    email_addresses: (user.email_addresses ?? []).map((e) => ({
      id: e.id,
      email_address: e.email_address,
    })),
  };
}

function organizationFields(org: ClerkOrgData): ClerkOrgData {
  return { id: org.id, name: org.name, slug: org.slug, image_url: org.image_url };
}

function membershipFields(membership: ClerkMembership) {
  return {
    id: membership.id,
    role: membership.role,
    organization: { id: membership.organization.id },
    public_user_data: { user_id: membership.public_user_data?.user_id },
  };
}
