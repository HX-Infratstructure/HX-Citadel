/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { StorageActionWriter } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { PAGE_SIZE } from "./admin";
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
  "decisions",
  "issues",
  "cycles",
  "labels",
  "views",
  "projects",
  "teams",
  "idempotencyKeys",
] as const satisfies readonly TableNames[];

const MIRROR_TABLES = ["organizations", "users", "members"] as const satisfies readonly TableNames[];

/** The tables with an organization index, which the mirror refusal checks one row of each. */
const ORG_INDEXED_TABLES = ["activity", "decisions", "issues", "labels", "views", "projects", "teams", "idempotencyKeys"];

const SEEDED_COUNTS = {
  issueLabels: 1,
  issueRelations: 1,
  comments: 1,
  activity: 2,
  attachments: 1,
  decisions: 1,
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
  await ctx.db.insert("decisions", { orgId, issueId: firstIssueId, askedBy: userId, question: "Ship?", status: "open" });
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

async function addIssues(t: TestConvex, teamId: Id<"teams">, count: number) {
  await t.run(async (ctx) => {
    const team = (await ctx.db.get(teamId))!;
    const creator = (await ctx.db.query("users").first())!;
    for (let number = 100; number < 100 + count; number++) {
      const issueId = await ctx.db.insert("issues", {
        orgId: team.orgId,
        teamId,
        status: "todo",
        priority: "none",
        creatorId: creator._id,
        kind: "story",
        number,
        title: `bulk ${number}`,
        sortOrder: number,
      });
      await ctx.db.insert("activity", { orgId: team.orgId, issueId, actorId: creator._id, type: "created" });
    }
  });
}

/** Cancels every queued run, as if the scheduled continuation had failed. */
async function cancelScheduledRuns(t: TestConvex) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") {
        await ctx.scheduler.cancel(job._id);
      }
    }
  });
}

