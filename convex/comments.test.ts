/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { MAX_MENTIONS } from "./comments";
import { LIST_LIMIT } from "./issues";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG = "org_hx";
const AUTHOR = "user_author";
const OTHER = "user_other";

/** A story with one comment by AUTHOR; OTHER is a plain member. */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG, name: "HX", slug: "hx" });
    const authorId = await ctx.db.insert("users", { clerkId: AUTHOR, name: "Author", email: "author@example.com" });
    const otherId = await ctx.db.insert("users", { clerkId: OTHER, name: "Other", email: "other@example.com" });
    await ctx.db.insert("members", { orgId, userId: authorId, role: "member", clerkMembershipId: "mem_author" });
    await ctx.db.insert("members", { orgId, userId: otherId, role: "member", clerkMembershipId: "mem_other" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 2 });
    const issueId = await ctx.db.insert("issues", {
      orgId,
      teamId,
      kind: "story",
      number: 1,
      title: "Story",
      status: "todo",
      priority: "none",
      creatorId: authorId,
      sortOrder: 1,
    });
    const commentId = await ctx.db.insert("comments", { orgId, issueId, authorId, body: "c0" });
    return { orgId, authorId, issueId, commentId };
  });
  return {
    t,
    author: t.withIdentity({ subject: AUTHOR, org_id: ORG }),
    other: t.withIdentity({ subject: OTHER, org_id: ORG }),
    ...ids,
  };
}

describe("comment permissions are typed rule refusals", () => {
  test("another member editing is refused", async () => {
    const s = await setup();
    await expect(s.other.mutation(api.comments.update, { commentId: s.commentId, body: "Mine now" })).rejects.toMatchObject({
      data: { code: "rule_refused", message: "Only the author can edit a comment" },
    });
  });

  test("another member deleting is refused and the comment stays", async () => {
    const s = await setup();
    await expect(s.other.mutation(api.comments.remove, { commentId: s.commentId })).rejects.toMatchObject({
      data: { code: "rule_refused", message: "Only the author or an admin can delete a comment" },
    });
    expect(await s.t.run(async (ctx) => await ctx.db.get(s.commentId))).not.toBeNull();
  });
});

describe("mentions", () => {
  test("more than MAX_MENTIONS people is a typed validation refusal and writes no comment", async () => {
    const s = await setup();
    const mentions = await s.t.run(async (ctx) => {
      const ids = [];
      for (let index = 0; index <= MAX_MENTIONS; index++) {
        ids.push(await ctx.db.insert("users", { clerkId: `user_${index}`, name: `User ${index}`, email: `u${index}@example.com` }));
      }
      return ids;
    });

    await expect(s.author.mutation(api.comments.create, { issueId: s.issueId, body: "Hi all", mentions })).rejects.toMatchObject({
      data: { code: "validation", message: `A comment can mention at most ${MAX_MENTIONS} people` },
    });
    const bodies = await s.t.run(async (ctx) => (await ctx.db.query("comments").collect()).map((row) => row.body));
    expect(bodies).toEqual(["c0"]);
  });

  test("MAX_MENTIONS different people is accepted, and only members are kept", async () => {
    const s = await setup();
    const outsiders = await s.t.run(async (ctx) => {
      const ids = [];
      for (let index = 1; index < MAX_MENTIONS; index++) {
        ids.push(await ctx.db.insert("users", { clerkId: `user_${index}`, name: `User ${index}`, email: `u${index}@example.com` }));
      }
      return ids;
    });
    const mentions = [s.authorId, ...outsiders];

    await s.author.mutation(api.comments.create, { issueId: s.issueId, body: "Hi me", mentions });

    const comments = await s.author.query(api.comments.listByIssue, { issueId: s.issueId });
    expect(comments.at(-1)).toMatchObject({ body: "Hi me", mentions: [s.authorId] });
  });
});

describe("listByIssue on an issue with more than LIST_LIMIT comments", () => {
  test("returns the newest LIST_LIMIT, oldest first", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let index = 1; index <= LIST_LIMIT; index++) {
        await ctx.db.insert("comments", { orgId: s.orgId, issueId: s.issueId, authorId: s.authorId, body: `c${index}` });
      }
    });

    const comments = await s.author.query(api.comments.listByIssue, { issueId: s.issueId });

    expect(comments.map((comment) => comment.body)).toEqual(Array.from({ length: LIST_LIMIT }, (_, index) => `c${index + 1}`));
  });
});
