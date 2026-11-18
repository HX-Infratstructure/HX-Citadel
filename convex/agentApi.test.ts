/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG = "org_hx";
const WIP_REFUSAL = "cc1 already has ENG-1 In Progress; move it to In Review or Done first";

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
  return t;
}

type T = Awaited<ReturnType<typeof setup>>;

const post = (t: T, body: unknown, agent?: string) =>
  t.fetch("/api/v1/issues", {
    method: "POST",
    headers: agent === undefined ? {} : { "X-Agent-Id": agent },
    body: JSON.stringify(body),
  });

describe("internal.agentApi.createIssue", () => {
  test("a first call creates the agent, which creates the story and its testing sub-task", async () => {
    const t = await setup();
    const { issue } = await t.mutation(internal.agentApi.createIssue, {
      agentName: "CC1",
      teamKey: "ENG",
      title: "Agent story",
    });
    expect(issue.key).toBe("ENG-1");
    const { creator, subtasks } = await t.run(async (ctx) => ({
      creator: await ctx.db.get(issue.creatorId),
      subtasks: await ctx.db
        .query("issues")
        .withIndex("by_parent", (q) => q.eq("parentIssueId", issue._id))
        .collect(),
    }));
    expect(creator).toMatchObject({ kind: "agent", clerkId: "agent:cc1" });
    expect(subtasks.map((subtask) => subtask.testing)).toEqual([true]);
  });

  test("a later call reuses the agent", async () => {
    const t = await setup();
    const first = await t.mutation(internal.agentApi.createIssue, { agentName: "cc1", teamKey: "ENG", title: "One" });
    const second = await t.mutation(internal.agentApi.createIssue, { agentName: " CC1 ", teamKey: "ENG", title: "Two" });
    expect(second.issue.creatorId).toBe(first.issue.creatorId);
  });

  test("a second In Progress story for the same agent is refused with the WIP rule", async () => {
    const t = await setup();
    const args = { agentName: "cc1", teamKey: "ENG", status: "in_progress" as const, assignee: "cc1" };
    await t.mutation(internal.agentApi.createIssue, { ...args, title: "First" });
    await expect(t.mutation(internal.agentApi.createIssue, { ...args, title: "Second" })).rejects.toThrow(WIP_REFUSAL);
  });
});

describe("REST /api/v1/issues", () => {
  test("POST without X-Agent-Id is 400 actor_required", async () => {
    const t = await setup();
    const response = await post(t, { teamKey: "ENG", title: "No actor" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "actor_required" });
  });

  test("POST creates a story, 201 with its key", async () => {
    const t = await setup();
    const response = await post(t, { teamKey: "ENG", title: "Via REST" }, "cc1");
    expect(response.status).toBe(201);
    expect((await response.json()).issue).toMatchObject({ key: "ENG-1", title: "Via REST" });
  });

  test("POST with a parentKey creates a sub-task under the story", async () => {
    const t = await setup();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    const response = await post(t, { teamKey: "ENG", title: "Sub", kind: "subtask", parentKey: "ENG-1" }, "cc1");
    expect(response.status).toBe(201);
    expect((await response.json()).issue).toMatchObject({ key: "ENG-1.2", kind: "subtask" });
  });

  test("a WIP refusal is 409 rule_refused with the rule's message", async () => {
    const t = await setup();
    const body = { teamKey: "ENG", title: "Busy", status: "in_progress", assignee: "cc1" };
    await post(t, body, "cc1");
    const response = await post(t, body, "cc1");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "rule_refused", message: WIP_REFUSAL });
  });

  test("an unknown team is 404 not_found and a bad body is 400 validation", async () => {
    const t = await setup();
    expect((await post(t, { teamKey: "NOPE", title: "x" }, "cc1")).status).toBe(404);
    const invalid = await post(t, { teamKey: "ENG" }, "cc1");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "validation" });
  });

  test("GET by key returns a story with its sub-tasks, and a sub-task by its own key", async () => {
    const t = await setup();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    const story = await t.fetch("/api/v1/issues/ENG-1", { headers: { "X-Agent-Id": "cc1" } });
    expect(story.status).toBe(200);
    const storyBody = await story.json();
    expect(storyBody.issue).toMatchObject({ key: "ENG-1", kind: "story" });
    expect(storyBody.subtasks.map((subtask: { key: string }) => subtask.key)).toEqual(["ENG-1.1"]);

    const subtask = await t.fetch("/api/v1/issues/ENG-1.1", { headers: { "X-Agent-Id": "cc1" } });
    expect(subtask.status).toBe(200);
    expect((await subtask.json()).issue).toMatchObject({ key: "ENG-1.1", kind: "subtask" });
  });

  test("GET needs X-Agent-Id and an unknown key is 404", async () => {
    const t = await setup();
    expect((await t.fetch("/api/v1/issues/ENG-1")).status).toBe(400);
    const missing = await t.fetch("/api/v1/issues/ENG-9", { headers: { "X-Agent-Id": "cc1" } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
  });
});

describe("REST refusals (DSH gates, 10:11Z)", () => {
  const failure = async (response: Response) => ({ status: response.status, code: (await response.json()).code });

  test("a whitespace-only X-Agent-Id is 400 actor_required; an invalid name is 400 validation", async () => {
    const t = await setup();
    expect(await failure(await post(t, { teamKey: "ENG", title: "x" }, "   "))).toEqual({ status: 400, code: "actor_required" });
    expect(await failure(await post(t, { teamKey: "ENG", title: "x" }, "cc 1"))).toEqual({ status: 400, code: "validation" });
  });

  test("a bad JSON body is 400 validation", async () => {
    const t = await setup();
    const response = await t.fetch("/api/v1/issues", { method: "POST", headers: { "X-Agent-Id": "cc1" }, body: "{not json" });
    expect(await failure(response)).toEqual({ status: 400, code: "validation" });
  });

  test("an unknown parentKey is 404; an invalid assignee, status or kind is 400", async () => {
    const t = await setup();
    const base = { teamKey: "ENG", title: "x" };
    expect(await failure(await post(t, { ...base, kind: "subtask", parentKey: "ENG-9" }, "cc1"))).toEqual({ status: 404, code: "not_found" });
    expect(await failure(await post(t, { ...base, assignee: "not valid" }, "cc1"))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await post(t, { ...base, assignee: "ghost" }, "cc1"))).toEqual({ status: 404, code: "not_found" });
    expect(await failure(await post(t, { ...base, status: "doing" }, "cc1"))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await post(t, { ...base, kind: "bug" }, "cc1"))).toEqual({ status: 400, code: "validation" });
  });

  test("a missing or unmatched HX_WORKSPACE_ORG_ID fails closed with a clear 500 server_error", async () => {
    const t = await setup();
    delete process.env.HX_WORKSPACE_ORG_ID;
    const missing = await post(t, { teamKey: "ENG", title: "x" }, "cc1");
    expect(missing.status).toBe(500);
    expect(await missing.json()).toEqual({ code: "server_error", message: "HX_WORKSPACE_ORG_ID is not configured" });
    process.env.HX_WORKSPACE_ORG_ID = "org_unknown";
    const unmatched = await t.fetch("/api/v1/issues/ENG-1", { headers: { "X-Agent-Id": "cc1" } });
    expect(unmatched.status).toBe(500);
    expect(await unmatched.json()).toEqual({ code: "server_error", message: "HX_WORKSPACE_ORG_ID matches no workspace" });
  });
});
