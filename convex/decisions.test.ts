import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { QueryCtx } from "./_generated/server";
import { LIST_LIMIT } from "../lib/api-contract";
import { answerDecision, askDecision, DECISION_PAGE_MAX, listIssueDecisions, pageIssueDecisions } from "./lib/decisions";
import { AGENT, ORG, registerWorkspaceEnv, workspaceTest, writeHeaders, type WorkspaceTest } from "./workspace.fixture";

const ADMIN = "user_admin";
const MEMBER = "user_member";
const WAITING = "ENG-1 is already waiting on the owner: Ship now?";

registerWorkspaceEnv();

async function setup() {
  const t = await workspaceTest({ members: [{ clerkId: ADMIN, role: "admin" }, { clerkId: MEMBER, role: "member" }] });
  const { issue } = await t.mutation(internal.agentApi.createIssue, { agentName: "cc1", teamKey: "ENG", title: "Story" });
  return { t, issue };
}

const as = (t: WorkspaceTest, clerkId: string) => t.withIdentity({ subject: clerkId, org_id: ORG });

const ask = (t: WorkspaceTest, fields: { question?: string; choices?: string[]; recommended?: string } = {}, key = "ENG-1") =>
  t.mutation(internal.agentApi.askDecision, { agentName: "cc1", key, question: "Ship now?", ...fields });

const answer = (t: WorkspaceTest, decisionId: Id<"decisions">, fields: { choice?: string; text?: string }) =>
  as(t, ADMIN).mutation(api.decisions.answer, { decisionId, ...fields });

async function issueState(t: WorkspaceTest, issueId: Id<"issues">) {
  return await t.run(async (ctx) => {
    const issue = await ctx.db.get(issueId);
    const activity = await ctx.db
      .query("activity")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    return { status: issue?.status, version: issue?.version, activity };
  });
}

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
    await expect(ask(t, fields)).rejects.toMatchObject({
      data: { code: "validation", message: expect.stringContaining(`Invalid decision: ${message}`) },
    });
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
    await expect(
      as(t, MEMBER).mutation(api.decisions.answer, { decisionId: decision._id, text: "Yes" })
    ).rejects.toMatchObject({ data: { code: "rule_refused", message: "Admin access required" } });
  });

  test("a choice that is not among the choices is refused", async () => {
    const { t } = await setup();
    const { decision } = await ask(t, { choices: ["Yes", "No"] });
    await expect(answer(t, decision._id, { choice: "Maybe" })).rejects.toMatchObject({
      data: { code: "validation", message: 'Invalid decision: "Maybe" is not one of the choices' },
    });
  });

  test("a decision id that no longer exists is a typed not_found", async () => {
    const { t } = await setup();
    const { decision } = await ask(t);
    await t.run(async (ctx) => ctx.db.delete(decision._id));
    await expect(answer(t, decision._id, { text: "Yes" })).rejects.toMatchObject({
      data: { code: "not_found", message: "Decision not found" },
    });
  });

  test("another workspace's decision is a typed not_found and stays open", async () => {
    const { t } = await setup();
    const foreignId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const teamId = await ctx.db.insert("teams", { orgId, name: "Other", key: "OTH", nextIssueNumber: 2 });
      const askedBy = (await ctx.db.query("users").first())!._id;
      const issueId = await ctx.db.insert("issues", {
        orgId,
        teamId,
        number: 1,
        title: "Foreign story",
        kind: "story",
        status: "backlog",
        priority: "none",
        sortOrder: 0,
        creatorId: askedBy,
      });
      return await ctx.db.insert("decisions", { orgId, issueId, askedBy, question: "Theirs?", status: "open" });
    });
    await expect(answer(t, foreignId, { text: "Yes" })).rejects.toMatchObject({
      data: { code: "not_found", message: "Decision not found" },
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(foreignId))?.status)).toBe("open");
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
    const listed = await as(t, MEMBER).query(api.decisions.listForIssue, {
      issueId: issue._id,
      paginationOpts: { cursor: null, numItems: DECISION_PAGE_MAX },
    });
    expect(listed.page[0]).toMatchObject({
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

/** `count` answered decisions on the story, asked by the agent and answered by the admin, oldest first. */
async function seedDecisions(t: WorkspaceTest, issueId: Id<"issues">, count: number) {
  return await t.run(async (ctx) => {
    const { orgId } = (await ctx.db.get(issueId))!;
    const user = async (clerkId: string) =>
      (await ctx.db.query("users").withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId)).unique())!._id;
    const askedBy = await user("agent:cc1");
    const answeredBy = await user(ADMIN);
    for (let n = 1; n <= count; n++) {
      await ctx.db.insert("decisions", { orgId, issueId, askedBy, answeredBy, question: `Q${n}`, status: "answered" });
    }
    return { orgId, userIds: [askedBy, answeredBy] };
  });
}

