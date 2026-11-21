/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { formatIssueKey } from "../lib/issue-key";
import { isGatedStatus } from "../lib/issue-status";
import { SPRINT_DAYS, sprintEnd } from "../lib/sprint";
import { internal } from "./_generated/api";
import { assertDoneGate } from "./lib/rules/doneGate";
import { assertValidParent } from "./lib/rules/levels";
import { assertWipFree } from "./lib/rules/wip";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const SEEDED_ORG = "org_seeded";
const OTHER_ORG = "org_other";
const ADMIN_CLERK_ID = "user_admin";
const OUTSIDER_CLERK_ID = "user_outsider";

const EXPECTED_COUNTS = {
  teams: 3,
  labels: 8,
  projects: 2,
  cycles: 4,
  issues: 89,
  comments: 5,
};

async function setup() {
  const t = convexTest(schema, modules);
  const { seededOrgId, adminId } = await t.run(async (ctx) => {
    const adminId = await ctx.db.insert("users", {
      clerkId: ADMIN_CLERK_ID,
      name: "Admin",
      email: "admin@example.com",
    });
    const outsiderId = await ctx.db.insert("users", {
      clerkId: OUTSIDER_CLERK_ID,
      name: "Outsider",
      email: "outsider@example.com",
    });
    const seededOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: SEEDED_ORG,
      name: "Seeded Org",
      slug: "seeded-org",
    });
    const otherOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: OTHER_ORG,
      name: "Other Org",
      slug: "other-org",
    });
    await ctx.db.insert("members", {
      orgId: seededOrgId,
      userId: adminId,
      role: "admin",
      clerkMembershipId: "mem_admin",
    });
    await ctx.db.insert("members", {
      orgId: otherOrgId,
      userId: outsiderId,
      role: "admin",
      clerkMembershipId: "mem_outsider",
    });
    return { seededOrgId, adminId };
  });
  return { t, seededOrgId, adminId };
}