/** How each scheduled run ended; a run that threw is `failed`. */
async function scheduledRunStates(t: TestConvex) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return new Set(jobs.map((job) => job.state.kind));
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

  test("deletes one page of issues per run and the scheduled runs delete the rest", async () => {
    vi.useFakeTimers();
    const { t, cleared } = await setup();
    const teamId = await t.run(async (ctx) => (await ctx.db.query("teams").first())!._id);
    await addIssues(t, teamId, PAGE_SIZE);
    const contentBefore = await snapshot(t, CONTENT_TABLES);
    const clearedIssueIds = new Set(
      contentBefore.issues.filter((issue) => issue.orgId === cleared.orgId).map((issue) => issue._id)
    );
    const isCleared = belongsTo(cleared.orgId, clearedIssueIds);

    const counts = await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });

    expect(counts).toMatchObject({ issues: PAGE_SIZE, teams: 0, labels: 0 });
    expect(await t.run((ctx) => ctx.db.get(teamId))).not.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const contentAfter = await snapshot(t, CONTENT_TABLES);
    for (const table of CONTENT_TABLES) {
      expect(contentAfter[table], table).toEqual(contentBefore[table].filter((doc) => !isCleared(doc)));
    }
    expect(await t.run((ctx) => ctx.db.system.get(cleared.storageId))).toBeNull();
    vi.useRealTimers();
  });

  test("a queued run leaves the workspace once its mirror is created again under the same Clerk id", async () => {
    vi.useFakeTimers();
    const { t } = await setup();
    const teamId = await t.run(async (ctx) => (await ctx.db.query("teams").first())!._id);
    await addIssues(t, teamId, PAGE_SIZE);
    await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });
    await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });
    await t.mutation(internal.admin.deleteOrgMirror, { clerkOrgId: CLEARED_ORG });
    await t.run((ctx) => seedOrg(ctx, CLEARED_ORG));
    const before = await snapshot(t, [...CONTENT_TABLES, ...MIRROR_TABLES]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await snapshot(t, [...CONTENT_TABLES, ...MIRROR_TABLES])).toEqual(before);
    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
    vi.useRealTimers();
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
  test("refuses while the organization still has content and names every table with an organization index", async () => {
    const { t } = await setup();

    await expectMirrorRefused(
      t,
      CLEARED_ORG,
      `Organization ${CLEARED_ORG} still has rows in ${ORG_INDEXED_TABLES.join(", ")}.`
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
  await ctx.db.insert("decisions", { orgId, issueId: storyId, askedBy: userId, question: key, status: "open" });
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
  const t = convexTest({ schema, modules, transactionLimits: true });
  const seeded = await t.run(async (ctx) => {
    const { orgId, userId } = await seedMirror(ctx, TEAM_ORG);
    const cleared = await seedTeam(ctx, orgId, userId, CLEARED_TEAM);
    const kept = await seedTeam(ctx, orgId, userId, KEPT_TEAM);
    const labelId = await ctx.db.insert("labels", { orgId, name: "Bug", color: "#ff0000" });
    await ctx.db.insert("issueLabels", { issueId: cleared.storyId, labelId });
    await ctx.db.insert("issueLabels", { issueId: kept.storyId, labelId });
    await ctx.db.insert("issueRelations", {
      issueId: kept.storyId,
      relatedIssueId: cleared.storyId,
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

/** Convex's per-transaction read limit, which one read of every saved view can pass. */
const TRANSACTION_READ_BYTES = 16 * 1024 * 1024;
/** Near the 4096 characters `views.create` accepts. */
const LARGE_FILTER_CHARS = 4000;
/** Rows one test transaction writes or reads, well inside the limits. */
const TEST_BATCH = 1000;

/** Saved-view filters as `serializeSavedView` writes them; `labelChars` pads the label filter. */
function savedView(teamId: Id<"teams">, labelChars = 0) {
  return JSON.stringify({
    v: 1,
    teamId,
    display: "board",
    filters: { statuses: ["todo"], priorities: [], assignees: [], labels: ["x".repeat(labelChars)] },
  });
}

/** Inserts `count` saved views; every third opens the cleared team, the rest the kept one. Returns the third. */
async function insertViews(
  t: TestConvex,
  teams: { cleared: Id<"teams">; kept: Id<"teams"> },
  count: number,
  labelChars: number
) {
  const opensCleared = new Set<Id<"views">>();
  for (let start = 0; start < count; start += TEST_BATCH) {
    await t.run(async (ctx) => {
      const { orgId } = (await ctx.db.get(teams.kept))!;
      const creatorId = (await ctx.db.query("users").first())!._id;
      for (let index = start; index < Math.min(start + TEST_BATCH, count); index++) {
        const teamId = index % 3 === 0 ? teams.cleared : teams.kept;
        const filters = savedView(teamId, labelChars);
        const viewId = await ctx.db.insert("views", { orgId, creatorId, name: `View ${index}`, filters, shared: true });
        if (teamId === teams.cleared) {
          opensCleared.add(viewId);
        }
      }
    });
  }
  return opensCleared;
}

/** Every saved view's id, read in pages so no test transaction passes the read limit. */
async function allViewIds(t: TestConvex) {
  const ids: Id<"views">[] = [];
  let cursor: string | null = null;
  for (let isDone = false; !isDone; ) {
    const page = await t.run((ctx) => ctx.db.query("views").paginate({ cursor, numItems: TEST_BATCH }));
    ids.push(...page.page.map((view) => view._id));
    cursor = page.continueCursor;
    isDone = page.isDone;
  }
  return ids;
}

/** Queues a scheduled run for the cleared team, then a second clear deletes the team before that run. */
async function queueRunThenClearTeam(t: TestConvex, teamId: Id<"teams">) {
  await addIssues(t, teamId, PAGE_SIZE);
  await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
  await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
  expect(await t.run((ctx) => ctx.db.get(teamId))).toBeNull();
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
      decisions: 1,
      issues: 2,
      cycles: 1,
      views: 0,
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

  test("keeps a file that an attachment in the other team still uses", async () => {
    const { t, cleared, kept } = await setupTeams();
    const keptAttachmentId = await t.run(async (ctx) => {
      const keptStory = await ctx.db.get(kept.storyId);
      return ctx.db.insert("attachments", {
        orgId: keptStory!.orgId,
        issueId: kept.storyId,
        storageId: cleared.storageId,
        fileName: "shared.txt",
        fileType: "text/plain",
        fileSize: 3,
        uploadedBy: keptStory!.creatorId,
      });
    });

    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });

    const after = await t.run(async (ctx) => ({
      file: await ctx.db.system.get(cleared.storageId),
      keptAttachment: await ctx.db.get(keptAttachmentId),
    }));
    expect(after.file).not.toBeNull();
    expect(after.keptAttachment).not.toBeNull();
  });

  test("clears a team larger than one page over the scheduled runs", async () => {
    vi.useFakeTimers();
    const { t, cleared, kept } = await setupTeams();
    await addIssues(t, cleared.teamId, 600);
    const contentBefore = await snapshot(t, CONTENT_TABLES);
    const clearedIssueIds = new Set(
      contentBefore.issues.filter((issue) => issue.teamId === cleared.teamId).map((issue) => issue._id)
    );
    const isCleared = belongsToTeam(cleared.teamId, clearedIssueIds);

    const counts = await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });

    expect(counts).toMatchObject({ issues: PAGE_SIZE, cycles: 0, teams: 0 });
    expect(await t.run((ctx) => ctx.db.get(cleared.teamId))).not.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const contentAfter = await snapshot(t, CONTENT_TABLES);
    for (const table of CONTENT_TABLES) {
      expect(contentAfter[table], table).toEqual(contentBefore[table].filter((doc) => !isCleared(doc)));
    }
    expect(await t.run((ctx) => ctx.db.get(kept.teamId))).not.toBeNull();
    vi.useRealTimers();
  });

  test("a rerun after a scheduled run failed finishes the clear", async () => {
    vi.useFakeTimers();
    const { t, cleared } = await setupTeams();
    await addIssues(t, cleared.teamId, PAGE_SIZE + 5);
    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await cancelScheduledRuns(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = () =>
      t.run(async (ctx) => ({
        team: await ctx.db.get(cleared.teamId),
        issues: await ctx.db.query("issues").withIndex("by_team", (q) => q.eq("teamId", cleared.teamId)).collect(),
      }));
    expect((await left()).team).not.toBeNull();
    expect((await left()).issues.length).toBeGreaterThan(0);

    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await left()).toEqual({ team: null, issues: [] });
    vi.useRealTimers();
  });

  test("a queued run for a team that is already gone stops without error", async () => {
    vi.useFakeTimers();
    const { t, cleared } = await setupTeams();
    await queueRunThenClearTeam(t, cleared.teamId);
    const before = await snapshot(t, CONTENT_TABLES);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
    expect(await snapshot(t, CONTENT_TABLES)).toEqual(before);
    vi.useRealTimers();
  });

  test("a queued run leaves a new team created with the cleared team's key", async () => {
    vi.useFakeTimers();
    const { t, cleared, kept } = await setupTeams();
    await queueRunThenClearTeam(t, cleared.teamId);
    const newTeamId = await t.run(async (ctx) => {
      const { orgId } = (await ctx.db.get(kept.teamId))!;
      const teamId = await ctx.db.insert("teams", { orgId, name: CLEARED_TEAM, key: CLEARED_TEAM, nextIssueNumber: 1 });
      const creatorId = (await ctx.db.query("users").first())!._id;
      await ctx.db.insert("views", { orgId, creatorId, name: "New board", filters: savedView(teamId), shared: true });
      return teamId;
    });
    await addIssues(t, newTeamId, 3);
    const before = await snapshot(t, CONTENT_TABLES);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await snapshot(t, CONTENT_TABLES)).toEqual(before);
    vi.useRealTimers();
  });

  test("checks every saved view a page per run, deletes those that open the team and keeps the rest", async () => {
    vi.useFakeTimers();
    const { t, cleared, kept } = await setupTeams();
    const teams = { cleared: cleared.teamId, kept: kept.teamId };
    const viewCount = Math.ceil(TRANSACTION_READ_BYTES / LARGE_FILTER_CHARS) + PAGE_SIZE;
    const opensCleared = await insertViews(t, teams, viewCount, LARGE_FILTER_CHARS);
    const idsBefore = await allViewIds(t);

    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await allViewIds(t)).toEqual(idsBefore.filter((id) => !opensCleared.has(id)));
    expect(await t.run((ctx) => ctx.db.get(cleared.teamId))).toBeNull();
    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
    vi.useRealTimers();
  });

  test("a rerun after a scheduled run failed in the saved-view scan finishes the clear", async () => {
    vi.useFakeTimers();
    const { t, cleared, kept } = await setupTeams();
    const opensCleared = await insertViews(t, { cleared: cleared.teamId, kept: kept.teamId }, PAGE_SIZE * 2 + 10, 0);
    const idsBefore = await allViewIds(t);
    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await cancelScheduledRuns(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(cleared.teamId))).not.toBeNull();

    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await allViewIds(t)).toEqual(idsBefore.filter((id) => !opensCleared.has(id)));
    expect(await t.run((ctx) => ctx.db.get(cleared.teamId))).toBeNull();
    vi.useRealTimers();
  });

  test("leaves another workspace's rows that point at a cleared issue", async () => {
    const { t, cleared } = await setupTeams();
    const foreign = await t.run(async (ctx) => {
      const { orgId, userId } = await seedMirror(ctx, "org_foreign");
      const issueId = cleared.storyId;
      return [
        await ctx.db.insert("comments", { orgId, issueId, authorId: userId, body: "foreign" }),
        await ctx.db.insert("activity", { orgId, issueId, actorId: userId, type: "commented" }),
        await ctx.db.insert("decisions", { orgId, issueId, askedBy: userId, question: "foreign", status: "open" }),
        await ctx.db.insert("attachments", {
          orgId,
          issueId,
          storageId: cleared.storageId,
          fileName: "foreign.txt",
          fileType: "text/plain",
          fileSize: 3,
          uploadedBy: userId,
        }),
      ];
    });

    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });

    const after = await t.run(async (ctx) => ({
      rows: await Promise.all(foreign.map((id) => ctx.db.get(id))),
      file: await ctx.db.system.get(cleared.storageId),
    }));
    expect(after.rows.every((row) => row !== null)).toBe(true);
    expect(after.file).not.toBeNull();
  });

  test("deletes the saved views that open the cleared team and keeps the others", async () => {
    const { t, cleared, kept } = await setupTeams();
    const viewIds = await t.run(async (ctx) => {
      const keptStory = (await ctx.db.get(kept.storyId))!;
      const view = (name: string, filters: string) =>
        ctx.db.insert("views", { orgId: keptStory.orgId, creatorId: keptStory.creatorId, name, filters, shared: true });
      return {
        clearedTeam: await view("Cleared board", savedView(cleared.teamId)),
        keptTeam: await view("Kept board", savedView(kept.teamId)),
        notAView: await view("Null", "null"),
      };
    });

    const counts = await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });

    expect(counts.views).toBe(1);
    const views = await t.run(async (ctx) => ({
      clearedTeam: await ctx.db.get(viewIds.clearedTeam),
      keptTeam: await ctx.db.get(viewIds.keptTeam),
      notAView: await ctx.db.get(viewIds.notAView),
      all: await ctx.db.query("views").collect(),
    }));
    expect(views.clearedTeam).toBeNull();
    expect(views.keptTeam).not.toBeNull();
    expect(views.notAView).not.toBeNull();
    expect(views.all).toHaveLength(3);
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

