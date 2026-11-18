/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG = "org_hx";
const ADMIN = "user_admin";

beforeEach(() => {
  process.env.HX_WORKSPACE_ORG_ID = ORG;
});

afterEach(() => {
  delete process.env.HX_WORKSPACE_ORG_ID;
});

/** Our workspace with one story, and another workspace whose rows point at our story and team. */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG, name: "HX", slug: "hx" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 2 });
    const userId = await ctx.db.insert("users", { clerkId: ADMIN, name: "Admin", email: "admin@example.com" });
    await ctx.db.insert("members", { orgId, userId, role: "admin", clerkMembershipId: "mem_admin" });
    const story = { teamId, kind: "story", status: "todo", priority: "none", creatorId: userId } as const;
    const storyId = await ctx.db.insert("issues", { ...story, orgId, number: 1, title: "Ours", sortOrder: 1 });

    const otherOrgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
    const foreignIssueId = await ctx.db.insert("issues", {
      ...story,
      orgId: otherOrgId,
      number: 1,
      title: "Foreign",
      sortOrder: 2,
    });
    const foreignCycleId = await ctx.db.insert("cycles", {
      orgId: otherOrgId,
      teamId,
      number: 1,
      startDate: 0,
      endDate: Date.now() + 86_400_000,
    });
    const foreign = { orgId: otherOrgId, issueId: storyId };
    const storageId = await ctx.storage.store(new Blob(["foreign"]));
    const rows = {
      decision: await ctx.db.insert("decisions", { ...foreign, askedBy: userId, question: "Foreign?", status: "open" }),
      comment: await ctx.db.insert("comments", { ...foreign, authorId: userId, body: "Foreign comment" }),
      attachment: await ctx.db.insert("attachments", {
        ...foreign,
        storageId,
        fileName: "foreign.txt",
        fileType: "text/plain",
        fileSize: 7,
        uploadedBy: userId,
      }),
      activity: await ctx.db.insert("activity", { ...foreign, actorId: userId, type: "foreign" }),
    };
    return { orgId, teamId, userId, storyId, foreignIssueId, foreignCycleId, rows };
  });
  return { t, admin: t.withIdentity({ subject: ADMIN, org_id: ORG }), ...ids };
}

const comment = (t: Awaited<ReturnType<typeof setup>>["admin"], issueId: Id<"issues">) =>
  t.mutation(api.comments.create, { issueId, body: "Ours" });

describe("rows from another workspace that point at our story", () => {
  test("stay out of the story's decisions, comments, attachments and activity", async () => {
    const { t, admin, storyId } = await setup();
    await t.mutation(internal.agentApi.askDecision, { agentName: "cc1", key: "ENG-1", question: "Ours?" });
    await comment(admin, storyId);

    const decisions = await admin.query(api.decisions.listForIssue, { issueId: storyId });
    const comments = await admin.query(api.comments.listByIssue, { issueId: storyId });
    const attachments = await admin.query(api.attachments.listByIssue, { issueId: storyId });
    const activity = await admin.query(api.activity.listByIssue, { issueId: storyId });

    expect(decisions.map((row) => row.question)).toEqual(["Ours?"]);
    expect(comments.map((row) => row.body)).toEqual(["Ours"]);
    expect(attachments).toEqual([]);
    expect(activity.map((row) => row.type)).not.toContain("foreign");
  });

  test("a foreign open decision does not make the story wait", async () => {
    const { t } = await setup();
    const asked = await t.mutation(internal.agentApi.askDecision, { agentName: "cc1", key: "ENG-1", question: "Ours?" });
    expect(asked.decision).toMatchObject({ question: "Ours?", status: "open" });
  });

  test("removing the story deletes our rows and leaves the foreign rows", async () => {
    const { t, admin, storyId, rows } = await setup();
    await comment(admin, storyId);
    await admin.mutation(api.issues.remove, { issueId: storyId });

    const left = await t.run(async (ctx) => ({
      comments: await ctx.db.query("comments").collect(),
      decision: await ctx.db.get(rows.decision),
      attachment: await ctx.db.get(rows.attachment),
      activity: await ctx.db.get(rows.activity),
    }));
    expect(left.comments.map((row) => row._id)).toEqual([rows.comment]);
    expect(left.decision?._id).toBe(rows.decision);
    expect(left.attachment?._id).toBe(rows.attachment);
    expect(left.activity?._id).toBe(rows.activity);
  });
});

describe("an issue or cycle from another workspace that names our team", () => {
  test("stays out of the team's lists, the backlog, the agent list and the number lookup", async () => {
    const { t, admin, teamId, storyId } = await setup();
    const listed = await admin.query(api.issues.listByTeam, { teamId });
    const backlog = await admin.query(api.issues.listBacklog, { teamId });
    const agentList = await t.query(internal.agentApi.listIssues, { agentName: "cc1", teamKey: "ENG" });
    const byNumber = await admin.query(api.issues.getByNumber, { teamId, number: 1 });
    const cycles = await admin.query(api.cycles.listByTeam, { teamId });

    expect(listed.map((issue) => issue._id)).toEqual([storyId]);
    expect(backlog.map((issue) => issue._id)).toEqual([storyId]);
    expect(agentList.issues.map((issue) => issue.title)).toEqual(["Ours"]);
    expect(byNumber?._id).toBe(storyId);
    expect(cycles).toEqual([]);
  });

  test("does not count toward the assignee's WIP", async () => {
    const { t, admin, userId, storyId, foreignIssueId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(foreignIssueId, { assigneeId: userId, status: "in_progress" });
    });
    await admin.mutation(api.issues.update, { issueId: storyId, assigneeId: userId, status: "in_progress" });
    expect(await t.run(async (ctx) => (await ctx.db.get(storyId))?.status)).toBe("in_progress");
  });

  test("survives clearing our team", async () => {
    const { t, foreignIssueId, foreignCycleId } = await setup();
    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: ORG, teamKey: "ENG" });
    const left = await t.run(async (ctx) => ({
      issue: await ctx.db.get(foreignIssueId),
      cycle: await ctx.db.get(foreignCycleId),
    }));
    expect(left.issue?._id).toBe(foreignIssueId);
    expect(left.cycle?._id).toBe(foreignCycleId);
  });
});
