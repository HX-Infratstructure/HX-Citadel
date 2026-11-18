import { describe, expect, it } from "vitest";
import { toHxWorkspace, type MembershipLookup } from "./hx-workspace";

const HX = { orgId: "org_hx", slug: "hana-x" };

const settled: MembershipLookup = {
  membership: null,
  clerkLoaded: true,
  isLoading: false,
  isError: false,
  hasNextPage: false,
};

describe("toHxWorkspace", () => {
  it("is a member when the HX membership is found", () => {
    expect(toHxWorkspace({ ...settled, membership: HX })).toEqual({
      status: "member",
      membership: HX,
    });
  });

  it("is a member even if a later page failed", () => {
    expect(
      toHxWorkspace({ ...settled, membership: HX, isError: true })
    ).toEqual({ status: "member", membership: HX });
  });

  it("is loading while Clerk is not loaded", () => {
    expect(toHxWorkspace({ ...settled, clerkLoaded: false })).toEqual({
      status: "loading",
    });
  });

  it("is loading while pages remain", () => {
    expect(toHxWorkspace({ ...settled, isLoading: true })).toEqual({
      status: "loading",
    });
    expect(toHxWorkspace({ ...settled, hasNextPage: true })).toEqual({
      status: "loading",
    });
  });

  it("is an error, not a non-member, when the lookup failed", () => {
    expect(toHxWorkspace({ ...settled, isError: true })).toEqual({
      status: "error",
    });
    expect(
      toHxWorkspace({ ...settled, isError: true, hasNextPage: true })
    ).toEqual({ status: "error" });
  });

  it("is a non-member only after every page loaded without error", () => {
    expect(toHxWorkspace(settled)).toEqual({ status: "non-member" });
  });
});
