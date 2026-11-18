/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { Doc, Id } from "./_generated/dataModel";
import { IssueKeys } from "./lib/issueKeys";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

type IssueFields = Partial<Doc<"issues">> & Pick<Doc<"issues">, "kind" | "title">;

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: "org_test", name: "Test", slug: "test" });
    const otherOrgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 13 });
    const otherTeamId = await ctx.db.insert("teams", { orgId: otherOrgId, name: "Other", key: "OTH", nextIssueNumber: 8 });
    const creatorId = await ctx.db.insert("users", { clerkId: "user_a", name: "A", email: "a@example.com" });
    return { orgId, otherOrgId, teamId, otherTeamId, creatorId };
  });
  const insert = (fields: IssueFields) =>
    t.run(async (ctx) =>
      ctx.db.insert("issues", {
        orgId: ids.orgId,
        teamId: ids.teamId,
        creatorId: ids.creatorId,
        status: "todo",
        priority: "none",
        sortOrder: 0,
        ...fields,
      })
    );
  const names = (issueId: Id<"issues">) =>
    t.run(async (ctx) => {
      const issue = (await ctx.db.get(issueId))!;
      const keys = new IssueKeys(ctx, ids.orgId);
      return {
        key: await keys.key(issue),
        name: await keys.name(issue),
        label: await keys.label(issue),
        parentKey: await keys.parentKey(issue),
      };
    });
  return { ...ids, insert, names };
}

describe("IssueKeys", () => {
  test("a story is KEY-n", async () => {
    const s = await setup();
    const storyId = await s.insert({ kind: "story", number: 12, title: "Login" });

    expect(await s.names(storyId)).toEqual({ key: "ENG-12", name: "ENG-12", label: "ENG-12 Login", parentKey: null });
  });

  test("a sub-task is KEY-n.m with its story's number, and its parent key is the story's", async () => {
    const s = await setup();
    const storyId = await s.insert({ kind: "story", number: 12, title: "Login" });
    const subtaskId = await s.insert({ kind: "subtask", subNumber: 3, parentIssueId: storyId, title: "Write API" });

    expect(await s.names(subtaskId)).toEqual({
      key: "ENG-12.3",
      name: "ENG-12.3",
      label: "ENG-12.3 Write API",
      parentKey: "ENG-12",
    });
  });

  test("a sub-task whose story is in another workspace has no key, not the foreign number", async () => {
    const s = await setup();
    const foreignId = await s.insert({ orgId: s.otherOrgId, teamId: s.otherTeamId, kind: "story", number: 7, title: "Foreign" });
    const subtaskId = await s.insert({ kind: "subtask", subNumber: 1, parentIssueId: foreignId, title: "Cross-org" });

    expect(await s.names(subtaskId)).toEqual({ key: null, name: "Cross-org", label: "Cross-org", parentKey: null });
  });

  test("an issue whose team is in another workspace has no key, not a partial one", async () => {
    const s = await setup();
    const storyId = await s.insert({ teamId: s.otherTeamId, kind: "story", number: 4, title: "Stray" });

    expect(await s.names(storyId)).toEqual({ key: null, name: "Stray", label: "Stray", parentKey: null });
  });

  test("a story with no number has no key", async () => {
    const s = await setup();
    const storyId = await s.insert({ kind: "story", title: "Unnumbered" });

    expect(await s.names(storyId)).toEqual({ key: null, name: "Unnumbered", label: "Unnumbered", parentKey: null });
  });

  test("epics and features are named by their title", async () => {
    const s = await setup();
    const epicId = await s.insert({ kind: "epic", title: "Accounts" });
    const featureId = await s.insert({ kind: "feature", parentIssueId: epicId, title: "Sign-in" });

    expect(await s.names(epicId)).toEqual({ key: null, name: "Accounts", label: "Accounts", parentKey: null });
    expect(await s.names(featureId)).toEqual({ key: null, name: "Sign-in", label: "Sign-in", parentKey: null });
  });
});
