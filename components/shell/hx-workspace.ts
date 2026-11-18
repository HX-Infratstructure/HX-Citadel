import type { HxMembership } from "@/lib/workspace";

export const MEMBERSHIP_FAILED_MESSAGE =
  "Couldn't check your HX workspace membership with Clerk.";

export const ACTIVATION_FAILED_MESSAGE = "Couldn't open the HX workspace.";

export type HxWorkspace =
  | { status: "loading" }
  | { status: "error" }
  | { status: "member"; membership: HxMembership }
  | { status: "non-member" };

export type MembershipLookup = {
  membership: HxMembership | null;
  clerkLoaded: boolean;
  isLoading: boolean;
  isError: boolean;
  hasNextPage: boolean;
};

export function toHxWorkspace({
  membership,
  clerkLoaded,
  isLoading,
  isError,
  hasNextPage,
}: MembershipLookup): HxWorkspace {
  if (membership) {
    return { status: "member", membership };
  }
  // A failed page leaves an empty list with no next page; that is not proof of non-membership.
  if (isError) {
    return { status: "error" };
  }
  if (!clerkLoaded || isLoading || hasNextPage) {
    return { status: "loading" };
  }
  return { status: "non-member" };
}
