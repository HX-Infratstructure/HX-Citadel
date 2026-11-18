/// <reference types="vite/client" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { patchIssue } from "./lib/issueVersion";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG = "org_hx";
const agent = { "X-Agent-Id": "cc1" };

let keyCount = 0;
const freshKey = () => ({ "Idempotency-Key": `test-${++keyCount}` });

beforeEach(() => {
  process.env.HX_WORKSPACE_ORG_ID = ORG;
});

afterEach(() => {
  delete process.env.HX_WORKSPACE_ORG_ID;
});

async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG, name: "HX", slug: "hx" });
    await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
  });
  await t.fetch("/api/v1/issues", { method: "POST", headers: { ...agent, ...freshKey() }, body: JSON.stringify({ teamKey: "ENG", title: "Story" }) });
  return t;
}

type T = Awaited<ReturnType<typeof setup>>;

const send = (t: T, method: string, path: string, body?: unknown, headers: Record<string, string> = agent) =>
  t.fetch(`/api/v1/issues${path}`, {
    method,
    headers: { ...agent, ...(method === "GET" ? {} : freshKey()), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const versionOf = async (t: T, key: string) => (await (await send(t, "GET", `/${key}`)).json()).issue.version;

describe("issues.version", () => {
  test("a new story and its testing sub-task start at version 1", async () => {
    const t = await setup();
    expect(await versionOf(t, "ENG-1")).toBe(1);
    expect(await versionOf(t, "ENG-1.1")).toBe(1);
  });

  test("PATCH bumps by exactly one and returns the new version and ETag", async () => {
    const t = await setup();
    const response = await send(t, "PATCH", "/ENG-1", { title: "Renamed" });
    expect(response.status).toBe(200);
    expect((await response.json()).issue.version).toBe(2);
    expect(response.headers.get("ETag")).toBe('"2"');
  });

  test("POST proof bumps the testing sub-task by exactly one", async () => {
    const t = await setup();
    const response = await send(t, "POST", "/ENG-1.1/proof", { proofUrl: "https://example.com/run/1" });
    expect((await response.json()).issue.version).toBe(2);
    expect(response.headers.get("ETag")).toBe('"2"');
  });

  test("an empty PATCH keeps the version and returns its ETag", async () => {
    const t = await setup();
    const response = await send(t, "PATCH", "/ENG-1", {});
    expect(response.status).toBe(200);
    expect((await response.json()).issue.version).toBe(1);
    expect(response.headers.get("ETag")).toBe('"1"');
    expect(await versionOf(t, "ENG-1")).toBe(1);
  });

  test("a PATCH that sets the title to its current value keeps the version", async () => {
    const t = await setup();
    const response = await send(t, "PATCH", "/ENG-1", { title: "Story" });
    expect(response.status).toBe(200);
    expect((await response.json()).issue).toMatchObject({ title: "Story", version: 1 });
    expect(await versionOf(t, "ENG-1")).toBe(1);
  });

  test("re-posting the same proof URL keeps the testing sub-task's version", async () => {
    const t = await setup();
    const first = await send(t, "POST", "/ENG-1.1/proof", { proofUrl: "https://example.com/run/1" });
    expect(first.status).toBe(200);
    expect((await first.json()).issue.version).toBe(2);
    const again = await send(t, "POST", "/ENG-1.1/proof", { proofUrl: "https://example.com/run/1" });
    expect(again.status).toBe(200);
    expect((await again.json()).issue.version).toBe(2);
    expect(again.headers.get("ETag")).toBe('"2"');
  });

  test("a real change after no-op writes bumps by exactly one", async () => {
    const t = await setup();
    await send(t, "PATCH", "/ENG-1", {});
    await send(t, "PATCH", "/ENG-1", { title: "Story" });
    const response = await send(t, "PATCH", "/ENG-1", { title: "Renamed" });
    expect((await response.json()).issue).toMatchObject({ title: "Renamed", version: 2 });
  });

  test("a comment or a new sub-task does not bump the story", async () => {
    const t = await setup();
    expect((await send(t, "POST", "/ENG-1/comments", { body: "note" })).status).toBe(201);
    expect((await send(t, "POST", "/ENG-1/subtasks", { title: "Sub" })).status).toBe(201);
    expect(await versionOf(t, "ENG-1")).toBe(1);
  });

  test("a patch that changes a real field with the sub-task counter still bumps by one", async () => {
    const t = await setup();
    await t.run(async (ctx) => {
      const story = (await ctx.db.query("issues").collect()).find((issue) => issue.kind === "story")!;
      expect(await patchIssue(ctx, story, { nextSubNumber: 9, title: "Renamed" })).toBe(2);
    });
    expect(await versionOf(t, "ENG-1")).toBe(2);
  });

  test("GET sends the ETag of the issue's version", async () => {
    const t = await setup();
    expect((await send(t, "GET", "/ENG-1")).headers.get("ETag")).toBe('"1"');
  });
});

describe("If-Match", () => {
  test("an If-Match read from a moved sub-task never writes the next sub-task", async () => {
    const t = await setup();
    await send(t, "POST", "", { teamKey: "ENG", title: "Other story" });
    await send(t, "POST", "/ENG-1/subtasks", { title: "Moved away" });
    expect(await versionOf(t, "ENG-1.2")).toBe(1);
    await t.run(async (ctx) => {
      const issues = await ctx.db.query("issues").collect();
      const moved = issues.find((issue) => issue.title === "Moved away")!;
      const other = issues.find((issue) => issue.title === "Other story")!;
      await ctx.db.patch(moved._id, { parentIssueId: other._id, subNumber: 2, version: 2 });
    });
    await send(t, "POST", "/ENG-1/subtasks", { title: "Replacement" });
    const pending = await send(t, "PATCH", "/ENG-1.2", { title: "Meant for the moved one" }, { "If-Match": '"1"' });
    expect(pending.status).toBe(404);
    expect((await (await send(t, "GET", "/ENG-1.3")).json()).issue).toMatchObject({ title: "Replacement", version: 1 });
  });

  test("a stale If-Match is 412 stale and the row is unchanged", async () => {
    const t = await setup();
    await send(t, "PATCH", "/ENG-1", { title: "Second" });
    const stale = await send(t, "PATCH", "/ENG-1", { title: "Third" }, { "If-Match": '"1"' });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toEqual({ code: "stale", message: "ENG-1 is at version 2" });
    const { issue } = await (await send(t, "GET", "/ENG-1")).json();
    expect(issue).toMatchObject({ title: "Second", version: 2 });
  });

  test("the current If-Match is 200 and returns the bumped version", async () => {
    const t = await setup();
    const current = await send(t, "PATCH", "/ENG-1", { title: "Next" }, { "If-Match": '"1"' });
    expect(current.status).toBe(200);
    expect((await current.json()).issue).toMatchObject({ title: "Next", version: 2 });
  });

  test("a stale If-Match on proof, comment and sub-task writes is 412 with no change", async () => {
    const t = await setup();
    await send(t, "PATCH", "/ENG-1", { title: "Bumped" });
    const stale = { "If-Match": '"1"' };
    expect((await send(t, "POST", "/ENG-1/comments", { body: "note" }, stale)).status).toBe(412);
    expect((await send(t, "POST", "/ENG-1/subtasks", { title: "Sub" }, stale)).status).toBe(412);
    await send(t, "POST", "/ENG-1.1/proof", { proofUrl: "https://example.com/a" });
    expect((await send(t, "POST", "/ENG-1.1/proof", { proofUrl: "https://example.com/b" }, stale)).status).toBe(412);
    const { issue, subtasks } = await (await send(t, "GET", "/ENG-1")).json();
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0].proofUrl).toBe("https://example.com/a");
    expect(issue.version).toBe(2);
    const comments = await t.run(async (ctx) => await ctx.db.query("comments").collect());
    expect(comments).toHaveLength(0);
  });

  test("POST /issues takes If-Match only from the header: a stale body ifMatch is ignored, a stale header is 412", async () => {
    const t = await setup();
    await send(t, "PATCH", "/ENG-1", { title: "Bumped" });
    const viaBody = await send(t, "POST", "", { teamKey: "ENG", title: "Sub", kind: "subtask", parentKey: "ENG-1", ifMatch: 1 });
    expect(viaBody.status).toBe(201);
    const viaHeader = await send(t, "POST", "", { teamKey: "ENG", title: "Sub", kind: "subtask", parentKey: "ENG-1" }, { "If-Match": '"1"' });
    expect(viaHeader.status).toBe(412);
    expect((await viaHeader.json()).code).toBe("stale");
  });

  test("an If-Match that is not a version number is 400 validation", async () => {
    const t = await setup();
    const response = await send(t, "PATCH", "/ENG-1", { title: "X" }, { "If-Match": "abc" });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("validation");
  });
});

describe("Clerk-session patch paths bump by one", () => {
  async function asMemberSetup() {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "user_member", name: "Member", email: "m@example.com" });
      const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG, name: "HX", slug: "hx" });
      await ctx.db.insert("members", { orgId, userId, role: "admin", clerkMembershipId: "mem_1" });
      const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
      const projectId = await ctx.db.insert("projects", { orgId, name: "P", status: "planned" });
      return { teamId, projectId };
    });
    const asMember = t.withIdentity({ subject: "user_member", org_id: ORG });
    const storyId = await asMember.mutation(api.issues.create, { teamId: ids.teamId, title: "Story", kind: "story" });
    const version = (issueId: Id<"issues">) => t.run(async (ctx) => (await ctx.db.get(issueId))?.version);
    const testingId = await t.run(
      async (ctx) => (await ctx.db.query("issues").withIndex("by_parent", (q) => q.eq("parentIssueId", storyId)).unique())!._id
    );
    return { t, asMember, storyId, testingId, version, ...ids };
  }

  test("issues.update (sort order) bumps the story; its project cascade bumps the sub-task", async () => {
    const { asMember, storyId, testingId, version, projectId } = await asMemberSetup();
    await asMember.mutation(api.issues.update, { issueId: storyId, sortOrder: 5 });
    expect(await version(storyId)).toBe(2);
    await asMember.mutation(api.issues.update, { issueId: storyId, projectId });
    expect(await version(storyId)).toBe(3);
    expect(await version(testingId)).toBe(2);
  });

  test("projects.remove and cycles.remove each bump the issues they clear", async () => {
    const { t, asMember, storyId, version, projectId, teamId } = await asMemberSetup();
    const cycleId = await t.run(async (ctx) => {
      const orgId = (await ctx.db.get(teamId))!.orgId;
      return await ctx.db.insert("cycles", { orgId, teamId, number: 1, startDate: 0, endDate: 1 });
    });
    await asMember.mutation(api.issues.update, { issueId: storyId, projectId, cycleId });
    expect(await version(storyId)).toBe(2);
    await asMember.mutation(api.cycles.remove, { cycleId });
    expect(await version(storyId)).toBe(3);
    await asMember.mutation(api.projects.remove, { projectId });
    expect(await version(storyId)).toBe(4);
  });
});

describe("one home for issue patches", () => {
  /** First arguments of `ctx.db.patch(` that name a non-issue row; any other patch must be `patchIssue`'s own. */
  const NON_ISSUE_IDS = ["team._id", "teamId", "cycle._id", "project._id", "view._id", "comment._id", "existing._id", "decision._id"];

  test("every ctx.db.patch( outside patchIssue names a non-issue row", () => {
    const sources = ["", "lib", "lib/rules"].flatMap((dir) =>
      readdirSync(join(__dirname, dir))
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map((name) => join(dir, name))
    );
    const patches = sources.flatMap((file) =>
      [...readFileSync(join(__dirname, file), "utf8").matchAll(/ctx\.db\.patch\(([^,]+),/g)].map((match) => ({ file, id: match[1] }))
    );
    const issuePatches = patches.filter((patch) => !NON_ISSUE_IDS.includes(patch.id));
    expect(issuePatches).toEqual([{ file: join("lib", "issueVersion.ts"), id: "issue._id" }]);
  });
});
