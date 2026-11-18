/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { Id, TableNames } from "./_generated/dataModel";
import { MAX_CHILDREN } from "./lib/orgRows";
import schema from "./schema";
import { ORG, registerWorkspaceEnv } from "./workspace.fixture";

const modules = import.meta.glob("./**/*.*s");

const ADMIN = "user_admin";

registerWorkspaceEnv();

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

    const decisions = (await admin.query(api.decisions.listForIssue, { issueId: storyId, paginationOpts: { cursor: null, numItems: 50 } })).page;
    const comments = await admin.query(api.comments.listByIssue, { issueId: storyId });
    const attachments = (await admin.query(api.attachments.listByIssue, { issueId: storyId, paginationOpts: { cursor: null, numItems: 50 } })).page;
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

type Setup = Awaited<ReturnType<typeof setup>>;
type RunCtx = Parameters<Parameters<Setup["t"]["run"]>[0]>[0];
type Seed<T extends TableNames> = (ctx: RunCtx, orgId: Id<"organizations">, s: Setup) => Promise<Id<T>>;

const refusalOf = (error: unknown) => (error instanceof ConvexError ? error.data : error);

/** One site that loads a row by id: what it refuses with, how to write such a row, and the call that loads it. */
function loader<T extends TableNames>(label: string, site: string, seed: Seed<T>, call: (s: Setup, id: Id<T>) => Promise<unknown>) {
  return {
    name: `${site} (${label})`,
    label,
    refusals: async (s: Setup) => {
      const { foreign, missing } = await s.t.run(async (ctx) => {
        const otherOrgId = (await ctx.db.get(s.foreignIssueId))!.orgId;
        const foreign = await seed(ctx, otherOrgId, s);
        const missing = await seed(ctx, s.orgId, s);
        await ctx.db.delete(missing);
        return { foreign, missing };
      });
      return [await call(s, foreign).catch(refusalOf), await call(s, missing).catch(refusalOf)];
    },
  };
}

const team: Seed<"teams"> = (ctx, orgId) => ctx.db.insert("teams", { orgId, name: "Other", key: "OTH", nextIssueNumber: 1 });
const project: Seed<"projects"> = (ctx, orgId) => ctx.db.insert("projects", { orgId, name: "Other", status: "planned" });
const cycle: Seed<"cycles"> = (ctx, orgId, s) =>
  ctx.db.insert("cycles", { orgId, teamId: s.teamId, number: 9, startDate: 0, endDate: 1 });
const onStory = (orgId: Id<"organizations">, s: Setup) => ({ orgId, issueId: s.storyId });

