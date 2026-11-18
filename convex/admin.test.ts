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
};

const ZERO_COUNTS = Object.fromEntries(CONTENT_TABLES.map((table) => [table, 0]));

async function seedOrg(ctx: MutationCtx & { storage: StorageActionWriter }, clerkOrgId: string) {
  const userId = await ctx.db.insert("users", {
    clerkId: `user_${clerkOrgId}`,
    name: "Owner",
    email: `${clerkOrgId}@example.com`,
  });
  const orgId = await ctx.db.insert("organizations", {
    clerkOrgId,
    name: clerkOrgId,
    slug: clerkOrgId,
    plan: "free",
  });
  await ctx.db.insert("members", {
    orgId,
    userId,
    role: "admin",
    clerkMembershipId: `mem_${clerkOrgId}`,
  });
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

describe("admin.deleteOrgMirror", () => {
  test("refuses while the organization still has content", async () => {
    const { t } = await setup();
    const mirrorBefore = await snapshot(t, MIRROR_TABLES);

    await expect(
      t.mutation(internal.admin.deleteOrgMirror, { clerkOrgId: CLEARED_ORG })
    ).rejects.toThrow("still has teams or issues");
    expect(await snapshot(t, MIRROR_TABLES)).toEqual(mirrorBefore);
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
