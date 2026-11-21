// Helpers shared by the top-level Convex tests; Convex never bundles this file.
import type { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, vi } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import type schema from "./schema";

/** What `convexTest(schema, modules)` returns. */
export type Test = ReturnType<typeof convexTest<(typeof schema)["tables"]>>;

type AsMember = ReturnType<Test["withIdentity"]>;

export const refusalOf = (error: unknown) => (error instanceof ConvexError ? error.data : error);

const issueOf = (t: Test, issueId: Id<"issues">) => t.run(async (ctx) => (await ctx.db.get(issueId))!);

const feedOf = (t: Test, issueId: Id<"issues">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("activity")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect()
  );

/** The issue's version and activity row count, which a write that changes nothing must leave as they are. */
export async function footprint(t: Test, issueId: Id<"issues">) {
  return { version: (await issueOf(t, issueId)).version, rows: (await feedOf(t, issueId)).length };
}

/** An issue's row, its activity rows and its footprint, each read by id. */
export function issueReaders(t: Test) {
  return {
    issue: (issueId: Id<"issues">) => issueOf(t, issueId),
    feed: (issueId: Id<"issues">) => feedOf(t, issueId),
    footprint: (issueId: Id<"issues">) => footprint(t, issueId),
  };
}

/** Passes the story's done gate (P2.4): its testing sub-task gets a proof and moves to Done. Returns that sub-task. */
export async function passDoneGate(
  { t, asMember, orgId }: { t: Test; asMember: AsMember; orgId: Id<"organizations"> },
  storyId: Id<"issues">
) {
  const testing = await t.run(async (ctx) =>
    (
      await ctx.db
        .query("issues")
        .withIndex("by_org_and_parent", (q) => q.eq("orgId", orgId).eq("parentIssueId", storyId))
        .collect()
    ).find((child) => child.testing)
  );
  await asMember.mutation(api.issues.setProof, { issueId: testing!._id, proofUrl: "https://ci.example.com/run/1" });
  await asMember.mutation(api.issues.update, { issueId: testing!._id, status: "done" });
  return testing!._id;
}

/** Restores real timers after each test. Call it once, at the top of the file. */
export function registerRealTimers(): void {
  afterEach(() => {
    vi.useRealTimers();
  });
}
