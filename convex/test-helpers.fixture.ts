// Helpers shared by the top-level Convex tests; Convex never bundles this file.
import type { TestConvex } from "convex-test";
import { ConvexError } from "convex/values";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

type Test = TestConvex<typeof schema>;

export const refusalOf = (error: unknown) => (error instanceof ConvexError ? error.data : error);

export const issueOf = (t: Test, issueId: Id<"issues">) => t.run(async (ctx) => (await ctx.db.get(issueId))!);

export const feedOf = (t: Test, issueId: Id<"issues">) =>
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
