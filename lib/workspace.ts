const ORG_ID_VARIABLE = "NEXT_PUBLIC_HX_WORKSPACE_ORG_ID";

// Next.js inlines NEXT_PUBLIC_ values only for a literal process.env.NAME read.
export const HX_WORKSPACE_ORG_ID = process.env.NEXT_PUBLIC_HX_WORKSPACE_ORG_ID;

export type HxMembership = { orgId: string; slug: string };

type ClerkMembership = {
  organization: { id: string; slug: string | null };
};

export function findHxMembership(
  memberships: readonly ClerkMembership[],
  pinnedOrgId: string | undefined
): HxMembership | null {
  if (!pinnedOrgId) {
    throw new Error(`${ORG_ID_VARIABLE} is not set.`);
  }
  const hx = memberships.find((m) => m.organization.id === pinnedOrgId);
  if (!hx) {
    return null;
  }
  if (!hx.organization.slug) {
    throw new Error(`Clerk organization ${pinnedOrgId} has no slug.`);
  }
  return { orgId: pinnedOrgId, slug: hx.organization.slug };
}
