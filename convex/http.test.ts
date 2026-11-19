/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG = "org_hx";

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

let keyCount = 0;
const writeHeaders = () => ({ "X-Agent-Id": "cc1", "Idempotency-Key": `http-test-${++keyCount}` });

const send = async (t: T, method: string, path: string, body?: string) => {
  const response = await t.fetch(`/api/v1/issues${path}`, {
    method,
    headers: method === "GET" ? { "X-Agent-Id": "cc1" } : writeHeaders(),
    body,
  });
  return { status: response.status, body: await response.json() };
};

describe("the agent routes' request contract", () => {
  test.each(["[]", '"a story"', "1", "null", "true"])("a JSON body %s that is not an object is 400 validation", async (body) => {
    const t = await setup();
    expect(await send(t, "POST", "", body)).toEqual({
      status: 400,
      body: { code: "validation", message: "The request body must be a JSON object" },
    });
  });

  test.each([
    ["a body field of the wrong type", "POST", "", { teamKey: "ENG", title: 1 }],
    ["a body field the mutation does not take", "POST", "", { teamKey: "ENG", title: "x", colour: "red" }],
    ["a body without a required field", "POST", "", { teamKey: "ENG" }],
    ["a PATCH field outside its union", "PATCH", "/ENG-1", { priority: "huge" }],
  ])("%s is refused by the function's validator as 400 validation with the validator's words", async (_label, method, path, body) => {
    const t = await setup();
    await send(t, "POST", "", JSON.stringify({ teamKey: "ENG", title: "Story" }));
    const refused = await send(t, method, path, JSON.stringify(body));
    expect(refused).toEqual({ status: 400, body: { code: "validation", message: expect.stringMatching(/^Validator error: /) } });
  });

  test("a query parameter outside its union is refused by the query's validator as 400 validation", async () => {
    const t = await setup();
    expect(await send(t, "GET", "?team=ENG&status=doing")).toEqual({
      status: 400,
      body: { code: "validation", message: expect.stringMatching(/^Validator error: /) },
    });
  });
});

async function withStory() {
  const t = await setup();
  await send(t, "POST", "", JSON.stringify({ teamKey: "ENG", title: "Story" }));
  return t;
}

