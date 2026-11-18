import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

/** Verify a cycle belongs to the caller's org before any read/write. */
export async function getOrgCycle(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  cycleId: Id<"cycles">
): Promise<Doc<"cycles">> {
  const cycle = await ctx.db.get(cycleId);
  if (!cycle || cycle.orgId !== orgId) {
    throw new Error("Cycle not found");
  }
  return cycle;
}
