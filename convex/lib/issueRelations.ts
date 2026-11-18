import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

/** Relations one issue can hold, so every read of them is one bounded read that sees them all. */
export const RELATION_LIMIT = 100;

/** An issue's relations: those stored on it, then those stored on the other end. */
export async function relationsOf(ctx: { db: QueryCtx["db"] }, issueId: Id<"issues">) {
  const outgoing = await ctx.db
    .query("issueRelations")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .take(RELATION_LIMIT);
  const incoming = await ctx.db
    .query("issueRelations")
    .withIndex("by_related", (q) => q.eq("relatedIssueId", issueId))
    .take(RELATION_LIMIT);
  return [...outgoing, ...incoming];
}
