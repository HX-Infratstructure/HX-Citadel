/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG = "org_hx";
const HUMAN = "user_human";

beforeEach(() => {
  process.env.HX_WORKSPACE_ORG_ID = ORG;
});

afterEach(() => {
  delete process.env.HX_WORKSPACE_ORG_ID;
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG, name: "HX", slug: "hx" });
    const humanId = await ctx.db.insert("users", { clerkId: HUMAN, name: "cc1", email: "human@example.com" });
    await ctx.db.insert("members", { orgId, userId: humanId, role: "admin", clerkMembershipId: "mem_human" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
    return { orgId, teamId };
  });
  const asHuman = t.withIdentity({ subject: HUMAN, org_id: ORG });
  const issueId = await asHuman.mutation(api.issues.create, { teamId: ids.teamId, title: "Story" });
  const comment = (agentName: string) =>
    t.mutation(internal.agentApi.createComment, { agentName, key: "ENG-1", body: `from ${agentName}` });
  const memberNames = async () => (await asHuman.query(api.organizations.listMembers, {})).map((m) => m.name);
  const removeAgent = (agentName: string) => t.mutation(internal.agentAdmin.removeAgent, { clerkOrgId: ORG, agentName });
  const agentId = (name: string) =>
    t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", `agent:${name}`))
        .unique();
      return user!._id;
    });
  return { t, asHuman, issueId, comment, memberNames, removeAgent, agentId, ...ids };
}

describe("agentAdmin.removeAgent", () => {
  test("a mistyped agent is removed and gone from listMembers", async () => {
    const { comment, memberNames, removeAgent } = await setup();
    await comment("cc1-typo");
    expect(await memberNames()).toContain("cc1-typo");

    expect(await removeAgent(" CC1-Typo ")).toEqual({ removed: true });

    expect(await memberNames()).toEqual(["cc1"]);
  });

  test("its old comments and activity still show its name", async () => {
    const { asHuman, issueId, comment, removeAgent } = await setup();
    await comment("cc1-typo");

    expect(await removeAgent("cc1-typo")).toEqual({ removed: true });

    const comments = await asHuman.query(api.comments.listByIssue, { issueId });
    expect(comments.map((c) => c.authorName)).toEqual(["cc1-typo"]);
    const activity = await asHuman.query(api.activity.listByIssue, { issueId });
    expect(activity.map((a) => a.actorName)).toContain("cc1-typo");
  });

  test("the agent's next request adds its membership back, with the same user", async () => {
    const { t, comment, memberNames, removeAgent } = await setup();
    const first = await comment("cc1-typo");
    await removeAgent("cc1-typo");

    const second = await comment("cc1-typo");

    expect(second.comment.authorId).toBe(first.comment.authorId);
    expect(await memberNames()).toContain("cc1-typo");
    expect(await t.run(async (ctx) => (await ctx.db.query("users").collect()).length)).toBe(2);
  });

  test("an agent with an assigned issue is refused, by issue, and stays a member", async () => {
    const { t, memberNames, removeAgent } = await setup();
    await t.mutation(internal.agentApi.createIssue, { agentName: "cc2", teamKey: "ENG", title: "Held", assignee: "cc2" });

    await expect(removeAgent("cc2")).rejects.toMatchObject({
      data: { code: "rule_refused", message: "cc2 still has ENG-2, ENG-2.1 assigned; reassign them first" },
    });
    expect(await memberNames()).toContain("cc2");
  });

  test("an assigned issue blocks removal in any status, Done and Canceled included", async () => {
    const { t, removeAgent } = await setup();
    const { issue } = await t.mutation(internal.agentApi.createIssue, {
      agentName: "cc2",
      teamKey: "ENG",
      title: "Finished",
      assignee: "cc2",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(issue._id, { status: "canceled" });
      for (const subtask of await ctx.db
        .query("issues")
        .withIndex("by_org_and_parent", (q) => q.eq("orgId", issue.orgId).eq("parentIssueId", issue._id))
        .collect()) {
        await ctx.db.patch(subtask._id, { status: "done" });
      }
    });

    await expect(removeAgent("cc2")).rejects.toMatchObject({
      data: { code: "rule_refused", message: "cc2 still has ENG-2, ENG-2.1 assigned; reassign them first" },
    });
  });

  test("an agent that leads a project is refused, by project", async () => {
    const { t, orgId, comment, memberNames, removeAgent, agentId } = await setup();
    await comment("cc2");
    const leadId: Id<"users"> = await agentId("cc2");
    await t.run((ctx) => ctx.db.insert("projects", { orgId, name: "Website", status: "planned", leadId }));

    await expect(removeAgent("cc2")).rejects.toMatchObject({
      data: { code: "rule_refused", message: "cc2 still leads Website; reassign them first" },
    });
    expect(await memberNames()).toContain("cc2");
  });

  test("a rerun, or a name that is no agent member, removes nothing, not even a human with that name", async () => {
    const { comment, memberNames, removeAgent } = await setup();
    await comment("cc1-typo");
    await removeAgent("cc1-typo");

    expect(await removeAgent("cc1-typo")).toEqual({ removed: false });
    expect(await removeAgent("cc1")).toEqual({ removed: false });
    expect(await memberNames()).toEqual(["cc1"]);
  });
});
