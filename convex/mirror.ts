import { Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, ActionCtx, internalAction, internalQuery } from "./_generated/server";
import type { ClerkMembershipData, ClerkOrgData, ClerkUserData } from "./webhooks";

const CLERK_API = "https://api.clerk.com/v1";
const PAGE_SIZE = 100;

type ClerkMembership = ClerkMembershipData & { organization: ClerkOrgData };

type ClerkDirectory = {
  users: ClerkUserData[];
  organizations: ClerkOrgData[];
  memberships: ClerkMembership[];
};

const entryFields = { key: v.string(), fingerprint: v.string() };
const snapshotValidator = v.object({
  users: v.array(v.object({ ...entryFields, hasMembership: v.boolean() })),
  organizations: v.array(v.object(entryFields)),
  members: v.array(v.object(entryFields)),
});

const changeCountFields = { added: v.number(), changed: v.number(), removed: v.number() };
const reconcileCountsValidator = v.object({
  users: v.object(changeCountFields),
  organizations: v.object({ ...changeCountFields, keptWithContent: v.number() }),
  members: v.object(changeCountFields),
});

type Snapshot = Infer<typeof snapshotValidator>;
type SnapshotEntry = Snapshot["members"][number];
type ChangeCounts = Infer<typeof reconcileCountsValidator>["members"];
type ReconcileCounts = Infer<typeof reconcileCountsValidator>;

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
    const key = requireClerkKey();

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

/**
 * Hourly full reconcile (crons.ts). syncCurrent only sees the signed-in
 * user, so deletions and role changes made in Clerk reach the mirror here.
 * Every page is fetched before the first write, so a Clerk error changes
 * nothing.
 */
export const reconcileAll = internalAction({
  args: {},
  returns: reconcileCountsValidator,
  handler: async (ctx): Promise<ReconcileCounts> => {
    const clerk = await fetchDirectory(requireClerkKey());
    const before: Snapshot = await ctx.runQuery(internal.mirror.mirrorSnapshot, {});

    await upsertDirectory(ctx, clerk);
    await removeGoneMemberships(ctx, before, clerk);
    const keptWithContent = await removeGoneOrganizations(ctx, before, clerk);
    await removeGoneUsers(ctx, clerk);

    const after: Snapshot = await ctx.runQuery(internal.mirror.mirrorSnapshot, {});
    const counts = {
      users: diffEntries(before.users, after.users),
      organizations: {
        ...diffEntries(before.organizations, after.organizations),
        keptWithContent,
      },
      members: diffEntries(before.members, after.members),
    };
    console.log(formatCounts(counts));
    return counts;
  },
});

export const mirrorSnapshot = internalQuery({
  args: {},
  returns: snapshotValidator,
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const organizations = await ctx.db.query("organizations").collect();
    const members = await ctx.db.query("members").collect();
    const memberUserIds = new Set(members.map((m) => m.userId));
    return {
      users: users.map((u) => ({
        key: u.clerkId,
        fingerprint: fingerprint(u.name, u.email, u.imageUrl),
        hasMembership: memberUserIds.has(u._id),
      })),
      organizations: organizations.map((o) => ({
        key: o.clerkOrgId,
        fingerprint: fingerprint(o.name, o.slug, o.imageUrl),
      })),
      members: members.map((m) => ({
        key: m.clerkMembershipId,
        fingerprint: fingerprint(m.role),
      })),
    };
  },
});

function requireClerkKey() {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    throw new Error("CLERK_SECRET_KEY is not set");
  }
  return key;
}

async function fetchAllPages<T>(key: string, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const body = await fetchClerk<T[] | { data: T[] }>(
      key,
      `${path}?limit=${PAGE_SIZE}&offset=${offset}`
    );
    const page = Array.isArray(body) ? body : body.data;
    items.push(...page);
    if (page.length < PAGE_SIZE) {
      return items;
    }
  }
}

async function fetchDirectory(key: string): Promise<ClerkDirectory> {
  const [users, organizations] = await Promise.all([
    fetchAllPages<ClerkUserData>(key, "/users"),
    fetchAllPages<ClerkOrgData>(key, "/organizations"),
  ]);
  const perOrg = await Promise.all(
    organizations.map(async (organization) => {
      const memberships = await fetchAllPages<ClerkMembershipData>(
        key,
        `/organizations/${organization.id}/memberships`
      );
      return memberships.map((membership) => ({ ...membership, organization }));
    })
  );
  return { users, organizations, memberships: perOrg.flat() };
}

async function upsertDirectory(ctx: ActionCtx, clerk: ClerkDirectory) {
  for (const user of clerk.users) {
    await applyEvent(ctx, "user.updated", userFields(user));
  }
  for (const organization of clerk.organizations) {
    await applyEvent(ctx, "organization.updated", organizationFields(organization));
  }
  for (const membership of clerk.memberships) {
    await applyEvent(ctx, "organizationMembership.updated", membershipFields(membership));
  }
}

async function removeGoneMemberships(ctx: ActionCtx, before: Snapshot, clerk: ClerkDirectory) {
  for (const entry of goneEntries(before.members, clerk.memberships)) {
    await applyEvent(ctx, "organizationMembership.deleted", { id: entry.key });
  }
}

async function removeGoneOrganizations(ctx: ActionCtx, before: Snapshot, clerk: ClerkDirectory) {
  let keptWithContent = 0;
  for (const entry of goneEntries(before.organizations, clerk.organizations)) {
    const clerkOrgId = entry.key;
    if (await ctx.runQuery(internal.admin.orgHasContent, { clerkOrgId })) {
      keptWithContent += 1;
    } else {
      await ctx.runMutation(internal.admin.deleteOrgMirror, { clerkOrgId });
    }
  }
  return keptWithContent;
}

async function removeGoneUsers(ctx: ActionCtx, clerk: ClerkDirectory) {
  const current: Snapshot = await ctx.runQuery(internal.mirror.mirrorSnapshot, {});
  const unattached = current.users.filter((user) => !user.hasMembership);
  for (const entry of goneEntries(unattached, clerk.users)) {
    await applyEvent(ctx, "user.deleted", { id: entry.key });
  }
}

function goneEntries<E extends SnapshotEntry>(entries: E[], clerkObjects: { id: string }[]) {
  const clerkIds = new Set(clerkObjects.map((object) => object.id));
  return entries.filter((entry) => !clerkIds.has(entry.key));
}

function diffEntries(before: SnapshotEntry[], after: SnapshotEntry[]): ChangeCounts {
  const beforeByKey = new Map(before.map((entry) => [entry.key, entry.fingerprint]));
  const afterKeys = new Set(after.map((entry) => entry.key));
  const kept = after.filter((entry) => beforeByKey.has(entry.key));
  return {
    added: after.length - kept.length,
    changed: kept.filter((entry) => beforeByKey.get(entry.key) !== entry.fingerprint).length,
    removed: before.filter((entry) => !afterKeys.has(entry.key)).length,
  };
}

function fingerprint(...values: (string | undefined)[]) {
  return JSON.stringify(values.map((value) => value ?? null));
}

function formatChanges(counts: ChangeCounts) {
  return `+${counts.added} ~${counts.changed} -${counts.removed}`;
}

function formatCounts({ users, organizations, members }: ReconcileCounts) {
  return (
    `mirror reconcile: users ${formatChanges(users)}, ` +
    `orgs ${formatChanges(organizations)} (kept ${organizations.keptWithContent} with content), ` +
    `members ${formatChanges(members)}`
  );
}

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
