import { describe, expect, it } from "vitest";
import { findHxMembership } from "./workspace";

const HX_ORG_ID = "org_hx";

function membership(id: string, slug: string | null) {
  return { organization: { id, slug } };
}

describe("findHxMembership", () => {
  it("returns the HX membership for a member", () => {
    expect(
      findHxMembership([membership(HX_ORG_ID, "hana-x")], HX_ORG_ID)
    ).toEqual({ orgId: HX_ORG_ID, slug: "hana-x" });
  });

  it("returns null for a non-member", () => {
    expect(
      findHxMembership([membership("org_other", "other")], HX_ORG_ID)
    ).toBeNull();
    expect(findHxMembership([], HX_ORG_ID)).toBeNull();
  });

  it("returns the HX membership when the person also belongs to another organization", () => {
    expect(
      findHxMembership(
        [membership("org_other", "other"), membership(HX_ORG_ID, "hana-x")],
        HX_ORG_ID
      )
    ).toEqual({ orgId: HX_ORG_ID, slug: "hana-x" });
  });

  it("throws, naming the variable, when the pinned id is unset", () => {
    expect(() =>
      findHxMembership([membership(HX_ORG_ID, "hana-x")], undefined)
    ).toThrow("NEXT_PUBLIC_HX_WORKSPACE_ORG_ID");
    expect(() => findHxMembership([], "")).toThrow(
      "NEXT_PUBLIC_HX_WORKSPACE_ORG_ID"
    );
  });

  it("throws when the HX organization has no slug", () => {
    expect(() =>
      findHxMembership([membership(HX_ORG_ID, null)], HX_ORG_ID)
    ).toThrow(HX_ORG_ID);
  });
});