const LOADERS = [
  loader("Team", "issues.listByTeam", team, (s, teamId) => s.admin.query(api.issues.listByTeam, { teamId })),
  loader("Team", "issues.listBacklog", team, (s, teamId) => s.admin.query(api.issues.listBacklog, { teamId })),
  loader("Team", "issues.listParentCandidates", team, (s, teamId) =>
    s.admin.query(api.issues.listParentCandidates, { teamId, kind: "story" })
  ),
  loader("Team", "issues.create", team, (s, teamId) => s.admin.mutation(api.issues.create, { teamId, title: "New" })),
  loader("Team", "search.issues", team, (s, teamId) => s.admin.query(api.search.issues, { query: "Ours", teamId })),
  loader("Team", "views.teamIssueLabels", team, (s, teamId) => s.admin.query(api.views.teamIssueLabels, { teamId })),
  loader("Team", "cycles.listByTeam", team, (s, teamId) => s.admin.query(api.cycles.listByTeam, { teamId })),
  loader("Project", "projects.listIssues", project, (s, projectId) => s.admin.query(api.projects.listIssues, { projectId })),
  loader("Project", "issues.create epic", project, (s, projectId) =>
    s.admin.mutation(api.issues.create, { teamId: s.teamId, title: "Epic", kind: "epic", projectId })
  ),
  loader("Cycle", "cycles.listIssues", cycle, (s, cycleId) => s.admin.query(api.cycles.listIssues, { cycleId })),
  loader("Cycle", "issues.update cycleId", cycle, (s, cycleId) =>
    s.admin.mutation(api.issues.update, { issueId: s.storyId, cycleId })
  ),
  loader(
    "Comment",
    "comments.update",
    (ctx, orgId, s) => ctx.db.insert("comments", { ...onStory(orgId, s), authorId: s.userId, body: "Hi" }),
    (s, commentId) => s.admin.mutation(api.comments.update, { commentId, body: "Edited" })
  ),
  loader(
    "Decision",
    "decisions.answer",
    (ctx, orgId, s) =>
      ctx.db.insert("decisions", { ...onStory(orgId, s), askedBy: s.userId, question: "Which?", status: "open" }),
    (s, decisionId) => s.admin.mutation(api.decisions.answer, { decisionId, text: "This" })
  ),
  loader(
    "Label",
    "labels.toggleOnIssue",
    (ctx, orgId) => ctx.db.insert("labels", { orgId, name: "Bug", color: "#ff0000" }),
    (s, labelId) => s.admin.mutation(api.labels.toggleOnIssue, { issueId: s.storyId, labelId })
  ),
  loader(
    "View",
    "views.update",
    (ctx, orgId, s) => ctx.db.insert("views", { orgId, creatorId: s.userId, name: "Mine", filters: "{}", shared: false }),
    (s, viewId) => s.admin.mutation(api.views.update, { viewId, name: "Renamed" })
  ),
  loader(
    "Attachment",
    "attachments.remove",
    async (ctx, orgId, s) =>
      ctx.db.insert("attachments", {
        ...onStory(orgId, s),
        storageId: await ctx.storage.store(new Blob(["x"])),
        fileName: "x.txt",
        fileType: "text/plain",
        fileSize: 1,
        uploadedBy: s.userId,
      }),
    (s, attachmentId) => s.admin.mutation(api.attachments.remove, { attachmentId })
  ),
  loader(
    "Change",
    "issues.revertChange",
    (ctx, orgId, s) =>
      ctx.db.insert("activity", { ...onStory(orgId, s), actorId: s.userId, type: "title_changed", field: "title" }),
    (s, activityId) => s.admin.mutation(api.issues.revertChange, { activityId })
  ),
  loader(
    "Issue",
    "issues.update",
    (ctx, orgId, s) =>
      ctx.db.insert("issues", {
        orgId,
        teamId: s.teamId,
        kind: "story",
        title: "Other",
        status: "todo",
        priority: "none",
        creatorId: s.userId,
        sortOrder: 3,
      }),
    (s, issueId) => s.admin.mutation(api.issues.update, { issueId, title: "Renamed" })
  ),
];

describe("a row loaded by id", () => {
  test.each(LOADERS)("$name is not found when missing or in another workspace", async ({ label, refusals }) => {
    const notFound = { code: "not_found", message: `${label} not found` };
    expect(await refusals(await setup())).toEqual([notFound, notFound]);
  });

  test("a label from another workspace linked to our story is not listed", async () => {
    const { t, admin, storyId, foreignIssueId } = await setup();
    await t.run(async (ctx) => {
      const otherOrgId = (await ctx.db.get(foreignIssueId))!.orgId;
      const foreignLabel = await ctx.db.insert("labels", { orgId: otherOrgId, name: "Foreign", color: "#000000" });
      await ctx.db.insert("issueLabels", { issueId: storyId, labelId: foreignLabel });
    });
    const ourLabel = await admin.mutation(api.labels.create, { name: "Ours", color: "#ffffff" });
    await admin.mutation(api.labels.toggleOnIssue, { issueId: storyId, labelId: ourLabel });

    const labels = await admin.query(api.labels.listForIssue, { issueId: storyId });
    expect(labels.map((label) => label.name)).toEqual(["Ours"]);
  });
});

/** Sub-tasks of our story, written in our workspace or in another one. */
async function addSubtasks(s: Setup, orgId: Id<"organizations">, count: number) {
  await s.t.run(async (ctx) => {
    for (let subNumber = 1; subNumber <= count; subNumber++) {
      await ctx.db.insert("issues", {
        orgId,
        teamId: s.teamId,
        kind: "subtask",
        parentIssueId: s.storyId,
        subNumber,
        title: `Sub ${subNumber}`,
        status: "todo",
        priority: "none",
        creatorId: s.userId,
        sortOrder: subNumber,
      });
    }
    await ctx.db.patch(s.storyId, { nextSubNumber: count + 1 });
  });
}