describe("seed.demoData", () => {
  test("seeds the named organization for the named member and reports per-table counts", async () => {
    const { t, seededOrgId, adminId } = await setup();

    const result = await t.mutation(internal.seed.demoData, {
      clerkOrgId: SEEDED_ORG,
      clerkUserId: ADMIN_CLERK_ID,
    });

    expect(result).toEqual(EXPECTED_COUNTS);

    const rows = await t.run(async (ctx) => {
      const issues = await ctx.db.query("issues").collect();
      const comments = await ctx.db.query("comments").collect();
      return {
        orgIdsByTable: {
          teams: (await ctx.db.query("teams").collect()).map((row) => row.orgId),
          labels: (await ctx.db.query("labels").collect()).map((row) => row.orgId),
          projects: (await ctx.db.query("projects").collect()).map((row) => row.orgId),
          cycles: (await ctx.db.query("cycles").collect()).map((row) => row.orgId),
          issues: issues.map((row) => row.orgId),
          comments: comments.map((row) => row.orgId),
        },
        issueCreators: issues.map((row) => row.creatorId),
        commentAuthors: comments.map((row) => row.authorId),
      };
    });

    for (const [table, expected] of Object.entries(EXPECTED_COUNTS)) {
      const orgIds = rows.orgIdsByTable[table as keyof typeof EXPECTED_COUNTS];
      expect(orgIds, `${table} rows`).toHaveLength(expected);
      expect(new Set(orgIds), `${table} rows belong to the seeded organization only`).toEqual(
        new Set([seededOrgId])
      );
    }
    expect(new Set(rows.issueCreators)).toEqual(new Set([adminId]));
    expect(new Set(rows.commentAuthors)).toEqual(new Set([adminId]));
  });

  test("seeds data that passes every phase 2 rule", async () => {
    const { t } = await setup();
    await t.mutation(internal.seed.demoData, {
      clerkOrgId: SEEDED_ORG,
      clerkUserId: ADMIN_CLERK_ID,
    });

    await t.run(async (ctx) => {
      const issues = await ctx.db.query("issues").collect();
      const byId = new Map(issues.map((issue) => [issue._id, issue]));
      const parentOf = (issue: (typeof issues)[number]) =>
        issue.parentIssueId === undefined ? undefined : byId.get(issue.parentIssueId);
      const kinds = new Set(issues.map((issue) => issue.kind));
      expect(kinds, "every level is seeded").toEqual(new Set(["epic", "feature", "story", "subtask"]));
      expect(
        issues.some((issue) => issue.kind === "story" && parentOf(issue)?.kind === "feature"),
        "a story sits under a feature"
      ).toBe(true);

      for (const issue of issues) {
        await expect(
          assertValidParent(ctx, issue.orgId, issue.kind, {
            teamId: issue.teamId,
            parentIssueId: issue.parentIssueId,
            projectId: issue.projectId,
          }),
          `${issue.title} sits at a valid level with its parent's team and project`
        ).resolves.toEqual({ teamId: issue.teamId, projectId: issue.projectId });
      }

      for (const issue of issues.filter((row) => row.kind === "story" || row.kind === "subtask")) {
        const team = await ctx.db.get(issue.teamId);
        expect(
          formatIssueKey(team!.key, issue, parentOf(issue)?.number),
          `${issue.title} has a display key`
        ).not.toBeNull();
      }

      for (const story of issues.filter((issue) => issue.kind === "story")) {
        const testing = issues.filter(
          (issue) => issue.parentIssueId === story._id && issue.testing === true
        );
        expect(testing, `${story.title} has one Complete testing sub-task`).toHaveLength(1);
        expect(story.type, `${story.title} has a type`).toBeDefined();
        const subNumbers = issues.filter((issue) => issue.parentIssueId === story._id).map((issue) => issue.subNumber!);
        expect(new Set(subNumbers).size, `${story.title}'s sub-task keys are unique`).toBe(subNumbers.length);
        expect(story.nextSubNumber, `${story.title}'s counter is past every sub-task`).toBe(Math.max(...subNumbers) + 1);
      }

      for (const issue of issues.filter((row) => row.status === "in_progress")) {
        await expect(
          assertWipFree(ctx, {
            orgId: issue.orgId,
            assigneeId: issue.assigneeId,
            issueId: issue._id,
            kind: issue.kind,
            status: issue.status,
          }),
          `${issue.title} keeps WIP at one story`
        ).resolves.toBeUndefined();
      }

      for (const issue of issues) {
        if (isGatedStatus(issue.status)) {
          await expect(
            assertDoneGate(ctx, issue, issue.status),
            `${issue.title} passes the Done gate`
          ).resolves.toBeUndefined();
        }
      }

      const cycles = await ctx.db.query("cycles").collect();
      for (const cycle of cycles) {
        expect(cycle.endDate, `cycle ${cycle.number} runs ${SPRINT_DAYS} days`).toBe(
          sprintEnd(cycle.startDate)
        );
      }
    });
  });

  // Catches a seed that numbers its stories but leaves a team's counter behind them, so the next story created
  // takes a number a seeded story already holds.
  test("leaves each team's issue counter one past its highest story number", async () => {
    const { t } = await setup();
    await t.mutation(internal.seed.demoData, {
      clerkOrgId: SEEDED_ORG,
      clerkUserId: ADMIN_CLERK_ID,
    });

    const { teams, stories } = await t.run(async (ctx) => ({
      teams: await ctx.db.query("teams").collect(),
      stories: (await ctx.db.query("issues").collect()).filter((issue) => issue.kind === "story"),
    }));

    expect(teams).toHaveLength(EXPECTED_COUNTS.teams);
    for (const team of teams) {
      const numbers = stories.filter((story) => story.teamId === team._id).map((story) => story.number!);
      expect(numbers.length, `${team.key} has seeded stories`).toBeGreaterThan(0);
      expect(team.nextIssueNumber, `${team.key}'s counter is one past its highest story`).toBe(
        Math.max(...numbers) + 1
      );
    }
  });

  test("refuses an organization that is not synced", async () => {
    const { t } = await setup();

    await expect(
      t.mutation(internal.seed.demoData, {
        clerkOrgId: "org_unknown",
        clerkUserId: ADMIN_CLERK_ID,
      })
    ).rejects.toMatchObject({
      data: { code: "not_found", message: "Organization org_unknown is not synced to Convex." },
    });

    const teams = await t.run((ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(0);
  });

  test("refuses a user who is not a member of the organization", async () => {
    const { t } = await setup();

    await expect(
      t.mutation(internal.seed.demoData, {
        clerkOrgId: SEEDED_ORG,
        clerkUserId: OUTSIDER_CLERK_ID,
      })
    ).rejects.toMatchObject({
      data: { code: "not_found", message: `User ${OUTSIDER_CLERK_ID} is not a member of organization ${SEEDED_ORG}.` },
    });

    const teams = await t.run((ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(0);
  });
});
