/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG_CLAIM = "org_test";

async function setup() {
  const t = convexTest(schema, modules);
  const { orgId, teamId, ownerId, memberId } = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", { clerkId: "user_owner", name: "Owner", email: "o@example.com" });
    const memberId = await ctx.db.insert("users", { clerkId: "user_member", name: "Member", email: "m@example.com" });
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG_CLAIM, name: "Test Org", slug: "test-org" });
    await ctx.db.insert("members", { orgId, userId: ownerId, role: "admin", clerkMembershipId: "mem_owner" });
    await ctx.db.insert("members", { orgId, userId: memberId, role: "member", clerkMembershipId: "mem_member" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
    return { orgId, teamId, ownerId, memberId };
  });
  const asOwner = t.withIdentity({ subject: "user_owner", org_id: ORG_CLAIM });
  const asMember = t.withIdentity({ subject: "user_member", org_id: ORG_CLAIM });
  const issue = (issueId: Id<"issues">) => t.run(async (ctx) => (await ctx.db.get(issueId))!);
  const issueCount = () => t.run(async (ctx) => (await ctx.db.query("issues").collect()).length);
  const feed = (issueId: Id<"issues">) =>
    t.run(async (ctx) =>
      ctx.db
        .query("activity")
        .withIndex("by_issue", (q) => q.eq("issueId", issueId))
        .collect()
    );
  const lastChange = async (issueId: Id<"issues">, type: string) =>
    (await feed(issueId)).filter((row) => row.type === type).at(-1)!._id;
  const revert = (activityId: Id<"activity">) => asOwner.mutation(api.issues.revertChange, { activityId });
  const project = (name: string) =>
    t.run(async (ctx) => await ctx.db.insert("projects", { orgId, name, status: "planned" }));
  return { t, orgId, teamId, ownerId, memberId, asOwner, asMember, issue, issueCount, feed, lastChange, revert, project };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const refusalOf = (error: unknown) => (error instanceof ConvexError ? error.data : error);

/** The issue's version and activity row count, which a write that changes nothing must leave as they are. */
async function footprint(s: Setup, issueId: Id<"issues">) {
  return { version: (await s.issue(issueId)).version, rows: (await s.feed(issueId)).length };
}

/**
 * Pins the write branches of `createIssue`, `updateIssue` and `revertChange` that no other test reaches, so moving
 * their bodies out of `convex/issues.ts` can't change them unnoticed. Most pins hold the behaviour as it stood before
 * the split. The two create pins with a missing parent hold the owner-approved change: a missing parent refuses with
 * "Parent issue not found", and only after `assertValidParent`'s kind checks, such as "needs a project".
 */