const answer = async (t: T, method: string, path: string, body?: unknown) => {
  const response = await t.fetch(`/api/v1/issues${path}`, {
    method,
    headers: method === "GET" ? { "X-Agent-Id": "cc1" } : writeHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, etag: response.headers.get("ETag"), body: await response.json() };
};

describe("the /api/v1/issues/{key}[/{action}] routes", () => {
  test.each([
    ["GET", "/ENG-1", undefined, 200, '"1"', ["issue", "subtasks"]],
    ["GET", "/ENG-1/decisions", undefined, 200, null, ["decisions"]],
    ["PATCH", "/ENG-1", { title: "Renamed" }, 200, '"2"', ["issue"]],
    ["POST", "/ENG-1.1/proof", { proofUrl: "https://example.com/run/1" }, 200, '"2"', ["issue"]],
    ["POST", "/ENG-1/comments", { body: "Started" }, 201, null, ["comment"]],
    ["POST", "/ENG-1/subtasks", { title: "Write API" }, 201, '"1"', ["issue"]],
    ["POST", "/ENG-1/decisions", { question: "Ship it?" }, 201, null, ["decision"]],
  ])("%s %s answers %i with its body and ETag %s", async (method, path, body, status, etag, keys) => {
    const t = await withStory();
    const response = await answer(t, method, path, body);
    expect({ status: response.status, etag: response.etag, keys: Object.keys(response.body).sort() }).toEqual({ status, etag, keys });
  });

  test.each([
    ["PATCH", "/ENG-1/nope"],
    ["POST", "/ENG-1/nope"],
    ["POST", "/ENG-1"],
  ])("a write without Idempotency-Key is 400 before its path is read: %s %s", async (method, path) => {
    const t = await withStory();
    const response = await t.fetch(`/api/v1/issues${path}`, { method, headers: { "X-Agent-Id": "cc1" }, body: "{}" });
    expect({ status: response.status, code: (await response.json()).code }).toEqual({ status: 400, code: "idempotency_key_required" });
  });

  test.each([
    ["GET", "/ENG-1/nope", "No route for /api/v1/issues/ENG-1/nope"],
    ["PATCH", "/ENG-1/nope", "No route for /api/v1/issues/ENG-1/nope"],
    ["POST", "/ENG-1/nope", "No route for /api/v1/issues/ENG-1/nope"],
    ["POST", "/ENG-1/comments/extra", "No route for /api/v1/issues/ENG-1/comments/extra"],
    ["GET", "/ENG-1/proof", "No GET route for /api/v1/issues/ENG-1/proof"],
    ["GET", "/ENG-1/subtasks", "No GET route for /api/v1/issues/ENG-1/subtasks"],
    ["PATCH", "/ENG-1/comments", "No PATCH route for /api/v1/issues/ENG-1/comments"],
    ["PATCH", "/ENG-1/decisions", "No PATCH route for /api/v1/issues/ENG-1/decisions"],
    ["POST", "/ENG-1", "No POST route for /api/v1/issues/ENG-1"],
  ])("%s %s is 404 not_found and changes nothing", async (method, path, message) => {
    const t = await withStory();
    const response = await answer(t, method, path, method === "GET" ? undefined : {});
    expect(response).toEqual({ status: 404, etag: null, body: { code: "not_found", message } });
    expect((await answer(t, "GET", "/ENG-1")).body.issue.version).toBe(1);
  });

  test("a method no route takes on a known path is the router's own 404", async () => {
    const t = await withStory();
    const response = await t.fetch("/api/v1/issues/ENG-1", { method: "DELETE", headers: writeHeaders() });
    expect(response.status).toBe(404);
    expect((await answer(t, "GET", "/ENG-1")).status).toBe(200);
  });

  test("a sub-task route on a malformed key is 400 validation naming the key", async () => {
    const t = await withStory();
    expect(await answer(t, "POST", "/eng-x/subtasks", { title: "x" })).toEqual({
      status: 400,
      etag: null,
      body: { code: "validation", message: "invalid issue key eng-x; use KEY-12 or KEY-12.3" },
    });
  });
});

describe("a sub-task through either create route", () => {
  const sameFields = ({ _id, _creationTime, key, subNumber, sortOrder, ...fields }: Record<string, unknown>) => {
    expect([_id, _creationTime, key, subNumber, sortOrder]).not.toContain(undefined);
    return fields;
  };

  test.each([
    ["with teamKey", { teamKey: "ENG" }],
    ["without teamKey", {}],
  ])("POST /issues with parentKey, %s, makes the same sub-task as POST /issues/{key}/subtasks", async (_label, team) => {
    const t = await withStory();
    const viaStory = await answer(t, "POST", "/ENG-1/subtasks", { title: "Write API" });
    const viaCreate = await answer(t, "POST", "", { ...team, title: "Write API", kind: "subtask", parentKey: "ENG-1" });
    expect(viaStory).toMatchObject({ status: 201, etag: '"1"', body: { issue: { key: "ENG-1.2", parentIssueId: expect.any(String) } } });
    expect(viaCreate).toMatchObject({ status: 201, etag: '"1"', body: { issue: { key: "ENG-1.3" } } });
    expect(sameFields(viaCreate.body.issue)).toEqual(sameFields(viaStory.body.issue));
  });

  test("POST /issues with neither teamKey nor parentKey is 400 validation", async () => {
    const t = await setup();
    const response = await answer(t, "POST", "", { title: "Rootless" });
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 400, code: "validation" });
  });

  test.each([
    ["POST /issues", "", { kind: "subtask", parentKey: "ENG-1" }],
    ["POST /issues/{key}/subtasks", "/ENG-1/subtasks", {}],
  ])("a teamKey that is not the parent's team is refused through %s", async (_label, path, parent) => {
    const t = await withStory();
    await t.run(async (ctx) => {
      const { orgId } = (await ctx.db.query("teams").first())!;
      await ctx.db.insert("teams", { orgId, name: "Operations", key: "OPS", nextIssueNumber: 1 });
    });
    const response = await answer(t, "POST", path, { teamKey: "OPS", title: "Elsewhere", ...parent });
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 409, code: "rule_refused" });
  });
});
