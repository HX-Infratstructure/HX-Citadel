import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isPublicRoute } from "./public-routes";

const at = (path: string) => new NextRequest(`http://localhost${path}`);

describe("isPublicRoute", () => {
  it("lets /mcp through without a session", () => {
    expect(isPublicRoute(at("/mcp"))).toBe(true);
  });

  it("keeps sign-in and sign-up public", () => {
    expect(isPublicRoute(at("/sign-in/factor-one"))).toBe(true);
    expect(isPublicRoute(at("/sign-up"))).toBe(true);
  });

  it("protects the app", () => {
    expect(isPublicRoute(at("/"))).toBe(false);
    expect(isPublicRoute(at("/hx/team/abc"))).toBe(false);
  });
});
