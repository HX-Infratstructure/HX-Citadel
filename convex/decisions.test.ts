/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { answerDecision, askDecision } from "./lib/decisions";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG = "org_hx";
const ADMIN = "user_admin";
const MEMBER = "user_member";
const WAITING = "ENG-1 is already waiting on the owner: Ship now?";

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
    for (const [clerkId, role] of [[ADMIN, "admin"], [MEMBER, "member"]] as const) {
      const userId = await ctx.db.insert("users", { clerkId, name: clerkId, email: `${clerkId}@example.com` });
      await ctx.db.insert("members", { orgId, userId, role, clerkMembershipId: `mem_${clerkId}` });
    }
  });
  const { issue } = await t.mutation(internal.agentApi.createIssue, { agentName: "cc1", teamKey: "ENG", title: "Story" });
  return { t, issue };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

const as = (t: T, clerkId: string) => t.withIdentity({ subject: clerkId, org_id: ORG });

const ask = (t: T, fields: { question?: string; choices?: string[]; recommended?: string } = {}, key = "ENG-1") =>
  t.mutation(internal.agentApi.askDecision, { agentName: "cc1", key, question: "Ship now?", ...fields });

const answer = (t: T, decisionId: Id<"decisions">, fields: { choice?: string; text?: string }) =>
  as(t, ADMIN).mutation(api.decisions.answer, { decisionId, ...fields });

async function issueState(t: T, issueId: Id<"issues">) {
  return await t.run(async (ctx) => {
    const issue = await ctx.db.get(issueId);
    const activity = await ctx.db
      .query("activity")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    return { status: issue?.status, version: issue?.version, activity };
  });
}

let keyCount = 0;
const writeHeaders = () => ({ "X-Agent-Id": "cc1", "Idempotency-Key": `decision-${++keyCount}` });

describe("asking a decision", () => {
  test("creates an open decision and one decision_asked row, and leaves the issue alone", async () => {
    const { t, issue } = await setup();
    const before = await issueState(t, issue._id);
    const { decision } = await ask(t, { choices: ["Yes", "No"], recommended: "Yes" });
    expect(decision).toMatchObject({ status: "open", question: "Ship now?", choices: ["Yes", "No"], recommended: "Yes" });
    const after = await issueState(t, issue._id);
    expect({ status: after.status, version: after.version }).toEqual({ status: before.status, version: before.version });
    expect(after.activity.length - before.activity.length).toBe(1);
    expect(after.activity.at(-1)).toMatchObject({ type: "decision_asked", newValue: "Ship now?" });
  });

  test("a second ask while one is open is refused", async () => {
    const { t } = await setup();
    await ask(t);
    await expect(ask(t, { question: "Another?" })).rejects.toThrow(WAITING);
  });

  test("after an answer, a new ask works", async () => {
    const { t } = await setup();
    const { decision } = await ask(t);
    await answer(t, decision._id, { text: "Yes" });
    const second = await ask(t, { question: "Next?" });
    expect(second.decision.status).toBe("open");
  });

  test.each([
    [{ question: "  " }, "the question must be 1 to 500"],
    [{ question: "x".repeat(501) }, "the question must be 1 to 500"],
    [{ choices: ["Only"] }, "give 2 to 5 choices, not 1"],
    [{ choices: ["A", "B", "C", "D", "E", "F"] }, "give 2 to 5 choices, not 6"],
    [{ choices: ["A", "x".repeat(61)] }, "each choice must be 1 to 60"],
    [{ choices: ["A", ""] }, "each choice must be 1 to 60"],
    [{ choices: ["A", " A "] }, "the choices must all be different"],
    [{ choices: ["A", "B"], recommended: "C" }, '"C" is not one of the choices'],
    [{ recommended: "A" }, '"A" is not one of the choices'],
  ])("refuses invalid input %o", async (fields, message) => {
    const { t } = await setup();
    await expect(ask(t, fields)).rejects.toThrow(`Invalid decision: ${message}`);
  });
});

describe("decisions are asked on stories", () => {
  test("a sub-task is refused, naming its story", async () => {
    const { t } = await setup();
    await expect(ask(t, {}, "ENG-1.1")).rejects.toThrow("Decisions are asked on stories: ask on ENG-1");
  });

  test.each(["epic", "feature"] as const)("kind %s is refused", async (kind) => {
    const { t, issue } = await setup();
    const issueId = await t.run(async (ctx) => {
      await ctx.db.patch(issue._id, { kind });
      return issue._id;
    });
    const refusal = t.run(async (ctx) => {
      const org = (await ctx.db.query("organizations").first())!;
      const agent = (await ctx.db.query("users").withIndex("by_clerk_id", (q) => q.eq("clerkId", "agent:cc1")).unique())!;
      return await askDecision(ctx, { org, actorId: agent._id }, { issueId, question: "Ship?" });
    });
    await expect(refusal).rejects.toThrow("Decisions are asked on stories");
  });

  test("a sub-task over REST is 409 rule_refused", async () => {
    const { t } = await setup();
    const response = await t.fetch("/api/v1/issues/ENG-1.1/decisions", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ question: "Ship?" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "rule_refused", message: "Decisions are asked on stories: ask on ENG-1" });
  });
});

