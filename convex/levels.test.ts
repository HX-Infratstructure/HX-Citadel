/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { formatIssueKey } from "../lib/issue-key";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG_CLAIM = "org_test";
const MEMBER_CLERK_ID = "user_member";
const TEAM_KEY = "HXT";

type Kind = "epic" | "feature" | "story" | "subtask";

async function setup() {
  const t = convexTest(schema, modules);
  const { teamId, projectId } = await t.run(async (ctx) => {
    const memberId = await ctx.db.insert("users", {
      clerkId: MEMBER_CLERK_ID,
      name: "Member",
      email: "member@example.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: ORG_CLAIM,
      name: "Test Org",
      slug: "test-org",
    });
    await ctx.db.insert("members", {
      orgId,
      userId: memberId,
      role: "member",
      clerkMembershipId: "mem_member",
    });
    const teamId = await ctx.db.insert("teams", {
      orgId,
      name: "Citadel",
      key: TEAM_KEY,
      nextIssueNumber: 12,
    });
    const projectId = await ctx.db.insert("projects", {
      orgId,
      name: "Phase 2",
      status: "planned",
    });
    return { teamId, projectId };
  });
  const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });

  const create = (
    kind: Kind,
    placement: { parentIssueId?: Id<"issues">; projectId?: Id<"projects"> } = {}
  ) =>
    asMember.mutation(api.issues.create, {
      teamId,
      title: `A ${kind}`,
      kind,
      ...placement,
    });

  const tree = async () => {
    const epic = await create("epic", { projectId });
    const feature = await create("feature", { parentIssueId: epic });
    const story = await create("story", { parentIssueId: feature });
    const subtask = await create("subtask", { parentIssueId: story });
    return { epic, feature, story, subtask };
  };

  const insertOtherProject = () =>
    t.run(async (ctx) => {
      const project = await ctx.db.get(projectId);
      return ctx.db.insert("projects", {
        orgId: project!.orgId,
        name: "Other",
        status: "planned",
      });
    });

  return { t, asMember, teamId, projectId, create, tree, insertOtherProject };
}