const otherOrgOf = (s: Setup) => s.t.run(async (ctx) => (await ctx.db.get(s.foreignIssueId))!.orgId);

const READS_OF_CHILDREN: { name: string; call: (s: Setup) => Promise<unknown> }[] = [
  { name: "the hierarchy panel", call: (s) => s.admin.query(api.issueRelations.hierarchy, { issueId: s.storyId }) },
  { name: "the Done gate", call: (s) => s.admin.mutation(api.issues.update, { issueId: s.storyId, status: "done" }) },
  {
    name: "the project cascade",
    call: async (s) => {
      const projectId = await s.t.run((ctx) => ctx.db.insert("projects", { orgId: s.orgId, name: "New", status: "planned" }));
      return await s.admin.mutation(api.issues.update, { issueId: s.storyId, projectId });
    },
  },
  { name: "the delete", call: (s) => s.admin.mutation(api.issues.remove, { issueId: s.storyId }) },
];

describe("an issue's children", () => {
  test(`up to ${MAX_CHILDREN} are read, and rows from another workspace that point at the issue do not count`, async () => {
    const s = await setup();
    await addSubtasks(s, s.orgId, MAX_CHILDREN);
    await addSubtasks(s, await otherOrgOf(s), 3);

    const { subIssues } = await s.admin.query(api.issueRelations.hierarchy, { issueId: s.storyId });
    expect(subIssues).toHaveLength(MAX_CHILDREN);
  });

  test.each(READS_OF_CHILDREN)(`more than ${MAX_CHILDREN} are refused by $name, naming the parent, and none is dropped`, async ({ call }) => {
    const s = await setup();
    await addSubtasks(s, s.orgId, MAX_CHILDREN + 1);

    const refused = await call(s).catch(refusalOf);
    const children = await s.t.run(async (ctx) =>
      (await ctx.db.query("issues").collect()).filter((issue) => issue.parentIssueId === s.storyId)
    );
    expect(refused).toEqual({ code: "rule_refused", message: expect.stringContaining(s.storyId) });
    expect(children).toHaveLength(MAX_CHILDREN + 1);
  });

  const newSubtask = (s: Setup) =>
    s.admin.mutation(api.issues.create, { teamId: s.teamId, title: "One more", kind: "subtask", parentIssueId: s.storyId });

  const childCount = (s: Setup) =>
    s.t.run(async (ctx) => (await ctx.db.query("issues").collect()).filter((issue) => issue.parentIssueId === s.storyId).length);

  test(`a story with ${MAX_CHILDREN - 1} sub-tasks takes one more`, async () => {
    const s = await setup();
    await addSubtasks(s, s.orgId, MAX_CHILDREN - 1);

    await newSubtask(s);
    expect(await childCount(s)).toBe(MAX_CHILDREN);
  });

  test(`a story with ${MAX_CHILDREN} sub-tasks refuses a new one, naming the story, and writes nothing`, async () => {
    const s = await setup();
    await addSubtasks(s, s.orgId, MAX_CHILDREN);

    const refused = await newSubtask(s).catch(refusalOf);
    expect(refused).toEqual({ code: "rule_refused", message: expect.stringContaining("ENG-1") });
    expect(await childCount(s)).toBe(MAX_CHILDREN);
  });

  test(`a story with ${MAX_CHILDREN} sub-tasks refuses one moved in, and the moved one stays where it was`, async () => {
    const s = await setup();
    await addSubtasks(s, s.orgId, MAX_CHILDREN);
    const otherStory = await s.admin.mutation(api.issues.create, { teamId: s.teamId, title: "Other story" });
    const moving = await s.admin.mutation(api.issues.create, {
      teamId: s.teamId,
      title: "Moving",
      kind: "subtask",
      parentIssueId: otherStory,
    });

    const refused = await s.admin
      .mutation(api.issueRelations.setParent, { issueId: moving, parentIssueId: s.storyId })
      .catch(refusalOf);
    expect(refused).toEqual({ code: "rule_refused", message: expect.stringContaining("ENG-1") });
    expect(await childCount(s)).toBe(MAX_CHILDREN);
    expect(await s.t.run(async (ctx) => (await ctx.db.get(moving))?.parentIssueId)).toBe(otherStory);
  });
});