const questions = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => `Q${from - i}`);

/** A context whose `db.get` counts the reads of the given users. */
function countingUserReads(ctx: QueryCtx, userIds: Id<"users">[]) {
  const reads = { users: 0 };
  const db = new Proxy(ctx.db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      if (property !== "get") {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        reads.users += args.some((arg) => userIds.includes(arg as Id<"users">)) ? 1 : 0;
        return value.apply(target, args);
      };
    },
  });
  return { ctx: { db }, reads };
}

describe("a story's decision history", () => {
  const page = (t: WorkspaceTest, issueId: Id<"issues">, cursor: string | null, numItems = DECISION_PAGE_MAX) =>
    as(t, MEMBER).query(api.decisions.listForIssue, { issueId, paginationOpts: { cursor, numItems } });

  test("with 10 more than a page, the first page holds the newest and its cursor reaches the other 10", async () => {
    const { t, issue } = await setup();
    await seedDecisions(t, issue._id, DECISION_PAGE_MAX + 10);
    const first = await page(t, issue._id, null);
    expect(first.page.map((d) => d.question)).toEqual(questions(DECISION_PAGE_MAX + 10, 11));
    expect(first.isDone).toBe(false);
    const rest = await page(t, issue._id, first.continueCursor);
    expect(rest.page.map((d) => d.question)).toEqual(questions(10, 1));
    expect(rest.isDone).toBe(true);
  });

  test("a client asking for more than a page still gets one page", async () => {
    const { t, issue } = await setup();
    await seedDecisions(t, issue._id, DECISION_PAGE_MAX + 10);
    const first = await page(t, issue._id, null, LIST_LIMIT);
    expect(first.page).toHaveLength(DECISION_PAGE_MAX);
  });

  test("another workspace's decision on our story never appears and takes no place on the page", async () => {
    const { t, issue } = await setup();
    await seedDecisions(t, issue._id, DECISION_PAGE_MAX);
    await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const askedBy = (await ctx.db.query("users").first())!._id;
      await ctx.db.insert("decisions", { orgId, issueId: issue._id, askedBy, question: "Theirs?", status: "open" });
    });
    const first = await page(t, issue._id, null);
    expect(first.page.map((d) => d.question)).toEqual(questions(DECISION_PAGE_MAX, 1));
  });

  type Listing = (
    ctx: { db: QueryCtx["db"] },
    orgId: Id<"organizations">,
    issueId: Id<"issues">
  ) => Promise<{ asker: string | null; answerer: string | null }[]>;
  const listings: [string, Listing][] = [
    [
      "a panel page",
      async (ctx, orgId, issueId) =>
        (await pageIssueDecisions(ctx, orgId, issueId, { cursor: null, numItems: DECISION_PAGE_MAX })).page,
    ],
    ["the REST list", listIssueDecisions],
  ];

  test.each(listings)("%s reads each of the 2 users once for a full page of their decisions", async (_, list) => {
    const { t, issue } = await setup();
    const { orgId, userIds } = await seedDecisions(t, issue._id, DECISION_PAGE_MAX);
    const { reads, rows } = await t.run(async (ctx) => {
      const counting = countingUserReads(ctx, userIds);
      const listed = await list(counting.ctx, orgId, issue._id);
      return { reads: counting.reads.users, rows: listed };
    });
    expect(rows).toHaveLength(DECISION_PAGE_MAX);
    expect(rows.every((row) => row.asker === "cc1" && row.answerer === ADMIN)).toBe(true);
    expect(reads).toBe(2);
  });
});

describe("REST /api/v1/issues/{key}/decisions", () => {
  test("GET lists at most LIST_LIMIT decisions, newest first", async () => {
    const { t, issue } = await setup();
    await t.run(async (ctx) => {
      const askedBy = (await ctx.db.query("users").first())!._id;
      for (let n = 0; n <= LIST_LIMIT; n++) {
        await ctx.db.insert("decisions", { orgId: issue.orgId, issueId: issue._id, askedBy, question: `Q${n}`, status: "answered" });
      }
    });
    const list = await t.fetch("/api/v1/issues/ENG-1/decisions", { headers: AGENT });
    const { decisions } = (await list.json()) as { decisions: { question: string }[] };
    expect(decisions).toHaveLength(LIST_LIMIT);
    expect(decisions[0].question).toBe(`Q${LIST_LIMIT}`);
  });

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
    const list = await t.fetch("/api/v1/issues/ENG-1/decisions", { headers: AGENT });
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
