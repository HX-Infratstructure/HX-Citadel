/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { StorageActionWriter } from "convex/server";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import { Doc, Id, TableNames } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const CLEARED_ORG = "org_cleared";
const KEPT_ORG = "org_kept";
const LONE_ORG = "org_lone";

const CONTENT_TABLES = [
  "issueLabels",
  "issueRelations",
  "comments",
  "activity",
  "attachments",
  "issues",
  "cycles",
  "labels",
  "views",
  "projects",
  "teams",
  "idempotencyKeys",
] as const satisfies readonly TableNames[];

const MIRROR_TABLES = ["organizations", "users", "members"] as const satisfies readonly TableNames[];

const SEEDED_COUNTS = {
  issueLabels: 1,
  issueRelations: 1,
  comments: 1,
  activity: 2,
  attachments: 1,
  issues: 2,
  cycles: 1,
  labels: 1,
  views: 1,
  projects: 1,
  teams: 1,
  idempotencyKeys: 1,
};

const ZERO_COUNTS = Object.fromEntries(CONTENT_TABLES.map((table) => [table, 0]));

async function seedMirror(ctx: MutationCtx, clerkOrgId: string) {
  const userId = await ctx.db.insert("users", {
    clerkId: `user_${clerkOrgId}`,
    name: "Owner",
    email: `${clerkOrgId}@example.com`,
  });
  const orgId = await ctx.db.insert("organizations", {
    clerkOrgId,
    name: clerkOrgId,
    slug: clerkOrgId,
  });
  await ctx.db.insert("members", {
    orgId,
    userId,
    role: "admin",
    clerkMembershipId: `mem_${clerkOrgId}`,
  });
  return { orgId, userId };
}

async function seedOrg(ctx: MutationCtx & { storage: StorageActionWriter }, clerkOrgId: string) {
  const { orgId, userId } = await seedMirror(ctx, clerkOrgId);
  const teamId = await ctx.db.insert("teams", {
    orgId,
    name: "Engineering",
    key: "ENG",
    nextIssueNumber: 3,
  });
  const cycleId = await ctx.db.insert("cycles", {
    orgId,
    teamId,
    number: 1,
    startDate: 0,
    endDate: 1,
  });
  const projectId = await ctx.db.insert("projects", {
    orgId,
    name: "Launch",
    status: "planned",
  });
  const issueIds: Id<"issues">[] = [];
  for (const number of [1, 2]) {
    const issueId = await ctx.db.insert("issues", {
      orgId,
      teamId,
      kind: "story",
      number,
      title: `Issue ${number}`,
      status: "todo",
      priority: "none",
      creatorId: userId,
      projectId,
      cycleId,
      sortOrder: number,
    });
    await ctx.db.insert("activity", { orgId, issueId, actorId: userId, type: "created" });
    issueIds.push(issueId);
  }
  const [firstIssueId, secondIssueId] = issueIds;
  const labelId = await ctx.db.insert("labels", { orgId, name: "Bug", color: "#ff0000" });
  await ctx.db.insert("issueLabels", { issueId: firstIssueId, labelId });
  await ctx.db.insert("issueRelations", {
    issueId: firstIssueId,
    relatedIssueId: secondIssueId,
    type: "blocks",
  });
  await ctx.db.insert("comments", { orgId, issueId: firstIssueId, authorId: userId, body: "Hi" });
  const storageId = await ctx.storage.store(new Blob(["attachment"]));
  await ctx.db.insert("attachments", {
    orgId,
    issueId: firstIssueId,
    storageId,
    fileName: "a.txt",
    fileType: "text/plain",
    fileSize: 10,
    uploadedBy: userId,
  });
  await ctx.db.insert("views", {
    orgId,
    creatorId: userId,
    name: "Mine",
    filters: "{}",
    shared: false,
  });
  await ctx.db.insert("idempotencyKeys", {
    orgId,
    agentId: userId,
    key: "k-1",
    requestHash: "hash",
    body: { done: true },
    createdAt: 1,
  });
  return { orgId, storageId };
}

async function setup() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => ({
    cleared: await seedOrg(ctx, CLEARED_ORG),
    kept: await seedOrg(ctx, KEPT_ORG),
  }));
  return { t, ...seeded };
}

type TestConvex = Awaited<ReturnType<typeof setup>>["t"];

async function snapshot<T extends TableNames>(t: TestConvex, tables: readonly T[]) {
  const entries = await t.run((ctx) =>
    Promise.all(tables.map(async (table) => [table, await ctx.db.query(table).collect()] as const))
  );
  return Object.fromEntries(entries) as { [K in T]: Doc<K>[] };
}

function belongsTo(orgId: Id<"organizations">, clearedIssueIds: Set<string>) {
  return (doc: Record<string, unknown>) =>
    doc.orgId === orgId || clearedIssueIds.has(String(doc.issueId));
}