describe("answering a decision", () => {
  test("a non-admin member is refused", async () => {
    const { t } = await setup();
    const { decision } = await ask(t);
    await expect(as(t, MEMBER).mutation(api.decisions.answer, { decisionId: decision._id, text: "Yes" })).rejects.toThrow(
      "Admin access required"
    );
  });

  test("a choice that is not among the choices is refused", async () => {
    const { t } = await setup();
    const { decision } = await ask(t, { choices: ["Yes", "No"] });
    await expect(answer(t, decision._id, { choice: "Maybe" })).rejects.toThrow('"Maybe" is not one of the choices');
  });

  test("an empty answer is refused", async () => {
    const { t } = await setup();
    const { decision } = await ask(t);
    await expect(answer(t, decision._id, {})).rejects.toThrow("answer with a choice, a text, or both");
  });

  test("records the answer via the story and one decided row, with no status or version change", async () => {
    const { t, issue } = await setup();
    const { decision } = await ask(t, { choices: ["Yes", "No"] });
    const before = await issueState(t, issue._id);
    await answer(t, decision._id, { choice: "Yes", text: "Ship it after the gate." });
    const after = await issueState(t, issue._id);
    expect({ status: after.status, version: after.version }).toEqual({ status: before.status, version: before.version });
    expect(after.activity.length - before.activity.length).toBe(1);
    expect(after.activity.at(-1)).toMatchObject({ type: "decided", newValue: "Yes: Ship it after the gate." });
    const listed = await as(t, MEMBER).query(api.decisions.listForIssue, { issueId: issue._id });
    expect(listed[0]).toMatchObject({
      status: "answered",
      answer: { choice: "Yes", text: "Ship it after the gate." },
      answeredVia: "story",
      asker: "cc1",
      answerer: ADMIN,
    });
  });

  test("a second answer is refused, so a race has one winner", async () => {
    const { t } = await setup();
    const { decision } = await ask(t);
    await answer(t, decision._id, { text: "Yes" });
    await expect(answer(t, decision._id, { text: "No" })).rejects.toThrow("This decision was already answered");
  });

  test("an answer carried back from the Inbox records inbox", async () => {
    const { t } = await setup();
    const { decision } = await ask(t);
    const stored = await t.run(async (ctx) => {
      const org = (await ctx.db.query("organizations").first())!;
      const admin = (await ctx.db.query("users").withIndex("by_clerk_id", (q) => q.eq("clerkId", ADMIN)).unique())!;
      await answerDecision(ctx, { org, actorId: admin._id }, { decisionId: decision._id, text: "Yes" }, "inbox");
      return await ctx.db.get(decision._id);
    });
    expect(stored).toMatchObject({ status: "answered", answeredVia: "inbox" });
  });
});

describe("REST /api/v1/issues/{key}/decisions", () => {
  test("POST asks and GET lists, newest first", async () => {
    const { t, issue } = await setup();
    const first = await t.fetch("/api/v1/issues/ENG-1/decisions", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ question: "Ship now?", choices: ["Yes", "No"] }),
    });
    expect(first.status).toBe(201);
    const { decision } = (await first.json()) as { decision: { _id: Id<"decisions"> } };
    await answer(t, decision._id, { choice: "No" });
    await ask(t, { question: "Later?" });
    const list = await t.fetch("/api/v1/issues/ENG-1/decisions", { headers: { "X-Agent-Id": "cc1" } });
    expect(list.status).toBe(200);
    const { decisions } = (await list.json()) as { decisions: { question: string; issueId: string }[] };
    expect(decisions.map((d) => d.question)).toEqual(["Later?", "Ship now?"]);
    expect(decisions[0].issueId).toBe(issue._id);
  });

  test("a second ask is 409 rule_refused, even when the waiting question reads like another error", async () => {
    const { t } = await setup();
    await ask(t, { question: "Login page not found: fix now?" });
    const response = await t.fetch("/api/v1/issues/ENG-1/decisions", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ question: "Another?" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "rule_refused",
      message: "ENG-1 is already waiting on the owner: Login page not found: fix now?",
    });
  });

  test("invalid input is 400 validation", async () => {
    const { t } = await setup();
    const response = await t.fetch("/api/v1/issues/ENG-1/decisions", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ question: "Pick", choices: ["A"] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation" });
  });

  test("an Idempotency-Key replay returns the same decision, not a second one", async () => {
    const { t, issue } = await setup();
    const request = { method: "POST", headers: writeHeaders(), body: JSON.stringify({ question: "Ship now?" }) };
    const first = (await (await t.fetch("/api/v1/issues/ENG-1/decisions", request)).json()) as { decision: { _id: string } };
    const replay = await t.fetch("/api/v1/issues/ENG-1/decisions", request);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { decision: { _id: string } }).decision._id).toBe(first.decision._id);
    const count = await t.run(async (ctx) =>
      (await ctx.db.query("decisions").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).collect()).length
    );
    expect(count).toBe(1);
  });

  test("a stale If-Match is 412", async () => {
    const { t, issue } = await setup();
    const response = await t.fetch("/api/v1/issues/ENG-1/decisions", {
      method: "POST",
      headers: { ...writeHeaders(), "If-Match": `"${(issue.version ?? 1) + 1}"` },
      body: JSON.stringify({ question: "Ship now?" }),
    });
    expect(response.status).toBe(412);
  });

  test("an agent cannot answer: no answer route exists", async () => {
    const { t } = await setup();
    const { decision } = await ask(t);
    const response = await t.fetch(`/api/v1/issues/ENG-1/decisions/${decision._id}/answer`, {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ text: "Yes" }),
    });
    expect(response.status).toBe(404);
    expect(await t.run((ctx) => ctx.db.get(decision._id))).toMatchObject({ status: "open" });
  });
});
