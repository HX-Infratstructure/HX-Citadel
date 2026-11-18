/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG_CLAIM = "org_test";
const MEMBER_CLERK_ID = "user_member";

type Kind = "feature" | "story" | "subtask";

async function setup() {
  const t = convexTest(schema, modules);
  const { orgId, teamId, memberId, labelId } = await t.run(async (ctx) => {
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
    const labelId = await ctx.db.insert("labels", { orgId, name: "backend", color: "#000000" });
    return { orgId, teamId, memberId, labelId };
  });
  const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });

  const create = (kind: Kind, parentIssueId?: Id<"issues">) =>
    asMember.mutation(api.issues.create, { teamId, title: `A ${kind}`, kind, parentIssueId });

  const remove = (issueId: Id<"issues">) => asMember.mutation(api.issues.remove, { issueId });

  const addOwnedRows = (issueId: Id<"issues">) =>
    t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["proof"]));
      await ctx.db.insert("comments", { orgId, issueId, authorId: memberId, body: "a comment" });
      await ctx.db.insert("decisions", { orgId, issueId, askedBy: memberId, question: "Ship?", status: "open" });
      await ctx.db.insert("activity", { orgId, issueId, actorId: memberId, type: "commented" });
      await ctx.db.insert("attachments", {
        orgId,
        issueId,
        storageId,
        fileName: "proof.txt",
        fileType: "text/plain",
        fileSize: 5,
        uploadedBy: memberId,
      });
      await ctx.db.insert("issueLabels", { issueId, labelId });
      return storageId;
    });

  const relate = (issueId: Id<"issues">, relatedIssueId: Id<"issues">) =>
    t.run((ctx) =>
      ctx.db.insert("issueRelations", { issueId, relatedIssueId, type: "related" })
    );

  const ownedRowCounts = (issueId: Id<"issues">) =>
    t.run(async (ctx) => {
      const count = async <T>(rows: Promise<T[]>) => (await rows).length;
      return {
        comments: await count(
          ctx.db.query("comments").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        activity: await count(
          ctx.db.query("activity").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        attachments: await count(
          ctx.db.query("attachments").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        decisions: await count(
          ctx.db.query("decisions").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        issueLabels: await count(
          ctx.db.query("issueLabels").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        relationsAsSource: await count(
          ctx.db.query("issueRelations").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        relationsAsTarget: await count(
          ctx.db
            .query("issueRelations")
            .withIndex("by_related", (q) => q.eq("relatedIssueId", issueId))
            .collect()
        ),
      };
    });

  const storedFile = (storageId: Id<"_storage">) => t.run((ctx) => ctx.db.system.get(storageId));

  const childDeletedRows = (parentId: Id<"issues">) =>
    t.run(async (ctx) => {
      const rows = await ctx.db
        .query("activity")
        .withIndex("by_issue", (q) => q.eq("issueId", parentId))
        .collect();
      return rows.filter((row) => row.type === "child_deleted");
    });

  return { create, remove, addOwnedRows, relate, ownedRowCounts, storedFile, childDeletedRows };
}

const NONE = {
  comments: 0,
  activity: 0,
  attachments: 0,
  decisions: 0,
  issueLabels: 0,
  relationsAsSource: 0,
  relationsAsTarget: 0,
};

describe("issues.remove leaves nothing behind", () => {
  test("a story and its sub-task lose every owned row and stored file", async () => {
    const { create, remove, addOwnedRows, relate, ownedRowCounts, storedFile } = await setup();
    const storyId = await create("story");
    const subtaskId = await create("subtask", storyId);
    const otherId = await create("story");
    const storyFile = await addOwnedRows(storyId);
    const subtaskFile = await addOwnedRows(subtaskId);
    await relate(storyId, otherId);
    await relate(subtaskId, otherId);

    await remove(storyId);

    expect(await ownedRowCounts(storyId)).toEqual(NONE);
    expect(await ownedRowCounts(subtaskId)).toEqual(NONE);
    expect(await storedFile(storyFile)).toBeNull();
    expect(await storedFile(subtaskFile)).toBeNull();
  });

  test("a relation where the deleted issue is the target goes too", async () => {
    const { create, remove, relate, ownedRowCounts } = await setup();
    const sourceId = await create("story");
    const targetId = await create("story");
    await relate(sourceId, targetId);

    await remove(targetId);

    expect((await ownedRowCounts(sourceId)).relationsAsSource).toBe(0);
  });

  test("another issue's comments, labels and relations are untouched", async () => {
    const { create, remove, addOwnedRows, relate, ownedRowCounts, storedFile } = await setup();
    const deletedId = await create("story");
    const keptId = await create("story");
    const thirdId = await create("story");
    await addOwnedRows(deletedId);
    const keptFile = await addOwnedRows(keptId);
    await relate(keptId, thirdId);
    await relate(thirdId, keptId);
    const before = await ownedRowCounts(keptId);

    await remove(deletedId);

    expect(await ownedRowCounts(keptId)).toEqual(before);
    expect(before.comments).toBe(1);
    expect(before.issueLabels).toBe(1);
    expect(before.relationsAsSource).toBe(1);
    expect(before.relationsAsTarget).toBe(1);
    expect(await storedFile(keptFile)).not.toBeNull();
  });

  test("the parent's child_deleted row survives deleting a sub-task", async () => {
    const { create, remove, addOwnedRows, ownedRowCounts, childDeletedRows } = await setup();
    const storyId = await create("story");
    const subtaskId = await create("subtask", storyId);
    await addOwnedRows(subtaskId);

    await remove(subtaskId);

    expect(await ownedRowCounts(subtaskId)).toEqual(NONE);
    expect(await childDeletedRows(storyId)).toHaveLength(1);
  });
});