describe("admin.clearOrgContent", () => {
  test("deletes one organization's content and keeps its mirror and the other organization", async () => {
    const { t, cleared } = await setup();
    const contentBefore = await snapshot(t, CONTENT_TABLES);
    const mirrorBefore = await snapshot(t, MIRROR_TABLES);
    const clearedIssueIds = new Set(
      contentBefore.issues.filter((issue) => issue.orgId === cleared.orgId).map((issue) => issue._id)
    );
    const isCleared = belongsTo(cleared.orgId, clearedIssueIds);

    const counts = await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });

    expect(counts).toEqual(SEEDED_COUNTS);
    const contentAfter = await snapshot(t, CONTENT_TABLES);
    for (const table of CONTENT_TABLES) {
      expect(contentAfter[table], table).toEqual(
        contentBefore[table].filter((doc) => !isCleared(doc))
      );
    }
    expect(await snapshot(t, MIRROR_TABLES)).toEqual(mirrorBefore);
    const storedFile = await t.run((ctx) => ctx.db.system.get(cleared.storageId));
    expect(storedFile).toBeNull();
  });

  test("returns all zeros on a second run", async () => {
    const { t } = await setup();
    await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });

    const counts = await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });

    expect(counts).toEqual(ZERO_COUNTS);
  });

  test("refuses an unknown organization", async () => {
    const { t } = await setup();

    await expect(
      t.mutation(internal.admin.clearOrgContent, { clerkOrgId: "org_missing" })
    ).rejects.toThrow("Organization org_missing not found");
  });
});

async function setupMirrorWith(
  insertRow: (ctx: MutationCtx, orgId: Id<"organizations">) => Promise<unknown>
) {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const { orgId } = await seedMirror(ctx, LONE_ORG);
    await insertRow(ctx, orgId);
  });
  return t;
}

async function expectMirrorRefused(t: TestConvex, clerkOrgId: string, message: string) {
  const mirrorBefore = await snapshot(t, MIRROR_TABLES);

  await expect(t.mutation(internal.admin.deleteOrgMirror, { clerkOrgId })).rejects.toThrow(message);
  expect(await snapshot(t, MIRROR_TABLES)).toEqual(mirrorBefore);
}

describe("admin.deleteOrgMirror", () => {
  test("refuses while the organization still has content and names every table", async () => {
    const { t } = await setup();

    await expectMirrorRefused(
      t,
      CLEARED_ORG,
      `Organization ${CLEARED_ORG} still has rows in ${CONTENT_TABLES.join(", ")}.`
    );
  });

  test("refuses an organization that has only a project", async () => {
    const t = await setupMirrorWith((ctx, orgId) =>
      ctx.db.insert("projects", { orgId, name: "Solo", status: "planned" })
    );

    await expectMirrorRefused(t, LONE_ORG, `Organization ${LONE_ORG} still has rows in projects.`);
  });

  test("refuses an organization that has only a label", async () => {
    const t = await setupMirrorWith((ctx, orgId) =>
      ctx.db.insert("labels", { orgId, name: "Solo", color: "#000000" })
    );

    await expectMirrorRefused(t, LONE_ORG, `Organization ${LONE_ORG} still has rows in labels.`);
  });

  test("removes the organization and member rows after clearOrgContent and keeps users", async () => {
    const { t, cleared } = await setup();
    await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });
    const mirrorBefore = await snapshot(t, MIRROR_TABLES);

    const counts = await t.mutation(internal.admin.deleteOrgMirror, { clerkOrgId: CLEARED_ORG });

    expect(counts).toEqual({ organizations: 1, members: 1 });
    const mirrorAfter = await snapshot(t, MIRROR_TABLES);
    expect(mirrorAfter.users).toEqual(mirrorBefore.users);
    expect(mirrorAfter.organizations).toEqual(
      mirrorBefore.organizations.filter((org) => org._id !== cleared.orgId)
    );
    expect(mirrorAfter.members).toEqual(
      mirrorBefore.members.filter((member) => member.orgId !== cleared.orgId)
    );
  });
});

const TEAM_ORG = "org_teams";
const CLEARED_TEAM = "ENG";
const KEPT_TEAM = "OPS";

async function seedTeam(
  ctx: MutationCtx & { storage: StorageActionWriter },
  orgId: Id<"organizations">,
  userId: Id<"users">,
  key: string
) {
  const teamId = await ctx.db.insert("teams", { orgId, name: key, key, nextIssueNumber: 3 });
  const cycleId = await ctx.db.insert("cycles", { orgId, teamId, number: 1, startDate: 0, endDate: 1 });
  const issueFields = { orgId, teamId, status: "todo", priority: "none", creatorId: userId, cycleId } as const;
  const storyId = await ctx.db.insert("issues", {
    ...issueFields,
    kind: "story",
    number: 1,
    title: `${key} story`,
    sortOrder: 1,
  });
  const subtaskId = await ctx.db.insert("issues", {
    ...issueFields,
    kind: "subtask",
    subNumber: 1,
    title: `${key} sub-task`,
    parentIssueId: storyId,
    sortOrder: 2,
  });
  for (const issueId of [storyId, subtaskId]) {
    await ctx.db.insert("activity", { orgId, issueId, actorId: userId, type: "created" });
  }
  await ctx.db.insert("comments", { orgId, issueId: storyId, authorId: userId, body: key });
  await ctx.db.insert("issueRelations", { issueId: storyId, relatedIssueId: subtaskId, type: "blocks" });
  const storageId = await ctx.storage.store(new Blob([key]));
  await ctx.db.insert("attachments", {
    orgId,
    issueId: storyId,
    storageId,
    fileName: `${key}.txt`,
    fileType: "text/plain",
    fileSize: 3,
    uploadedBy: userId,
  });
  return { teamId, storyId, storageId };
}

