import { describe, expect, test, vi } from "vitest";
import { ConvexError, type Value } from "convex/values";
import { internal } from "./_generated/api";
import { pageFailure } from "./agentApi";
import { PAGE_READ_ROWS } from "./issues";
import { AGENT, freshKey, registerWorkspaceEnv, workspaceTest, writeHeaders, type WorkspaceTest } from "./workspace.fixture";

const WIP_REFUSAL = "cc1 already has ENG-1 In Progress; move it to In Review or Done first";

registerWorkspaceEnv();

const post = (t: WorkspaceTest, body: unknown, agent?: string) =>
  t.fetch("/api/v1/issues", {
    method: "POST",
    headers: agent === undefined ? freshKey() : { "X-Agent-Id": agent, ...freshKey() },
    body: JSON.stringify(body),
  });

describe("internal.agentApi.createIssue", () => {
  test("a first call creates the agent, which creates the story and its testing sub-task", async () => {
    const t = await workspaceTest();
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
        .withIndex("by_org_and_parent", (q) => q.eq("orgId", issue.orgId).eq("parentIssueId", issue._id))
        .collect(),
    }));
    expect(creator).toMatchObject({ kind: "agent", clerkId: "agent:cc1" });
    expect(subtasks.map((subtask) => subtask.testing)).toEqual([true]);
  });

  test("a later call reuses the agent", async () => {
    const t = await workspaceTest();
    const first = await t.mutation(internal.agentApi.createIssue, { agentName: "cc1", teamKey: "ENG", title: "One" });
    const second = await t.mutation(internal.agentApi.createIssue, { agentName: " CC1 ", teamKey: "ENG", title: "Two" });
    expect(second.issue.creatorId).toBe(first.issue.creatorId);
  });

  test("a second In Progress story for the same agent is refused with the WIP rule", async () => {
    const t = await workspaceTest();
    const args = { agentName: "cc1", teamKey: "ENG", status: "in_progress" as const, assignee: "cc1" };
    await t.mutation(internal.agentApi.createIssue, { ...args, title: "First" });
    await expect(t.mutation(internal.agentApi.createIssue, { ...args, title: "Second" })).rejects.toThrow(WIP_REFUSAL);
  });

  test("If-Match on a story create, with no parent to check, is 400 validation and creates nothing", async () => {
    const t = await workspaceTest();
    const response = await t.fetch("/api/v1/issues", {
      method: "POST",
      headers: { ...writeHeaders(), "If-Match": '"1"' },
      body: JSON.stringify({ teamKey: "ENG", title: "Story" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "validation", message: "If-Match applies only with parentKey" });
    expect(await t.run(async (ctx) => (await ctx.db.query("issues").collect()).length)).toBe(0);
  });
});

