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