describe("admin.backfillSubCounters", () => {
  test("gives each story without a counter its highest sub-task number + 1, and a rerun changes nothing", async () => {
    const { t, cleared } = await setup();
    const storyIds = await t.run(async (ctx) => {
      const stories = await ctx.db.query("issues").collect();
      const [withSubtask, withCounter] = stories.filter((story) => story.orgId === cleared.orgId);
      await ctx.db.insert("issues", {
        orgId: withSubtask.orgId,
        teamId: withSubtask.teamId,
        kind: "subtask",
        parentIssueId: withSubtask._id,
        subNumber: 4,
        title: "Sub-task",
        status: "todo",
        priority: "none",
        creatorId: withSubtask.creatorId,
        sortOrder: 3,
      });
      await ctx.db.patch(withCounter._id, { nextSubNumber: 7 });
      return stories.map((story) => story._id);
    });
    const counters = () =>
      t.run(async (ctx) => Promise.all(storyIds.map(async (id) => (await ctx.db.get(id))?.nextSubNumber)));

    expect(await t.mutation(internal.admin.backfillSubCounters, {})).toBe(3);
    expect(await counters()).toEqual([5, 7, 1, 1]);
    expect(await t.mutation(internal.admin.backfillSubCounters, {})).toBe(0);
    expect(await counters()).toEqual([5, 7, 1, 1]);
  });

  test("sets one page of stories per run and the scheduled runs set the rest", async () => {
    vi.useFakeTimers();
    const { t, cleared } = await setup();
    await t.run(async (ctx) => {
      const story = (await ctx.db.query("issues").collect()).find((issue) => issue.orgId === cleared.orgId)!;
      for (let index = 0; index < PAGE_SIZE; index++) {
        await ctx.db.insert("issues", {
          orgId: story.orgId,
          teamId: story.teamId,
          kind: "story",
          number: 3 + index,
          title: `Story ${index}`,
          status: "todo",
          priority: "none",
          creatorId: story.creatorId,
          sortOrder: index,
        });
      }
    });
    const counters = () =>
      t.run(async (ctx) => (await ctx.db.query("issues").collect()).map((issue) => issue.nextSubNumber ?? null));

    expect(await t.mutation(internal.admin.backfillSubCounters, {})).toBe(PAGE_SIZE);
    expect((await counters()).filter((counter) => counter === null)).toHaveLength(4);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await counters()).toEqual(Array(PAGE_SIZE + 4).fill(1));
    vi.useRealTimers();
  });
});