describe("issue write pins", () => {
  // Catches a create that still reads the parent with its own lookup, which says "Issue not found", instead of only
  // through `assertValidParent`, which says "Parent issue not found"; or one that writes an issue anyway.
  test("create with a missing parent refuses with Parent issue not found", async () => {
    const s = await setup();
    const goneId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Gone" });
    await s.t.run((ctx) => ctx.db.delete(goneId));
    const issuesBefore = await s.issueCount();

    const error = await s.asMember
      .mutation(api.issues.create, { teamId: s.teamId, kind: "subtask", parentIssueId: goneId, title: "Orphan" })
      .catch(refusalOf);

    expect(error).toEqual({ code: "not_found", message: "Parent issue not found" });
    expect(await s.issueCount()).toBe(issuesBefore);
  });

  // Catches an update that stores the title untrimmed, or logs and bumps a padded copy of the same title.
  test("update trims the title", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story" });

    await s.asMember.mutation(api.issues.update, { issueId: storyId, title: "  Renamed  " });

    expect((await s.issue(storyId)).title).toBe("Renamed");
    expect((await s.feed(storyId)).at(-1)).toMatchObject({
      type: "title_changed",
      field: "title",
      oldValue: "Story",
      newValue: "Renamed",
    });
    const before = await footprint(s, storyId);
    await s.asMember.mutation(api.issues.update, { issueId: storyId, title: " Renamed\t" });
    expect(await footprint(s, storyId)).toEqual(before);
  });

  // Catches a description step that writes, logs or bumps the version when the text is unchanged.
  test("update with the same description writes no activity and no version bump", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, {
      teamId: s.teamId,
      title: "Story",
      description: "Notes",
    });
    const before = await footprint(s, storyId);

    await s.asMember.mutation(api.issues.update, { issueId: storyId, description: "Notes" });

    expect(await footprint(s, storyId)).toEqual(before);
    expect((await s.issue(storyId)).description).toBe("Notes");
  });

  // Catches a priority step that writes, logs or bumps the version when the priority is unchanged.
  test("update with the same priority writes no activity and no version bump", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story", priority: "high" });
    const before = await footprint(s, storyId);

    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "high" });

    expect(await footprint(s, storyId)).toEqual(before);
    expect((await s.issue(storyId)).priority).toBe("high");
  });

  // Catches a rank step that re-ranks, logs or bumps the version when the sort order is unchanged.
  test("update with the same sortOrder writes no activity and no version bump", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story" });
    const { sortOrder } = await s.issue(storyId);
    const before = await footprint(s, storyId);

    await s.asMember.mutation(api.issues.update, { issueId: storyId, sortOrder });

    expect(await footprint(s, storyId)).toEqual(before);
    expect((await s.issue(storyId)).sortOrder).toBe(sortOrder);
  });

  // Catches a project step that lets a child take a project other than the one its parent passes down.
  test("update to a project other than the parent's refuses", async () => {
    const s = await setup();
    const inherited = await s.project("Phase 1");
    const other = await s.project("Phase 2");
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story", projectId: inherited });
    const subtaskId = await s.asMember.mutation(api.issues.create, {
      teamId: s.teamId,
      kind: "subtask",
      parentIssueId: storyId,
      title: "Write API",
    });
    const before = await footprint(s, subtaskId);

    const error = await s.asMember
      .mutation(api.issues.update, { issueId: subtaskId, projectId: other })
      .catch(refusalOf);

    expect(error).toEqual({ code: "rule_refused", message: "A subtask's project must match its story's project" });
    expect((await s.issue(subtaskId)).projectId).toBe(inherited);
    expect(await footprint(s, subtaskId)).toEqual(before);
  });

  // Catches an estimate step that drops the cleared key, so the estimate stays and no row is logged.
  test("update estimate null clears it and logs the clear", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story", estimate: 3 });
    const rowsBefore = (await s.feed(storyId)).length;

    await s.asMember.mutation(api.issues.update, { issueId: storyId, estimate: null });

    expect(await s.issue(storyId)).not.toHaveProperty("estimate");
    const rows = await s.feed(storyId);
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(rows.at(-1)).toMatchObject({ type: "estimate_changed", field: "estimate", oldValue: "3" });
    expect(rows.at(-1)!.newValue).toBeUndefined();
  });

  // Catches a due-date step that drops the cleared key, so the due date stays and no row is logged.
  test("update dueDate null clears it and logs the clear", async () => {
    const s = await setup();
    const dueDate = 1700000000000;
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story", dueDate });
    const rowsBefore = (await s.feed(storyId)).length;

    await s.asMember.mutation(api.issues.update, { issueId: storyId, dueDate: null });

    expect(await s.issue(storyId)).not.toHaveProperty("dueDate");
    const rows = await s.feed(storyId);
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(rows.at(-1)).toMatchObject({ type: "dueDate_changed", field: "dueDate", oldValue: String(dueDate) });
    expect(rows.at(-1)!.newValue).toBeUndefined();
  });

  // Catches a revert that lets a row with no field, such as the "created" row, through to `updateIssue`.
  test("revert of a row with no field refuses", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story" });
    const created = await s.lastChange(storyId, "created");

    const error = await s.revert(created).catch(refusalOf);

    expect(error).toEqual({
      code: "rule_refused",
      message: "Only status, assignee, priority and title changes can be reverted",
    });
  });

  // Catches a revert that applies an older change while a newer change of the same field stands.
  test("revert of a row that is not the newest for its field refuses", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story" });
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "low" });
    const earlier = await s.lastChange(storyId, "priority_changed");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "high" });
    const before = await footprint(s, storyId);

    const error = await s.revert(earlier).catch(refusalOf);

    expect(error).toEqual({
      code: "rule_refused",
      message: "ENG-1 priority has changed since; revert the latest change instead",
    });
    expect((await s.issue(storyId)).priority).toBe("high");
    expect(await footprint(s, storyId)).toEqual(before);
  });

  // Catches a revert that can't turn a recorded "no assignee" back into a clear.
  test("revert of an assignee change back to unassigned", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story" });
    await s.asMember.mutation(api.issues.update, { issueId: storyId, assigneeId: s.memberId });
    const before = await s.issue(storyId);
    const rowsBefore = (await s.feed(storyId)).length;

    await s.revert(await s.lastChange(storyId, "assignee_changed"));

    const after = await s.issue(storyId);
    expect(after).not.toHaveProperty("assigneeId");
    expect(after.version).toBe(before.version! + 1);
    const rows = await s.feed(storyId);
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(rows.at(-1)).toMatchObject({ type: "reverted", field: "assignee", oldValue: s.memberId });
    expect(rows.at(-1)!.newValue).toBeUndefined();
  });

  // Catches a revert that writes a recorded status or priority the schema doesn't know.
  test("revert of a literal field with an unknown value refuses", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story" });
    const activityId = await s.t.run(async (ctx) =>
      ctx.db.insert("activity", {
        orgId: s.orgId,
        issueId: storyId,
        actorId: s.memberId,
        type: "priority_changed",
        field: "priority",
        oldValue: "not-a-priority",
        newValue: "none",
      })
    );
    const before = await footprint(s, storyId);

    const error = await s.revert(activityId).catch(refusalOf);

    expect(error).toEqual({ code: "rule_refused", message: "Unknown value not-a-priority" });
    expect((await s.issue(storyId)).priority).toBe("none");
    expect(await footprint(s, storyId)).toEqual(before);
  });

  // Catches a revert that checks only "newest for its field" and overwrites a value changed without a logged row.
  test("revert of the newest row after the value changed underneath refuses", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story" });
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "low" });
    const newest = await s.lastChange(storyId, "priority_changed");
    await s.t.run((ctx) => ctx.db.patch(storyId, { priority: "high" }));
    const before = await footprint(s, storyId);

    const error = await s.revert(newest).catch(refusalOf);

    expect(error).toEqual({
      code: "rule_refused",
      message: "ENG-1 priority has changed since; revert the latest change instead",
    });
    expect((await s.issue(storyId)).priority).toBe("high");
    expect(await footprint(s, storyId)).toEqual(before);
  });

  // Catches a create that reads the parent before `assertValidParent`'s project check, so an epic with no project
  // and a missing parent hears "Issue not found" instead of "An epic needs a project"; or one that writes an issue.
  test("create with no project and a missing parent refuses for the project first", async () => {
    const s = await setup();
    const goneId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Gone" });
    await s.t.run((ctx) => ctx.db.delete(goneId));
    const issuesBefore = await s.issueCount();

    const error = await s.asMember
      .mutation(api.issues.create, { teamId: s.teamId, kind: "epic", parentIssueId: goneId, title: "Unplaced" })
      .catch(refusalOf);

    expect(error).toEqual({ code: "rule_refused", message: "An epic needs a project" });
    expect(await s.issueCount()).toBe(issuesBefore);
  });
});
