import { Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { cycleName } from "../../../lib/sprint";
import { getOrgCycle } from "../cycles";

async function teamKey(ctx: MutationCtx, teamId: Id<"teams">): Promise<string | undefined> {
  return (await ctx.db.get(teamId))?.key;
}

/** An issue's cycle must be one of its own team's cycles, in the same org. */
export async function assertCycleInTeam(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  cycleId: Id<"cycles">,
  teamId: Id<"teams">
): Promise<void> {
  const cycle = await getOrgCycle(ctx, orgId, cycleId);
  if (cycle.teamId === teamId) {
    return;
  }
  const owner = await teamKey(ctx, cycle.teamId);
  const wanted = await teamKey(ctx, teamId);
  throw new Error(`${cycleName(cycle)} belongs to team ${owner}; pick a cycle from team ${wanted}`);
}