async function setupTeams() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const { orgId, userId } = await seedMirror(ctx, TEAM_ORG);
    const cleared = await seedTeam(ctx, orgId, userId, CLEARED_TEAM);
    const kept = await seedTeam(ctx, orgId, userId, KEPT_TEAM);
    const labelId = await ctx.db.insert("labels", { orgId, name: "Bug", color: "#ff0000" });
    await ctx.db.insert("issueLabels", { issueId: cleared.storyId, labelId });
    await ctx.db.insert("issueLabels", { issueId: kept.storyId, labelId });
    await ctx.db.insert("issueRelations", {
      issueId: cleared.storyId,
      relatedIssueId: kept.storyId,
      type: "blocks",
    });
    await ctx.db.insert("projects", { orgId, name: "Shared", status: "planned" });
    await ctx.db.insert("views", { orgId, creatorId: userId, name: "Mine", filters: "{}", shared: true });
    await ctx.db.insert("idempotencyKeys", {
      orgId,
      agentId: userId,
      key: "k-1",
      requestHash: "hash",
      body: { done: true },
      createdAt: 1,
    });
    return { cleared, kept };
  });
  return { t, ...seeded };
}

function belongsToTeam(teamId: Id<"teams">, teamIssueIds: Set<string>) {
  return (doc: Record<string, unknown>) =>
    doc._id === teamId ||
    doc.teamId === teamId ||
    teamIssueIds.has(String(doc.issueId)) ||
    teamIssueIds.has(String(doc.relatedIssueId));
}

describe("admin.clearTeamContent", () => {
  test("deletes one team's content and the team, and keeps the other team, org rows and the mirror", async () => {
    const { t, cleared, kept } = await setupTeams();
    const contentBefore = await snapshot(t, CONTENT_TABLES);
    const mirrorBefore = await snapshot(t, MIRROR_TABLES);
    const clearedIssueIds = new Set(
      contentBefore.issues.filter((issue) => issue.teamId === cleared.teamId).map((issue) => issue._id)
    );
    const isCleared = belongsToTeam(cleared.teamId, clearedIssueIds);

    const counts = await t.mutation(internal.admin.clearTeamContent, {
      clerkOrgId: TEAM_ORG,
      teamKey: CLEARED_TEAM,
    });

    expect(counts).toEqual({
      issueLabels: 1,
      issueRelations: 2,
      comments: 1,
      activity: 2,
      attachments: 1,
      issues: 2,
      cycles: 1,
      teams: 1,
    });
    const contentAfter = await snapshot(t, CONTENT_TABLES);
    for (const table of CONTENT_TABLES) {
      expect(contentAfter[table], table).toEqual(contentBefore[table].filter((doc) => !isCleared(doc)));
    }
    expect(contentAfter.issues.map((issue) => issue.title)).toEqual(["OPS story", "OPS sub-task"]);
    expect(contentAfter.issueRelations).toHaveLength(1);
    expect(await snapshot(t, MIRROR_TABLES)).toEqual(mirrorBefore);
    const files = await t.run(async (ctx) => ({
      cleared: await ctx.db.system.get(cleared.storageId),
      kept: await ctx.db.system.get(kept.storageId),
    }));
    expect(files.cleared).toBeNull();
    expect(files.kept).not.toBeNull();
  });

  test("finds the team by a lower-case, padded key", async () => {
    const { t, cleared, kept } = await setupTeams();

    const counts = await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: " eng " });

    expect(counts).toMatchObject({ issues: 2, teams: 1 });
    const teams = await t.run(async (ctx) => ({
      cleared: await ctx.db.get(cleared.teamId),
      kept: await ctx.db.get(kept.teamId),
    }));
    expect(teams.cleared).toBeNull();
    expect(teams.kept).not.toBeNull();
  });

  test("refuses an unknown lower-case team with the upper-case key", async () => {
    const { t } = await setupTeams();

    await expect(
      t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: "nope" })
    ).rejects.toThrow("Team NOPE not found");
  });

  test("refuses an unknown team and changes nothing", async () => {
    const { t } = await setupTeams();
    const before = await snapshot(t, [...CONTENT_TABLES, ...MIRROR_TABLES]);

    await expect(
      t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: "NOPE" })
    ).rejects.toThrow("Team NOPE not found");
    expect(await snapshot(t, [...CONTENT_TABLES, ...MIRROR_TABLES])).toEqual(before);
  });

  test("refuses an unknown organization", async () => {
    const { t } = await setupTeams();

    await expect(
      t.mutation(internal.admin.clearTeamContent, { clerkOrgId: "org_missing", teamKey: CLEARED_TEAM })
    ).rejects.toThrow("Organization org_missing not found");
  });
});
