/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { LIST_LIMIT } from "./issues";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG = "org_hx";
const MEMBER = "user_member";
const DAY = 86_400_000;

async function setup(transactionLimits?: { documentsRead: number }) {
  const t = convexTest({ schema, modules, transactionLimits });
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG, name: "HX", slug: "hx" });
    const userId = await ctx.db.insert("users", { clerkId: MEMBER, name: "Member", email: "member@example.com" });
    await ctx.db.insert("members", { orgId, userId, role: "member", clerkMembershipId: "mem_member" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
    const cycleId = await ctx.db.insert("cycles", { orgId, teamId, number: 1, startDate: 0, endDate: Date.now() + DAY });
    return { orgId, userId, teamId, cycleId };
  });
  return { t, member: t.withIdentity({ subject: MEMBER, org_id: ORG }), ...ids };
}

describe("cycle dates", () => {
  test.each([
    ["create", (s: Awaited<ReturnType<typeof setup>>) =>
      s.member.mutation(api.cycles.create, { teamId: s.teamId, startDate: DAY, endDate: DAY })],
    ["update", (s: Awaited<ReturnType<typeof setup>>) =>
      s.member.mutation(api.cycles.update, { cycleId: s.cycleId, endDate: 0 })],
  ])("%s with an end date not after the start is a typed validation refusal", async (_name, write) => {
    await expect(write(await setup())).rejects.toMatchObject({
      data: { code: "validation", message: "Cycle end date must be after its start date" },
    });
  });
});

describe("a cycle with more than LIST_LIMIT issues", () => {
  test("lists LIST_LIMIT of them, and the index row's progress counts every one", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let number = 1; number <= LIST_LIMIT + 1; number++) {
        await ctx.db.insert("issues", {
          orgId: s.orgId,
          teamId: s.teamId,
          kind: "story",
          number,
          title: `Story ${number}`,
          status: number <= LIST_LIMIT ? "done" : "todo",
          priority: "none",
          creatorId: s.userId,
          cycleId: s.cycleId,
          sortOrder: number,
        });
      }
    });

    const issues = await s.member.query(api.cycles.listIssues, { cycleId: s.cycleId });
    const [cycle] = await s.member.query(api.cycles.list, {});
    const row = await s.member.query(api.cycles.progress, { cycleId: cycle._id });

    const expected = { total: LIST_LIMIT + 1, done: LIST_LIMIT, todo: 1 };
    expect(issues).toHaveLength(LIST_LIMIT);
    expect(row).toMatchObject(expected);
  });
});

describe("cycles.list", () => {
  test("lists every cycle newest first within 10 document reads, so it reads no issues", async () => {
    const s = await setup({ documentsRead: 10 });
    await s.t.run(async (ctx) => {
      const cycleIds = [
        s.cycleId,
        await ctx.db.insert("cycles", { orgId: s.orgId, teamId: s.teamId, number: 2, startDate: DAY, endDate: 2 * DAY }),
        await ctx.db.insert("cycles", { orgId: s.orgId, teamId: s.teamId, number: 3, startDate: 2 * DAY, endDate: 3 * DAY }),
      ];
      let number = 0;
      for (const cycleId of cycleIds) {
        for (let i = 0; i < 20; i++) {
          number++;
          await ctx.db.insert("issues", {
            orgId: s.orgId,
            teamId: s.teamId,
            kind: "story",
            number,
            title: `Story ${number}`,
            status: "todo",
            priority: "none",
            creatorId: s.userId,
            cycleId,
            sortOrder: number,
          });
        }
      }
    });

    const cycles = await s.member.query(api.cycles.list, {});

    expect(cycles.map((cycle) => cycle.number)).toEqual([3, 2, 1]);
  });
});

describe("cycles.progress for the index rows", () => {
  test("each row's progress reads within 30 documents", async () => {
    const s = await setup({ documentsRead: 30 });
    await s.t.run(async (ctx) => {
      const cycleIds = [
        s.cycleId,
        await ctx.db.insert("cycles", { orgId: s.orgId, teamId: s.teamId, number: 2, startDate: DAY, endDate: 2 * DAY }),
        await ctx.db.insert("cycles", { orgId: s.orgId, teamId: s.teamId, number: 3, startDate: 2 * DAY, endDate: 3 * DAY }),
      ];
      let number = 0;
      for (const cycleId of cycleIds) {
        for (let i = 0; i < 20; i++) {
          number++;
          await ctx.db.insert("issues", {
            orgId: s.orgId,
            teamId: s.teamId,
            kind: "story",
            number,
            title: `Story ${number}`,
            status: "todo",
            priority: "none",
            creatorId: s.userId,
            cycleId,
            sortOrder: number,
          });
        }
      }
    });

    const cycles = await s.member.query(api.cycles.list, {});

    for (const cycle of cycles) {
      expect(await s.member.query(api.cycles.progress, { cycleId: cycle._id })).toMatchObject({
        total: 20,
        todo: 20,
      });
    }
  });
});
