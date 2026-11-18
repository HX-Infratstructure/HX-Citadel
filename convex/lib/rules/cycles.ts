import { Id } from "../../_generated/dataModel";
import { refuse } from "../refusals";
import { MutationCtx } from "../../_generated/server";
import { cycleName } from "../../../lib/sprint";
import { getOrgCycle } from "../cycles";
import { orgRow } from "../orgRows";

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
  const owner = (await orgRow(ctx, orgId, cycle.teamId))?.key;
  const wanted = (await orgRow(ctx, orgId, teamId))?.key;
  refuse(`${cycleName(cycle)} belongs to team ${owner}; pick a cycle from team ${wanted}`);
}
