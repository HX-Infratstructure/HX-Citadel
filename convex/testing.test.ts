/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG_CLAIM = "org_test";
const MEMBER_CLERK_ID = "user_member";

type Kind = "epic" | "feature" | "story" | "subtask";
type StoryType = "story" | "bug" | "chore";

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
      key: "HXT",
      nextIssueNumber: 7,
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
    extra: { parentIssueId?: Id<"issues">; projectId?: Id<"projects">; type?: StoryType } = {}
  ) => asMember.mutation(api.issues.create, { teamId, title: `A ${kind}`, kind, ...extra });

  const children = (parentIssueId: Id<"issues">) =>
    t.run((ctx) =>
      ctx.db
        .query("issues")
        .withIndex("by_parent", (q) => q.eq("parentIssueId", parentIssueId))
        .collect()
    );

  const testingSubtaskOf = async (storyId: Id<"issues">) => {
    const testing = (await children(storyId)).filter((child) => child.testing);
    expect(testing).toHaveLength(1);
    return testing[0];
  };

  const setProof = (issueId: Id<"issues">, proofUrl: string) =>
    asMember.mutation(api.issues.setProof, { issueId, proofUrl });

  return { t, asMember, create, children, testingSubtaskOf, setProof, projectId };
}

describe("Complete testing sub-task", () => {
  test("a new story gets exactly one testing subtask numbered KEY-n.1", async () => {
    const { t, create, testingSubtaskOf } = await setup();
    const storyId = await create("story");
    const story = await t.run((ctx) => ctx.db.get(storyId));
    const testing = await testingSubtaskOf(storyId);

    expect(story?.number).toBe(7);
    expect(testing).toMatchObject({
      kind: "subtask",
      testing: true,
      title: "Complete testing",
      subNumber: 1,
      teamId: story?.teamId,
      status: "todo",
    });
  });

  test.each<StoryType>(["bug", "chore"])("a %s story gets one too", async (type) => {
    const { create, testingSubtaskOf } = await setup();
    const storyId = await create("story", { type });
    await testingSubtaskOf(storyId);
  });

  test("the next subtask under the story is KEY-n.2", async () => {
    const { t, create } = await setup();
    const storyId = await create("story");
    const subtaskId = await create("subtask", { parentIssueId: storyId });
    const subtask = await t.run((ctx) => ctx.db.get(subtaskId));
    expect(subtask?.subNumber).toBe(2);
    expect(subtask?.testing).toBeUndefined();
  });

  test("epics, features and subtasks get no testing subtask", async () => {
    const { create, children, projectId } = await setup();
    const epic = await create("epic", { projectId });
    const feature = await create("feature", { parentIssueId: epic });
    const story = await create("story", { parentIssueId: feature });
    const subtask = await create("subtask", { parentIssueId: story });

    expect(await children(epic)).toHaveLength(1);
    expect(await children(feature)).toHaveLength(1);
    expect(await children(subtask)).toHaveLength(0);
  });

  test("deleting the testing subtask is refused", async () => {
    const { asMember, create, testingSubtaskOf } = await setup();
    const testing = await testingSubtaskOf(await create("story"));
    await expect(
      asMember.mutation(api.issues.remove, { issueId: testing._id })
    ).rejects.toThrow("The Complete testing sub-task can't be deleted");
  });

  test("moving the testing subtask is refused", async () => {
    const { asMember, create, testingSubtaskOf } = await setup();
    const testing = await testingSubtaskOf(await create("story"));
    const otherStory = await create("story");
    await expect(
      asMember.mutation(api.issueRelations.setParent, {
        issueId: testing._id,
        parentIssueId: otherStory,
      })
    ).rejects.toThrow("The Complete testing sub-task can't be moved");
  });

  test.each(["https://example.com/x", "http://192.168.50.207:8460/"])(
    "setProof stores %s",
    async (proofUrl) => {
      const { t, create, testingSubtaskOf, setProof } = await setup();
      const testing = await testingSubtaskOf(await create("story"));
      await setProof(testing._id, proofUrl);
      const saved = await t.run((ctx) => ctx.db.get(testing._id));
      expect(saved?.proofUrl).toBe(proofUrl);
    }
  );

  test.each([
    "javascript:alert(1)",
    "ftp://example.com/file",
    "/runs/42",
    "https//missing-colon",
    "http:foo",
    "https://",
  ])(
    "setProof refuses %s",
    async (proofUrl) => {
      const { create, testingSubtaskOf, setProof } = await setup();
      const testing = await testingSubtaskOf(await create("story"));
      await expect(setProof(testing._id, proofUrl)).rejects.toThrow(
        "The proof must be an absolute http:// or https:// URL"
      );
    }
  );

  test("setProof refuses an issue that is not a testing subtask", async () => {
    const { create, setProof } = await setup();
    const storyId = await create("story");
    const subtaskId = await create("subtask", { parentIssueId: storyId });
    await expect(setProof(storyId, "https://example.com")).rejects.toThrow(
      "Only the Complete testing sub-task holds a proof URL"
    );
    await expect(setProof(subtaskId, "https://example.com")).rejects.toThrow(
      "Only the Complete testing sub-task holds a proof URL"
    );
  });

  test("an empty proof clears it", async () => {
    const { t, create, testingSubtaskOf, setProof } = await setup();
    const testing = await testingSubtaskOf(await create("story"));
    await setProof(testing._id, "https://example.com/run/42");
    await setProof(testing._id, "");
    const saved = await t.run((ctx) => ctx.db.get(testing._id));
    expect(saved?.proofUrl).toBeUndefined();
  });

  test("deleting the story removes its subtasks, the testing one included", async () => {
    const { t, asMember, create, children } = await setup();
    const storyId = await create("story");
    await create("subtask", { parentIssueId: storyId });
    expect(await children(storyId)).toHaveLength(2);

    await asMember.mutation(api.issues.remove, { issueId: storyId });

    expect(await t.run((ctx) => ctx.db.get(storyId))).toBeNull();
    expect(await children(storyId)).toHaveLength(0);
  });
});