describe("issue levels", () => {
  test("accepts each valid parent pair", async () => {
    const { asMember, create, tree } = await setup();
    const ids = await tree();
    const loneStory = await create("story");

    for (const issueId of [...Object.values(ids), loneStory]) {
      expect(await asMember.query(api.issues.get, { issueId })).not.toBeNull();
    }
  });

  test.each<[Kind, keyof Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["tree"]>> | null, string]>([
    ["epic", "feature", "An epic cannot have a parent (got a feature)"],
    ["feature", null, "A feature needs an epic as its parent"],
    ["feature", "story", "A feature's parent must be an epic, not a story"],
    ["story", "epic", "A story's parent must be a feature, not an epic"],
    ["story", "subtask", "A story's parent must be a feature, not a subtask"],
    ["subtask", null, "A subtask needs a story as its parent"],
    ["subtask", "epic", "A subtask's parent must be a story, not an epic"],
    ["subtask", "feature", "A subtask's parent must be a story, not a feature"],
  ])("refuses a %s under %s", async (kind, parentKind, message) => {
    const { create, projectId, tree } = await setup();
    const ids = await tree();
    const parentIssueId = parentKind ? ids[parentKind] : undefined;

    await expect(create(kind, { parentIssueId, projectId })).rejects.toThrow(message);
  });

  test("refuses an epic without a project", async () => {
    const { create } = await setup();

    await expect(create("epic")).rejects.toThrow("An epic needs a project");
  });

  test("numbers a story and its subtasks, and the key helper shows KEY-n.1 and KEY-n.2", async () => {
    const { asMember, create } = await setup();
    const storyId = await create("story");
    const firstId = await create("subtask", { parentIssueId: storyId });
    const secondId = await create("subtask", { parentIssueId: storyId });

    const story = await asMember.query(api.issues.get, { issueId: storyId });
    const first = await asMember.query(api.issues.get, { issueId: firstId });
    const second = await asMember.query(api.issues.get, { issueId: secondId });

    expect(story?.number).toBe(12);
    expect([first?.subNumber, second?.subNumber]).toEqual([1, 2]);
    expect([first?.number, second?.number]).toEqual([undefined, undefined]);
    expect(formatIssueKey(TEAM_KEY, first!, story!.number)).toBe("HXT-12.1");
    expect(formatIssueKey(TEAM_KEY, second!, story!.number)).toBe("HXT-12.2");
  });

  test("does not spend a story number on epics, features or subtasks", async () => {
    const { asMember, create, tree } = await setup();
    await tree();
    const nextStory = await create("story");

    expect((await asMember.query(api.issues.get, { issueId: nextStory }))?.number).toBe(13);
  });

  test("refuses a reparent to a wrong parent", async () => {
    const { asMember, tree } = await setup();
    const { epic, subtask } = await tree();

    await expect(
      asMember.mutation(api.issueRelations.setParent, {
        issueId: subtask,
        parentIssueId: epic,
      })
    ).rejects.toThrow("A subtask's parent must be a story, not an epic");
  });

  test("refuses removing an epic's project", async () => {
    const { asMember, tree } = await setup();
    const { epic } = await tree();

    await expect(
      asMember.mutation(api.issues.update, { issueId: epic, projectId: null })
    ).rejects.toThrow("An epic needs a project");
  });

  test("renumbers a subtask moved to another story", async () => {
    const { asMember, create } = await setup();
    const storyA = await create("story");
    const storyB = await create("story");
    await create("subtask", { parentIssueId: storyB });
    const moving = await create("subtask", { parentIssueId: storyA });

    await asMember.mutation(api.issueRelations.setParent, {
      issueId: moving,
      parentIssueId: storyB,
    });

    expect((await asMember.query(api.issues.get, { issueId: moving }))?.subNumber).toBe(2);
  });

  test.each([
    ["without a project", false],
    ["with a project", true],
  ])("allows a parentless story %s", async (_label, withProject) => {
    const { asMember, create, projectId } = await setup();
    const issueId = await create("story", withProject ? { projectId } : {});

    const story = await asMember.query(api.issues.get, { issueId });
    expect(story?.projectId).toBe(withProject ? projectId : undefined);
  });

  test("a feature, a story under it and its subtask inherit the epic's project", async () => {
    const { asMember, projectId, tree } = await setup();
    const { feature, story, subtask } = await tree();

    for (const issueId of [feature, story, subtask]) {
      expect((await asMember.query(api.issues.get, { issueId }))?.projectId).toBe(projectId);
    }
  });

  test("refuses a story under a feature with a different project", async () => {
    const { create, insertOtherProject, tree } = await setup();
    const { feature } = await tree();
    const otherProject = await insertOtherProject();

    await expect(
      create("story", { parentIssueId: feature, projectId: otherProject })
    ).rejects.toThrow("A story's project must match its feature's project");
  });

  test("refuses a reparent that would mismatch the project", async () => {
    const { asMember, create, insertOtherProject, tree } = await setup();
    const { feature } = await tree();
    const looseStory = await create("story", { projectId: await insertOtherProject() });

    await expect(
      asMember.mutation(api.issueRelations.setParent, {
        issueId: looseStory,
        parentIssueId: feature,
      })
    ).rejects.toThrow("A story's project must match its feature's project");
  });

  test("getByNumber finds the story and ignores subtasks", async () => {
    const { t, asMember, teamId, create } = await setup();
    const storyId = await create("story");
    const subtaskId = await create("subtask", { parentIssueId: storyId });
    await t.run((ctx) => ctx.db.patch(subtaskId, { number: 99 }));

    const found = await asMember.query(api.issues.getByNumber, { teamId, number: 12 });
    const missing = await asMember.query(api.issues.getByNumber, { teamId, number: 99 });

    expect(found?._id).toBe(storyId);
    expect(missing).toBeNull();
  });

  test("a story defaults to kind story and type story", async () => {
    const { asMember, teamId } = await setup();
    const issueId = await asMember.mutation(api.issues.create, { teamId, title: "Quick capture" });

    expect(await asMember.query(api.issues.get, { issueId })).toMatchObject({
      kind: "story",
      type: "story",
    });
  });
});
