/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG = "org_hx";
const DAY_MS = 24 * 60 * 60 * 1000;

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

const write = (t: T, method: string, path: string, body: unknown, headers: Record<string, string>) =>
  t.fetch(`/api/v1/issues${path}`, { method, headers: { "X-Agent-Id": "cc1", ...headers }, body: JSON.stringify(body) });

const keyed = (key: string, extra: Record<string, string> = {}) => ({ "Idempotency-Key": key, ...extra });

const storyCount = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query("issues").collect()).filter((issue) => issue.kind === "story").length);

const failure = async (response: Response) => ({ status: response.status, code: (await response.json()).code });

describe("Idempotency-Key", () => {
  test("a duplicate POST creates one story and returns the same status, body and ETag twice", async () => {
    const t = await setup();
    const first = await write(t, "POST", "", { teamKey: "ENG", title: "Once" }, keyed("k-1"));
    const second = await write(t, "POST", "", { title: "Once", teamKey: "ENG" }, keyed("k-1"));
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.headers.get("ETag")).toBe(first.headers.get("ETag"));
    expect(await second.json()).toEqual(await first.json());
    expect(await storyCount(t)).toBe(1);
  });

  test("two identical concurrent POSTs create one story with one creation activity row and return identical responses", async () => {
    const t = await setup();
    const send = () => write(t, "POST", "", { teamKey: "ENG", title: "Race" }, keyed("race"));
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.headers.get("ETag")).toBe(a.headers.get("ETag"));
    const body = await a.json();
    expect(await b.json()).toEqual(body);
    expect(await storyCount(t)).toBe(1);
    const created = await t.run(async (ctx) =>
      (await ctx.db.query("activity").collect()).filter((row) => row.type === "created" && row.issueId === body.issue._id)
    );
    expect(created).toHaveLength(1);
  });

  test("a replayed PATCH returns the stored status, body and ETag with no second effect on version or activity", async () => {
    const t = await setup();
    await write(t, "POST", "", { teamKey: "ENG", title: "Story" }, keyed("create"));
    const first = await write(t, "PATCH", "/ENG-1", { status: "in_progress" }, keyed("move"));
    await write(t, "PATCH", "/ENG-1", { status: "todo" }, keyed("back"));
    const activityBefore = await t.run(async (ctx) => (await ctx.db.query("activity").collect()).length);
    const replay = await write(t, "PATCH", "/ENG-1", { status: "in_progress" }, keyed("move"));
    expect(replay.status).toBe(first.status);
    expect(replay.headers.get("ETag")).toBe('"2"');
    expect(await replay.json()).toEqual(await first.json());
    const current = await (await t.fetch("/api/v1/issues/ENG-1", { headers: { "X-Agent-Id": "cc1" } })).json();
    expect([current.issue.version, current.issue.status]).toEqual([3, "todo"]);
    expect(await t.run(async (ctx) => (await ctx.db.query("activity").collect()).length)).toBe(activityBefore);
  });

  test("a duplicate PATCH applies once: the version moves to 2, not 3", async () => {
    const t = await setup();
    await write(t, "POST", "", { teamKey: "ENG", title: "Story" }, keyed("create"));
    const first = await write(t, "PATCH", "/ENG-1", { title: "Renamed" }, keyed("rename"));
    const second = await write(t, "PATCH", "/ENG-1", { title: "Renamed" }, keyed("rename"));
    expect(await second.json()).toEqual(await first.json());
    expect(second.headers.get("ETag")).toBe('"2"');
  });

  test("the same key with another body, route or If-Match is 409 idempotency_key_reused and applies nothing", async () => {
    const t = await setup();
    await write(t, "POST", "", { teamKey: "ENG", title: "Once" }, keyed("k-1"));
    expect(await failure(await write(t, "POST", "", { teamKey: "ENG", title: "Other" }, keyed("k-1")))).toEqual({
      status: 409,
      code: "idempotency_key_reused",
    });
    expect(await failure(await write(t, "POST", "/ENG-1/comments", { body: "hi" }, keyed("k-1")))).toEqual({
      status: 409,
      code: "idempotency_key_reused",
    });
    expect(await failure(await write(t, "POST", "", { teamKey: "ENG", title: "Once" }, keyed("k-1", { "If-Match": "1" })))).toEqual({
      status: 409,
      code: "idempotency_key_reused",
    });
    expect(await storyCount(t)).toBe(1);
  });

  test("the same key from a different agent is 409 and never returns the first agent's result", async () => {
    const t = await setup();
    await write(t, "POST", "", { teamKey: "ENG", title: "Once" }, keyed("k-1"));
    const other = await write(t, "POST", "", { teamKey: "ENG", title: "Once" }, keyed("k-1", { "X-Agent-Id": "cc2" }));
    expect(await failure(other)).toEqual({ status: 409, code: "idempotency_key_reused" });
    expect(await storyCount(t)).toBe(1);
  });

  test("a missing key on any write is 400 idempotency_key_required; a GET needs none", async () => {
    const t = await setup();
    await write(t, "POST", "", { teamKey: "ENG", title: "Story" }, keyed("create"));
    expect(await failure(await write(t, "POST", "", { teamKey: "ENG", title: "x" }, {}))).toEqual({ status: 400, code: "idempotency_key_required" });
    expect(await failure(await write(t, "POST", "", { teamKey: "ENG", title: "x" }, keyed("")))).toEqual({ status: 400, code: "idempotency_key_required" });
    expect(await failure(await write(t, "PATCH", "/ENG-1", { title: "x" }, {}))).toEqual({ status: 400, code: "idempotency_key_required" });
    expect(await failure(await write(t, "POST", "/ENG-1/proof", { proofUrl: "https://x.test" }, {}))).toEqual({
      status: 400,
      code: "idempotency_key_required",
    });
    expect(await failure(await write(t, "POST", "/ENG-1/comments", { body: "hi" }, {}))).toEqual({ status: 400, code: "idempotency_key_required" });
    expect(await failure(await write(t, "POST", "/ENG-1/subtasks", { title: "x" }, {}))).toEqual({ status: 400, code: "idempotency_key_required" });
    const get = await t.fetch("/api/v1/issues/ENG-1", { headers: { "X-Agent-Id": "cc1" } });
    expect(get.status).toBe(200);
    expect(await storyCount(t)).toBe(1);
  });

  test("a key must be 1 to 200 visible ASCII characters", async () => {
    const t = await setup();
    const body = { teamKey: "ENG", title: "x" };
    expect(await failure(await write(t, "POST", "", body, keyed("x".repeat(201))))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await write(t, "POST", "", body, keyed("has space")))).toEqual({ status: 400, code: "validation" });
    expect(await failure(await write(t, "POST", "", body, keyed("é")))).toEqual({ status: 400, code: "validation" });
    expect((await write(t, "POST", "", body, keyed("x".repeat(200)))).status).toBe(201);
  });

  test("a refused write stores no key, so the same key with a fixed body applies", async () => {
    const t = await setup();
    await write(t, "POST", "", { teamKey: "ENG", title: "Story" }, keyed("create"));
    const refused = await write(t, "PATCH", "/ENG-1", { title: "x" }, keyed("retry", { "If-Match": "7" }));
    expect(refused.status).toBe(412);
    const fixed = await write(t, "PATCH", "/ENG-1", { title: "Fixed" }, keyed("retry", { "If-Match": "1" }));
    expect(fixed.status).toBe(200);
    expect((await fixed.json()).issue.title).toBe("Fixed");
  });

  test("the cleanup removes keys older than 24 hours and keeps newer ones", async () => {
    const t = await setup();
    await write(t, "POST", "", { teamKey: "ENG", title: "Old" }, keyed("old"));
    await write(t, "POST", "", { teamKey: "ENG", title: "New" }, keyed("new"));
    await t.run(async (ctx) => {
      const old = (await ctx.db.query("idempotencyKeys").collect()).find((row) => row.key === "old");
      await ctx.db.patch(old!._id, { createdAt: Date.now() - DAY_MS - 1 });
    });
    await t.mutation(internal.agentApi.expireIdempotencyKeys, {});
    const left = await t.run(async (ctx) => (await ctx.db.query("idempotencyKeys").collect()).map((row) => row.key));
    expect(left).toEqual(["new"]);
  });
});
