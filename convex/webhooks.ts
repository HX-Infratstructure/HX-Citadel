import { v } from "convex/values";
import { internalMutation, MutationCtx } from "./_generated/server";
import { findOrgByClerkId, findUserByClerkId } from "./lib/mirror";

/**
 * Clerk → Convex sync. Clerk is the source of truth for users, orgs and
 * memberships; these handlers mirror them into Convex tables so queries can
 * join against them with indexes.
 */

export type ClerkUserData = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: { id: string; email_address: string }[];
};

export type ClerkOrgData = {
  id: string;
  name?: string;
  slug?: string | null;
  image_url?: string | null;
};

export type ClerkMembershipData = {
  id: string;
  role?: string;
  organization?: { id: string };
  public_user_data?: { user_id: string };
};

export const handleClerkEvent = internalMutation({
  args: {
    eventType: v.string(),
    data: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { eventType } = args;

    if (eventType === "user.created" || eventType === "user.updated") {
      await upsertUser(ctx, args.data as ClerkUserData);
    } else if (eventType === "user.deleted") {
      await deleteUser(ctx, args.data as ClerkUserData);
    } else if (
      eventType === "organization.created" ||
      eventType === "organization.updated"
    ) {
      await upsertOrganization(ctx, args.data as ClerkOrgData);
    } else if (eventType === "organization.deleted") {
      await deleteOrganization(ctx, args.data as ClerkOrgData);
    } else if (
      eventType === "organizationMembership.created" ||
      eventType === "organizationMembership.updated"
    ) {
      await upsertMembership(ctx, args.data as ClerkMembershipData);
    } else if (eventType === "organizationMembership.deleted") {
      await deleteMembership(ctx, args.data as ClerkMembershipData);
    } else {
      console.log("Unhandled Clerk webhook event", eventType);
    }
    return null;
  },
});

async function upsertUser(ctx: MutationCtx, data: ClerkUserData) {
  const primaryEmail =
    data.email_addresses?.find((e) => e.id === data.primary_email_address_id)
      ?.email_address ??
    data.email_addresses?.[0]?.email_address ??
    "";
  const name =
    [data.first_name, data.last_name].filter(Boolean).join(" ") ||
    primaryEmail ||
    "Unknown";

  const existing = await findUserByClerkId(ctx, data.id);

  const fields = {
    name,
    email: primaryEmail,
    imageUrl: data.image_url ?? undefined,
  };

  if (existing) {
    await ctx.db.patch(existing._id, fields);
  } else {
    await ctx.db.insert("users", { clerkId: data.id, ...fields });
  }
}

async function deleteUser(ctx: MutationCtx, data: ClerkUserData) {
  const user = await findUserByClerkId(ctx, data.id);
  if (!user) {
    return;
  }
  const memberships = await ctx.db
    .query("members")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  for (const membership of memberships) {
    await ctx.db.delete(membership._id);
  }
  await ctx.db.delete(user._id);
}

async function upsertOrganization(ctx: MutationCtx, data: ClerkOrgData) {
  const existing = await findOrgByClerkId(ctx, data.id);

  if (existing) {
    await ctx.db.patch(existing._id, {
      name: data.name ?? existing.name,
      slug: data.slug ?? existing.slug,
      imageUrl: data.image_url ?? existing.imageUrl,
    });
  } else {
    await ctx.db.insert("organizations", {
      clerkOrgId: data.id,
      name: data.name ?? "Untitled",
      slug: data.slug ?? undefined,
      imageUrl: data.image_url ?? undefined,
      plan: "free",
    });
  }
}

async function deleteOrganization(ctx: MutationCtx, data: ClerkOrgData) {
  const org = await findOrgByClerkId(ctx, data.id);
  if (!org) {
    return;
  }
  const memberships = await ctx.db
    .query("members")
    .withIndex("by_org", (q) => q.eq("orgId", org._id))
    .collect();
  for (const membership of memberships) {
    await ctx.db.delete(membership._id);
  }
  // Workspace data (teams/issues/...) is intentionally left for a future
  // cleanup job — orgs are rarely deleted and cascading here would make
  // webhook handling slow.
  await ctx.db.delete(org._id);
}

async function upsertMembership(ctx: MutationCtx, data: ClerkMembershipData) {
  const clerkOrgId = data.organization?.id;
  const clerkUserId = data.public_user_data?.user_id;
  if (!clerkOrgId || !clerkUserId) {
    console.error("Membership event missing org or user id", data.id);
    return;
  }

  const org = await findOrgByClerkId(ctx, clerkOrgId);
  const user = await findUserByClerkId(ctx, clerkUserId);
  if (!org || !user) {
    // Clerk fires organization.created and organizationMembership.created
    // near-simultaneously and Svix does not guarantee ordering. Throwing makes
    // the webhook return non-2xx so Svix retries; returning success here would
    // ACK the event and lose the membership forever.
    throw new Error(
      `Membership sync: org or user not synced yet (${clerkOrgId}, ${clerkUserId}) — failing so Svix retries`
    );
  }

  const role = data.role === "org:admin" ? ("admin" as const) : ("member" as const);

  const existing = await ctx.db
    .query("members")
    .withIndex("by_clerk_membership_id", (q) =>
      q.eq("clerkMembershipId", data.id)
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, { role });
  } else {
    await ctx.db.insert("members", {
      orgId: org._id,
      userId: user._id,
      role,
      clerkMembershipId: data.id,
    });
  }
}

async function deleteMembership(ctx: MutationCtx, data: ClerkMembershipData) {
  const existing = await ctx.db
    .query("members")
    .withIndex("by_clerk_membership_id", (q) =>
      q.eq("clerkMembershipId", data.id)
    )
    .unique();
  if (existing) {
    await ctx.db.delete(existing._id);
  }
}