describe("internal.agentApi.listIssues past the newest 500 issues", () => {
  async function fill(t: WorkspaceTest, count: number) {
    await t.run(async (ctx) => {
      const { orgId, teamId, creatorId } = (await ctx.db.query("issues").first())!;
      for (let i = 0; i < count; i++) {
        const filler = { orgId, teamId, creatorId, kind: "story", number: 1000 + i, sortOrder: i } as const;
        await ctx.db.insert("issues", { ...filler, title: "Filler", status: "todo", priority: "none" });
      }
    });
  }

  test("an assignee filter finds a match older than the newest 500 issues", async () => {
    const t = await workspaceTest();
    await t.mutation(internal.agentApi.createIssue, { agentName: "cc1", teamKey: "ENG", title: "Old", assignee: "cc1" });
    await fill(t, 501);
    const { issues } = await t.query(internal.agentApi.listIssues, { agentName: "cc1", teamKey: "ENG", assignee: "me" });
    expect(issues.map((issue) => issue.key).sort()).toEqual(["ENG-1", "ENG-1.1"]);
  });

  test("a recent sub-task keeps its parentKey when its story is older than the newest 500 issues", async () => {
    const t = await workspaceTest();
    await t.mutation(internal.agentApi.createIssue, { agentName: "cc1", teamKey: "ENG", title: "Old story" });
    await fill(t, 501);
    await t.fetch("/api/v1/issues/ENG-1/subtasks", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ title: "Recent sub-task" }),
    });
    const { issues } = await t.query(internal.agentApi.listIssues, { agentName: "cc1", teamKey: "ENG" });
    expect(issues).toContainEqual(expect.objectContaining({ key: "ENG-1.2", parentKey: "ENG-1" }));
  });

  test("a sub-task whose parent is in another workspace lists with no parentKey and no parent number", async () => {
    const t = await workspaceTest();
    await t.mutation(internal.agentApi.createIssue, { agentName: "cc1", teamKey: "ENG", title: "Story" });
    await t.run(async (ctx) => {
      const { orgId, teamId, creatorId } = (await ctx.db.query("issues").first())!;
      const otherOrgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const otherTeamId = await ctx.db.insert("teams", { orgId: otherOrgId, name: "Other", key: "OTH", nextIssueNumber: 8 });
      const foreign = { orgId: otherOrgId, teamId: otherTeamId, creatorId, kind: "story", number: 7, sortOrder: 0 } as const;
      const parentIssueId = await ctx.db.insert("issues", { ...foreign, title: "Foreign", status: "todo", priority: "none" });
      const crossOrg = { orgId, teamId, creatorId, kind: "subtask", subNumber: 1, sortOrder: 1, parentIssueId } as const;
      await ctx.db.insert("issues", { ...crossOrg, title: "Cross-org sub-task", status: "todo", priority: "none" });
    });
    const { issues } = await t.query(internal.agentApi.listIssues, { agentName: "cc1", teamKey: "ENG" });
    expect(issues).toContainEqual(expect.objectContaining({ title: "Cross-org sub-task", key: null, parentKey: null }));
  });

  type Page = { issues: { _id: string; status: string; assignee: string | null }[]; nextCursor: string | null };
  const page = async (t: WorkspaceTest, query: string): Promise<Page> => {
    const response = await t.fetch(`/api/v1/issues?team=ENG${query}`, { headers: AGENT });
    expect(response.status).toBe(200);
    return await response.json();
  };

  test("GET pages 501 issues as 500 with a nextCursor, then the last one with nextCursor null", async () => {
    const t = await workspaceTest();
    await t.mutation(internal.agentApi.createIssue, { agentName: "cc1", teamKey: "ENG", title: "Story" });
    await fill(t, 499);
    const first = await page(t, "");
    expect(first.issues).toHaveLength(500);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await page(t, `&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.issues).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.issues, ...second.issues].map((issue) => issue._id)).size).toBe(501);
  });

  test("GET keeps the status and assignee filters on every page", async () => {
    const t = await workspaceTest();
    await t.mutation(internal.agentApi.createIssue, { agentName: "cc1", teamKey: "ENG", title: "Mine", assignee: "cc1" });
    const expected = await t.run(async (ctx) => {
      const { orgId, teamId, creatorId, assigneeId } = (await ctx.db.query("issues").first())!;
      const shapes = [{ status: "todo", assigneeId }, { status: "todo" }, { status: "done", assigneeId }] as const;
      for (let i = 0; i < 1503; i++) {
        const filler = { orgId, teamId, creatorId, kind: "story", number: 1000 + i, sortOrder: i, title: "Filler", priority: "none" } as const;
        await ctx.db.insert("issues", { ...filler, ...shapes[i % 3] });
      }
      const all = await ctx.db.query("issues").collect();
      return all.filter((issue) => issue.status === "todo" && issue.assigneeId === assigneeId).map((issue) => issue._id);
    });
    const filters = "&status=todo&assignee=me";
    let next = await page(t, filters);
    expect(next.issues).toHaveLength(500);
    const listed = [...next.issues];
    for (let pages = 1; typeof next.nextCursor === "string" && pages < 10; pages++) {
      next = await page(t, `${filters}&cursor=${encodeURIComponent(next.nextCursor)}`);
      listed.push(...next.issues);
    }
    expect(next.nextCursor).toBeNull();
    expect(expected.length).toBeGreaterThan(500);
    expect(listed.every((issue) => issue.status === "todo" && issue.assignee === "cc1")).toBe(true);
    expect(listed.map((issue) => issue._id).sort()).toEqual([...expected].sort());
  });

  test("GET stops a page at the read limit, and its cursor reaches a rare match past it once", async () => {
    const t = await workspaceTest();
    const { issue: match } = await t.mutation(internal.agentApi.createIssue, { agentName: "cc1", teamKey: "ENG", title: "Rare" });
    await t.run((ctx) => ctx.db.patch(match._id, { status: "in_review" }));
    await fill(t, PAGE_READ_ROWS + 1_000);
    const filters = "&status=in_review";
    let next = await page(t, filters);
    expect(next, "the first page read only non-matching rows").toEqual({ issues: [], nextCursor: expect.any(String) });
    const listed = [...next.issues];
    for (let pages = 1; typeof next.nextCursor === "string" && pages < 10; pages++) {
      next = await page(t, `${filters}&cursor=${encodeURIComponent(next.nextCursor)}`);
      listed.push(...next.issues);
    }
    expect(next.nextCursor).toBeNull();
    expect(listed.map((issue) => issue._id)).toEqual([match._id]);
  });

  test("GET with an empty cursor is 400 validation", async () => {
    const t = await workspaceTest();
    const response = await t.fetch("/api/v1/issues?team=ENG&cursor=", { headers: AGENT });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "validation", message: "cursor cannot be empty" });
  });
});

describe("pageFailure, the .paginate error mapping", () => {
  const thrown = (run: () => never) => {
    try {
      run();
    } catch (error) {
      return error;
    }
  };

  test("a sent cursor that Convex names (InvalidCursor) is a validation refusal", () => {
    const error = thrown(() => pageFailure(new Error("InvalidCursor: the cursor could not be parsed"), "c1"));
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code: string }>).data.code).toBe("validation");
  });

  test("Convex's structured InvalidCursor signal is a validation refusal, whatever its message says", () => {
    const signal = { isConvexSystemError: true, paginationError: "InvalidCursor" };
    const error = thrown(() => pageFailure(Object.assign(new ConvexError<Value>("Paginated query failed"), { data: signal }), "c1"));
    expect((error as ConvexError<{ code: string }>).data.code).toBe("validation");
  });

  test("the self-hosted backend's unstructured bad-cursor error is a validation refusal", () => {
    const error = thrown(() => pageFailure(new Error("Failed to parse cursor"), "c1"));
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code: string }>).data.code).toBe("validation");
  });

  test("an error that only mentions a cursor, without Convex's InvalidCursor name, is rethrown and stays a 500", () => {
    const other = new Error("Too many documents read while following the cursor");
    expect(thrown(() => pageFailure(other, "c1"))).toBe(other);
  });

  test("any other failure, such as a read limit, is rethrown unchanged and stays a 500", () => {
    const readLimit = new Error("Too many documents read in a single function execution");
    expect(thrown(() => pageFailure(readLimit, "c1"))).toBe(readLimit);
  });

  test("a cursor error with no cursor sent is rethrown unchanged", () => {
    const invalidCursor = new Error("InvalidCursor");
    expect(thrown(() => pageFailure(invalidCursor, undefined))).toBe(invalidCursor);
  });
});

describe("REST /api/v1/issues", () => {
  test("POST without X-Agent-Id is 400 actor_required", async () => {
    const t = await workspaceTest();
    const response = await post(t, { teamKey: "ENG", title: "No actor" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "actor_required" });
  });

  test("POST creates a story, 201 with its key", async () => {
    const t = await workspaceTest();
    const response = await post(t, { teamKey: "ENG", title: "Via REST" }, "cc1");
    expect(response.status).toBe(201);
    expect((await response.json()).issue).toMatchObject({ key: "ENG-1", title: "Via REST" });
  });

  test("POST with a parentKey creates a sub-task under the story", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    const response = await post(t, { teamKey: "ENG", title: "Sub", kind: "subtask", parentKey: "ENG-1" }, "cc1");
    expect(response.status).toBe(201);
    expect((await response.json()).issue).toMatchObject({ key: "ENG-1.2", kind: "subtask" });
  });

  test("a WIP refusal is 409 rule_refused with the rule's message", async () => {
    const t = await workspaceTest();
    const body = { teamKey: "ENG", title: "Busy", status: "in_progress", assignee: "cc1" };
    await post(t, body, "cc1");
    const response = await post(t, body, "cc1");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "rule_refused", message: WIP_REFUSAL });
  });

  test("POST finds the team by a lower-case, padded key", async () => {
    const t = await workspaceTest();
    const response = await post(t, { teamKey: " eng ", title: "Lower case" }, "cc1");
    expect(response.status).toBe(201);
    expect((await response.json()).issue).toMatchObject({ key: "ENG-1", title: "Lower case" });
  });

  test("an unknown team is 404 not_found and a bad body is 400 validation", async () => {
    const t = await workspaceTest();
    expect((await post(t, { teamKey: "NOPE", title: "x" }, "cc1")).status).toBe(404);
    const invalid = await post(t, { teamKey: "ENG" }, "cc1");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "validation" });
  });

  test("GET by key returns a story with its sub-tasks, and a sub-task by its own key", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    const story = await t.fetch("/api/v1/issues/ENG-1", { headers: AGENT });
    expect(story.status).toBe(200);
    const storyBody = await story.json();
    expect(storyBody.issue).toMatchObject({ key: "ENG-1", kind: "story" });
    expect(storyBody.subtasks.map((subtask: { key: string }) => subtask.key)).toEqual(["ENG-1.1"]);

    const subtask = await t.fetch("/api/v1/issues/ENG-1.1", { headers: AGENT });
    expect(subtask.status).toBe(200);
    expect((await subtask.json()).issue).toMatchObject({ key: "ENG-1.1", kind: "subtask" });
  });

  test("GET leaves out a sub-task row from another workspace that points at the story", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    await t.run(async (ctx) => {
      const story = (await ctx.db.query("issues").first())!;
      const otherOrgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const otherTeamId = await ctx.db.insert("teams", { orgId: otherOrgId, name: "Other", key: "OTH", nextIssueNumber: 1 });
      const foreign = { orgId: otherOrgId, teamId: otherTeamId, creatorId: story.creatorId, kind: "subtask", subNumber: 9 } as const;
      await ctx.db.insert("issues", { ...foreign, parentIssueId: story._id, sortOrder: 9, title: "Foreign", status: "todo", priority: "none" });
    });
    const story = await t.fetch("/api/v1/issues/ENG-1", { headers: AGENT });
    expect((await story.json()).subtasks.map((subtask: { key: string }) => subtask.key)).toEqual(["ENG-1.1"]);
    const foreign = await t.fetch("/api/v1/issues/ENG-1.9", { headers: AGENT });
    expect(foreign.status).toBe(404);
  });

  test("GET is 404 for a story row from another workspace that points at an in-org team, and for its sub-task", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    await t.run(async (ctx) => {
      const { teamId, creatorId } = (await ctx.db.query("issues").first())!;
      const otherOrgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const foreign = { orgId: otherOrgId, teamId, creatorId, kind: "story", number: 7, sortOrder: 7 } as const;
      const parentIssueId = await ctx.db.insert("issues", { ...foreign, title: "Foreign", status: "todo", priority: "none" });
      const { orgId } = (await ctx.db.query("teams").first())!;
      const subtask = { orgId, teamId, creatorId, kind: "subtask", subNumber: 1, sortOrder: 8, parentIssueId } as const;
      await ctx.db.insert("issues", { ...subtask, title: "Under foreign", status: "todo", priority: "none" });
    });
    const story = await t.fetch("/api/v1/issues/ENG-7", { headers: AGENT });
    expect(story.status).toBe(404);
    expect(await story.json()).toMatchObject({ code: "not_found" });
    const subtask = await t.fetch("/api/v1/issues/ENG-7.1", { headers: AGENT });
    expect(subtask.status).toBe(404);
  });

  test("GET still finds the in-org story when a row from another workspace has its team and number", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    await t.run(async (ctx) => {
      const { teamId, creatorId, number } = (await ctx.db.query("issues").first())!;
      const otherOrgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const foreign = { orgId: otherOrgId, teamId, creatorId, kind: "story", number, sortOrder: 7 } as const;
      await ctx.db.insert("issues", { ...foreign, title: "Foreign", status: "todo", priority: "none" });
    });
    const story = await t.fetch("/api/v1/issues/ENG-1", { headers: AGENT });
    expect(story.status).toBe(200);
    expect((await story.json()).issue).toMatchObject({ key: "ENG-1", title: "Story" });
  });

  test("a story's JSON leaves out its sub-task counter", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    const story = await t.fetch("/api/v1/issues/ENG-1", { headers: AGENT });
    expect((await story.json()).issue).not.toHaveProperty("nextSubNumber");
    const listed = await t.fetch("/api/v1/issues?team=ENG", { headers: AGENT });
    const listedStory = (await listed.json()).issues.find((issue: { key: string }) => issue.key === "ENG-1");
    expect(listedStory).toMatchObject({ kind: "story" });
    expect(listedStory).not.toHaveProperty("nextSubNumber");
  });

  test("GET needs X-Agent-Id and an unknown key is 404", async () => {
    const t = await workspaceTest();
    expect((await t.fetch("/api/v1/issues/ENG-1")).status).toBe(400);
    const missing = await t.fetch("/api/v1/issues/ENG-9", { headers: AGENT });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
  });
});

describe("REST refusals (DSH gates, 10:11Z)", () => {
  const failure = async (response: Response) => ({ status: response.status, code: (await response.json()).code });

  test("a whitespace-only X-Agent-Id is 400 actor_required; an invalid name is 400 validation", async () => {
    const t = await workspaceTest();
    expect(await failure(await post(t, { teamKey: "ENG", title: "x" }, "   "))).toEqual({ status: 400, code: "actor_required" });
    expect(await failure(await post(t, { teamKey: "ENG", title: "x" }, "cc 1"))).toEqual({ status: 400, code: "validation" });
  });

  test("a bad JSON body is 400 validation", async () => {
    const t = await workspaceTest();
    const response = await t.fetch("/api/v1/issues", { method: "POST", headers: writeHeaders(), body: "{not json" });
    expect(await failure(response)).toEqual({ status: 400, code: "validation" });
  });

  test("an unknown parentKey is 404; an invalid assignee, status or kind is 400", async () => {
    const t = await workspaceTest();
    const base = { teamKey: "ENG", title: "x" };
    expect(await failure(await post(t, { ...base, kind: "subtask", parentKey: "ENG-9" }, "cc1"))).toEqual({ status: 404, code: "not_found" });
    expect(await failure(await post(t, { ...base, assignee: "not valid" }, "cc1"))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await post(t, { ...base, assignee: "ghost" }, "cc1"))).toEqual({ status: 404, code: "not_found" });
    expect(await failure(await post(t, { ...base, status: "doing" }, "cc1"))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await post(t, { ...base, kind: "bug" }, "cc1"))).toEqual({ status: 400, code: "validation" });
  });

  test("a missing or unmatched HX_WORKSPACE_ORG_ID fails closed with a clear 500 server_error", async () => {
    const t = await workspaceTest();
    delete process.env.HX_WORKSPACE_ORG_ID;
    const missing = await post(t, { teamKey: "ENG", title: "x" }, "cc1");
    expect(missing.status).toBe(500);
    expect(await missing.json()).toEqual({ code: "server_error", message: "HX_WORKSPACE_ORG_ID is not configured" });
    process.env.HX_WORKSPACE_ORG_ID = "org_unknown";
    const unmatched = await t.fetch("/api/v1/issues/ENG-1", { headers: AGENT });
    expect(unmatched.status).toBe(500);
    expect(await unmatched.json()).toEqual({ code: "server_error", message: "HX_WORKSPACE_ORG_ID matches no workspace" });
  });

  test("a failure no rule names is a logged 500 server_error, never a rule refusal, and its words stay on the server", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Twice" }, "cc1");
    await t.run(async (ctx) => {
      const story = await ctx.db.query("issues").order("asc").first();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, _creationTime, ...copy } = story!;
      await ctx.db.insert("issues", copy);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await t.fetch("/api/v1/issues/ENG-1", { headers: AGENT });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: "server_error", message: "Internal error" });
      expect(logged).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    } finally {
      logged.mockRestore();
    }
  });
});

describe("REST P3.2b routes", () => {
  const send = (t: WorkspaceTest, method: string, path: string, body?: unknown, headers: Record<string, string> = AGENT) =>
    t.fetch(`/api/v1/issues${path}`, {
      method,
      headers: method === "GET" ? headers : { ...freshKey(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const failure = async (response: Response) => ({ status: response.status, code: (await response.json()).code });

  test("GET ?team= lists keyed issues with assignee name and parentKey, filtered by status and assignee=me", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Mine", assignee: "cc1" }, "cc1");
    await post(t, { teamKey: "ENG", title: "Mine", assignee: "cc1" }, "cc1");
    await post(t, { teamKey: "ENG", title: "Other" }, "cc1");
    await post(t, { teamKey: "ENG", title: "Parked", assignee: "cc1", status: "backlog" }, "cc1");
    const all = await send(t, "GET", "?team=ENG");
    expect(all.status).toBe(200);
    const { issues } = await all.json();
    expect(issues).toContainEqual(expect.objectContaining({ key: "ENG-3.1", kind: "subtask", parentKey: "ENG-3", assignee: null }));
    const mine = await (await send(t, "GET", "?team=ENG&assignee=me&status=todo")).json();
    expect(mine.issues.map((issue: { key: string; assignee: string }) => [issue.key, issue.assignee]).sort()).toEqual([
      ["ENG-1", "cc1"],
      ["ENG-1.1", "cc1"],
      ["ENG-2", "cc1"],
      ["ENG-2.1", "cc1"],
      ["ENG-4.1", "cc1"],
    ]);
    const assigned = await (await send(t, "GET", "?team=ENG&assignee=me")).json();
    expect(assigned.issues.map((issue: { key: string }) => issue.key)).toContain("ENG-4");
    expect(await failure(await send(t, "GET", "?team=ENG", undefined, {}))).toEqual({ status: 400, code: "actor_required" });
  });

  test("PATCH moves, assigns and renames; a second In Progress story is 409 WIP", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "One" }, "cc1");
    await post(t, { teamKey: "ENG", title: "Two" }, "cc1");
    const moved = await send(t, "PATCH", "/ENG-1", { status: "in_progress", assignee: "cc1", title: "One!" });
    expect(moved.status).toBe(200);
    expect((await moved.json()).issue).toMatchObject({ key: "ENG-1", status: "in_progress", title: "One!" });
    const second = await send(t, "PATCH", "/ENG-2", { status: "in_progress", assignee: "cc1" });
    expect(await second.json()).toEqual({ code: "rule_refused", message: WIP_REFUSAL });
    const unassigned = await send(t, "PATCH", "/ENG-1", { assignee: null });
    expect((await unassigned.json()).issue.assigneeId).toBeUndefined();
    expect(await failure(await send(t, "PATCH", "/ENG-1", { assignee: "ghost" }))).toEqual({ status: 404, code: "not_found" });
  });

  test("PATCH Done without proof is 409; an unknown key is 404; no header is 400", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    expect(await failure(await send(t, "PATCH", "/ENG-1", { status: "done" }))).toEqual({ status: 409, code: "rule_refused" });
    expect(await failure(await send(t, "PATCH", "/ENG-9", { status: "done" }))).toEqual({ status: 404, code: "not_found" });
    expect(await failure(await send(t, "PATCH", "/ENG-1", { status: "done" }, {}))).toEqual({ status: 400, code: "actor_required" });
  });

  test("POST proof sets it on the testing sub-task; a non-testing issue is 409", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    const proved = await send(t, "POST", "/ENG-1.1/proof", { proofUrl: "https://example.com/run/1" });
    expect(proved.status).toBe(200);
    expect((await proved.json()).issue).toMatchObject({ key: "ENG-1.1", proofUrl: "https://example.com/run/1" });
    expect(await failure(await send(t, "POST", "/ENG-1/proof", { proofUrl: "https://example.com/x" }))).toEqual({
      status: 409,
      code: "rule_refused",
    });
  });

  test("POST comments is 201 with the comment, authored and logged by the commenting agent", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    const response = await send(t, "POST", "/ENG-1/comments", { body: "Started" }, { "X-Agent-Id": "cc2" });
    expect(response.status).toBe(201);
    const { comment } = await response.json();
    const { commenter, activity } = await t.run(async (ctx) => ({
      commenter: await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", "agent:cc2"))
        .unique(),
      activity: (await ctx.db.query("activity").collect()).filter((row) => row.type === "commented"),
    }));
    expect(comment).toMatchObject({ body: "Started", authorId: commenter!._id });
    expect(activity.map((row) => row.actorId)).toEqual([commenter!._id]);
    expect(await failure(await send(t, "POST", "/ENG-9/comments", { body: "x" }))).toEqual({ status: 404, code: "not_found" });
  });

  test("POST subtasks is 201 with the keyed sub-task under the story", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    const response = await send(t, "POST", "/ENG-1/subtasks", { title: "Write API" });
    expect(response.status).toBe(201);
    expect((await response.json()).issue).toMatchObject({ key: "ENG-1.2", kind: "subtask", title: "Write API" });
    expect(await failure(await send(t, "POST", "/ENG-1/nope", {}))).toEqual({ status: 404, code: "not_found" });
  });

  test("DSH gates: list refusals, PATCH validation, proof URL and clearing, comment body, sub-task parent", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    expect(await failure(await send(t, "GET", "?team=NOPE"))).toEqual({ status: 404, code: "not_found" });
    expect(await failure(await send(t, "GET", "?team=ENG&status=doing"))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await send(t, "GET", ""))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await send(t, "POST", "/eng-x/subtasks", { title: "x" }))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await send(t, "PATCH", "/ENG-1", { status: "doing" }))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await send(t, "PATCH", "/ENG-1", { priority: "huge" }))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await send(t, "PATCH", "/ENG-1", { type: "bug" }))).toEqual({ status: 400, code: "validation" });

    const badUrl = await send(t, "POST", "/ENG-1.1/proof", { proofUrl: "ftp://x" });
    expect(await badUrl.json()).toEqual({ code: "validation", message: "The proof must be an absolute http:// or https:// URL" });
    await send(t, "POST", "/ENG-1.1/proof", { proofUrl: "https://example.com/run/1" });
    const cleared = await send(t, "POST", "/ENG-1.1/proof", { proofUrl: "" });
    expect((await cleared.json()).issue.proofUrl).toBeUndefined();

    expect(await failure(await send(t, "POST", "/ENG-1/comments", { body: "   " }))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await send(t, "POST", "/ENG-1.1/subtasks", { title: "Too deep" }))).toEqual({ status: 409, code: "rule_refused" });
  });

  test("DSH gate: the story's Done gate sees the proof set over REST", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    await send(t, "POST", "/ENG-1.1/proof", { proofUrl: "https://example.com/run/1" });
    expect((await send(t, "PATCH", "/ENG-1.1", { status: "done" })).status).toBe(200);
    const done = await send(t, "PATCH", "/ENG-1", { status: "done" });
    expect(done.status).toBe(200);
    expect((await done.json()).issue).toMatchObject({ key: "ENG-1", status: "done" });
  });

  test("fix round: assignee=me from an agent with no row is 200 with no issues; a named unknown assignee is 404", async () => {
    const t = await workspaceTest();
    await post(t, { teamKey: "ENG", title: "Story" }, "cc1");
    const fresh = await send(t, "GET", "?team=ENG&assignee=me", undefined, { "X-Agent-Id": "newbie" });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual({ issues: [], nextCursor: null });
    expect(await failure(await send(t, "GET", "?team=ENG&assignee=nobody"))).toEqual({ status: 404, code: "not_found" });
  });
});
