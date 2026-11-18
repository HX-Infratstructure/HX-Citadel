import { normalizeTeamKey } from "../../lib/issue-key";
import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

/** The org's team for a typed key, normalized as teams.create stores it. */
export async function findTeamByKey(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  rawKey: string
): Promise<Doc<"teams">> {
  const key = normalizeTeamKey(rawKey);
  const team = await ctx.db
    .query("teams")
    .withIndex("by_org_and_key", (q) => q.eq("orgId", orgId).eq("key", key))
    .unique();
  if (team === null) {
    throw new Error(`Team ${key} not found`);
  }
  return team;
}
