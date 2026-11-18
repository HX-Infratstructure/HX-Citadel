/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const agentSurfaces = import.meta.glob(["./http.ts", "./agentApi.ts", "../lib/mcp/tools.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ORG_CLAIM = "org_test";

async function setup() {
  const t = convexTest(schema, modules);
  const { teamId, ownerId, memberId } = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", { clerkId: "user_owner", name: "Owner", email: "o@example.com" });
    const memberId = await ctx.db.insert("users", { clerkId: "user_member", name: "Member", email: "m@example.com" });
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG_CLAIM, name: "Test Org", slug: "test-org" });
    await ctx.db.insert("members", { orgId, userId: ownerId, role: "admin", clerkMembershipId: "mem_owner" });
    await ctx.db.insert("members", { orgId, userId: memberId, role: "member", clerkMembershipId: "mem_member" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
    return { teamId, ownerId, memberId };
  });
  const asOwner = t.withIdentity({ subject: "user_owner", org_id: ORG_CLAIM });
  const asMember = t.withIdentity({ subject: "user_member", org_id: ORG_CLAIM });
  const story = (title: string, assigneeId?: Id<"users">) =>
    asMember.mutation(api.issues.create, { teamId, title, assigneeId });
  const issue = (issueId: Id<"issues">) => t.run(async (ctx) => (await ctx.db.get(issueId))!);
  const feed = (issueId: Id<"issues">) =>
    t.run(async (ctx) =>
      ctx.db
        .query("activity")
        .withIndex("by_issue", (q) => q.eq("issueId", issueId))
        .collect()
    );
  const lastChange = async (issueId: Id<"issues">, type: string) =>
    (await feed(issueId)).filter((row) => row.type === type).at(-1)!._id;
  const revert = (activityId: Id<"activity">) => asOwner.mutation(api.issues.revertChange, { activityId });
  return { t, asOwner, asMember, teamId, ownerId, memberId, story, issue, feed, lastChange, revert };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function passDoneGate(s: Setup, storyId: Id<"issues">) {
  const testing = await s.t.run(async (ctx) =>
    (
      await ctx.db
        .query("issues")
        .withIndex("by_parent", (q) => q.eq("parentIssueId", storyId))
        .collect()
    ).find((child) => child.testing)
  );
  await s.asMember.mutation(api.issues.setProof, { issueId: testing!._id, proofUrl: "https://ci.example.com/run/1" });
  await s.asMember.mutation(api.issues.update, { issueId: testing!._id, status: "done" });
  return testing!._id;
}

describe("owner revert from the activity log", () => {
  const cases = [
    { field: "status", change: { status: "in_progress" as const }, read: "status", restored: "todo" },
    { field: "priority", change: { priority: "urgent" as const }, read: "priority", restored: "none" },
    { field: "title", change: { title: "Renamed" }, read: "title", restored: "Original" },
    { field: "assignee", change: { assigneeId: null }, read: "assigneeId", restored: "member" },
  ] as const;

  for (const { field, change, read, restored } of cases) {
    test(`a ${field} revert restores the old value, bumps the version once and logs one reverted row`, async () => {
      const s = await setup();
      const storyId = await s.story("Original", s.memberId);
      await s.asMember.mutation(api.issues.update, { issueId: storyId, ...change });
      const before = await s.issue(storyId);
      const rowsBefore = (await s.feed(storyId)).length;

      await s.revert(await s.lastChange(storyId, `${field}_changed`));

      const after = await s.issue(storyId);
      const expected = restored === "member" ? s.memberId : restored;
      expect(after[read]).toBe(expected);
      expect(after.version).toBe(before.version! + 1);
      const rows = await s.feed(storyId);
      expect(rows).toHaveLength(rowsBefore + 1);
      expect(rows.at(-1)).toMatchObject({ type: "reverted", field, newValue: String(expected) });
    });
  }

  test("a non-admin member is refused", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, status: "in_progress" });
    const activityId = await s.lastChange(storyId, "status_changed");

    await expect(s.asMember.mutation(api.issues.revertChange, { activityId })).rejects.toThrow(
      /Admin access required/
    );
  });

  test("an unsupported field is refused", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, estimate: 3 });

    await expect(s.revert(await s.lastChange(storyId, "estimate_changed"))).rejects.toThrow(
      /^.*Only status, assignee, priority and title changes can be reverted/
    );
  });

  test("a field that changed since is refused, naming the story", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "low" });
    const earlier = await s.lastChange(storyId, "priority_changed");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "high" });

    await expect(s.revert(earlier)).rejects.toThrow(
      /ENG-1 priority has changed since; revert the latest change instead/
    );
    expect((await s.issue(storyId)).priority).toBe("high");
  });

  test("reverting In Review to In Progress is refused by WIP when the assignee holds another", async () => {
    const s = await setup();
    const first = await s.story("First", s.memberId);
    await s.asMember.mutation(api.issues.update, { issueId: first, status: "in_progress" });
    await passDoneGate(s, first);
    await s.asMember.mutation(api.issues.update, { issueId: first, status: "in_review" });
    const toReview = await s.lastChange(first, "status_changed");
    const second = await s.story("Second", s.memberId);
    await s.asMember.mutation(api.issues.update, { issueId: second, status: "in_progress" });

    await expect(s.revert(toReview)).rejects.toThrow(/already has ENG-\d+ In Progress/);
    expect((await s.issue(first)).status).toBe("in_review");
  });

  test("reverting to Done without proof is refused by the Done gate", async () => {
    const s = await setup();
    const storyId = await s.story("Story", s.memberId);
    const testingId = await passDoneGate(s, storyId);
    await s.asMember.mutation(api.issues.update, { issueId: storyId, status: "done" });
    await s.asMember.mutation(api.issues.update, { issueId: storyId, status: "in_progress" });
    const reopened = await s.lastChange(storyId, "status_changed");
    await s.asMember.mutation(api.issues.update, { issueId: testingId, status: "todo" });

    await expect(s.revert(reopened)).rejects.toThrow(/Can.t move ENG-1 to Done: open/);
    expect((await s.issue(storyId)).status).toBe("in_progress");
  });

  test("an assignee id that can't be parsed is refused and the assignee is unchanged", async () => {
    const s = await setup();
    const storyId = await s.story("Story", s.memberId);
    const activityId = await s.t.run(async (ctx) => {
      const story = (await ctx.db.get(storyId))!;
      return await ctx.db.insert("activity", {
        orgId: story.orgId,
        issueId: storyId,
        actorId: s.memberId,
        type: "assignee_changed",
        field: "assignee",
        oldValue: "not-a-user-id",
        newValue: s.memberId,
      });
    });

    await expect(s.revert(activityId)).rejects.toThrow(/Unknown value not-a-user-id/);
    expect((await s.issue(storyId)).assigneeId).toBe(s.memberId);
  });

  test("an agent can't reach it: no REST route and no MCP tool", () => {
    expect(Object.keys(agentSurfaces)).toHaveLength(3);
    for (const source of Object.values(agentSurfaces)) {
      expect(source).not.toMatch(/revert/i);
    }
  });
});
