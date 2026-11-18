/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const TEST_KEY = "sk_test_mirror";
const USER_ID = "user_sync";
const ORG_ID = "org_sync";
const MEMBERSHIP_ID = "orgmem_sync";
const USER_URL = `https://api.clerk.com/v1/users/${USER_ID}`;
const MEMBERSHIPS_URL = `${USER_URL}/organization_memberships?limit=100`;

const clerkUser = {
  id: USER_ID,
  first_name: "Ada",
  last_name: "Lovelace",
  image_url: "https://img.example/ada.png",
  primary_email_address_id: "idn_1",
  email_addresses: [{ id: "idn_1", email_address: "ada@example.com" }],
};

const clerkMemberships = {
  data: [
    {
      id: MEMBERSHIP_ID,
      role: "org:admin",
      organization: { id: ORG_ID, name: "Hana-X", slug: "hana-x", image_url: null },
      public_user_data: { user_id: USER_ID },
    },
  ],
  total_count: 1,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubClerk(statuses: { user?: number; memberships?: number } = {}) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === USER_URL) {
      return jsonResponse(clerkUser, statuses.user ?? 200);
    }
    if (url === MEMBERSHIPS_URL) {
      return jsonResponse(clerkMemberships, statuses.memberships ?? 200);
    }
    return jsonResponse({ errors: [] }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function signedIn() {
  return convexTest(schema, modules).withIdentity({ subject: USER_ID });
}

async function mirrorRows(t: ReturnType<typeof signedIn>) {
  return await t.run(async (ctx) => ({
    users: await ctx.db.query("users").collect(),
    organizations: await ctx.db.query("organizations").collect(),
    members: await ctx.db.query("members").collect(),
  }));
}

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = TEST_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLERK_SECRET_KEY;
});

describe("mirror.syncCurrent", () => {
  test("mirrors a new user, organization and membership", async () => {
    const fetchMock = stubClerk();
    const t = signedIn();

    const counts = await t.action(api.mirror.syncCurrent, {});

    expect(counts).toEqual({ users: 1, organizations: 1, memberships: 1 });
    const rows = await mirrorRows(t);
    expect(rows.users).toHaveLength(1);
    expect(rows.users[0]).toMatchObject({
      clerkId: USER_ID,
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(rows.organizations).toHaveLength(1);
    expect(rows.organizations[0]).toMatchObject({
      clerkOrgId: ORG_ID,
      name: "Hana-X",
      slug: "hana-x",
    });
    expect(rows.members).toHaveLength(1);
    expect(rows.members[0]).toMatchObject({
      clerkMembershipId: MEMBERSHIP_ID,
      role: "admin",
      userId: rows.users[0]._id,
      orgId: rows.organizations[0]._id,
    });

    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      authorization: new Headers(init?.headers).get("Authorization"),
    }));
    expect(calls).toEqual(
      expect.arrayContaining([
        { url: USER_URL, authorization: `Bearer ${TEST_KEY}` },
        { url: MEMBERSHIPS_URL, authorization: `Bearer ${TEST_KEY}` },
      ])
    );
    expect(calls).toHaveLength(2);
  });

  test("a second call leaves the same single rows", async () => {
    stubClerk();
    const t = signedIn();

    await t.action(api.mirror.syncCurrent, {});
    const first = await mirrorRows(t);
    await t.action(api.mirror.syncCurrent, {});
    const second = await mirrorRows(t);

    expect(second).toEqual(first);
    expect(second.users).toHaveLength(1);
    expect(second.organizations).toHaveLength(1);
    expect(second.members).toHaveLength(1);
  });

  test.each([
    { name: "user 404", statuses: { user: 404 }, status: 404 },
    { name: "user 500", statuses: { user: 500 }, status: 500 },
    { name: "memberships 404", statuses: { memberships: 404 }, status: 404 },
    { name: "memberships 500", statuses: { memberships: 500 }, status: 500 },
  ])("$name throws and writes nothing", async ({ statuses, status }) => {
    stubClerk(statuses);
    const t = signedIn();

    await expect(t.action(api.mirror.syncCurrent, {})).rejects.toThrow(
      `Clerk API ${status}`
    );
    const rows = await mirrorRows(t);
    expect(rows).toEqual({ users: [], organizations: [], members: [] });
  });

  test("refuses a caller with no identity", async () => {
    const fetchMock = stubClerk();
    const t = convexTest(schema, modules);

    await expect(t.action(api.mirror.syncCurrent, {})).rejects.toThrow(
      "Not authenticated"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses when the Clerk secret is missing", async () => {
    const fetchMock = stubClerk();
    delete process.env.CLERK_SECRET_KEY;
    const t = signedIn();

    await expect(t.action(api.mirror.syncCurrent, {})).rejects.toThrow(
      "CLERK_SECRET_KEY is not set"
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await mirrorRows(t);
    expect(rows).toEqual({ users: [], organizations: [], members: [] });
  });
});
