import { Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { patchIssue } from "../issueVersion";
import { orgChildren, requireOrgRow } from "../orgRows";

/** The counter every team is inserted with, so its first story is KEY-1. */
export const FIRST_ISSUE_NUMBER = 1;

/** The counter every story is inserted with, so its first subtask (Complete testing) is KEY-n.1. */
export const FIRST_SUB_NUMBER = 1;

/** Claim the team's next story number (ENG-1, ENG-2, ...) and start the story's own subtask counter. */
export async function claimStoryNumber(
  ctx: { db: MutationCtx["db"] },
  orgId: Id<"organizations">,
  teamId: Id<"teams">
): Promise<{ number: number; nextSubNumber: number }> {
  const team = await requireOrgRow(ctx, orgId, teamId, "Team");
  const number = team.nextIssueNumber;
  await ctx.db.patch(team._id, { nextIssueNumber: number + 1 });
  return { number, nextSubNumber: FIRST_SUB_NUMBER };
}

/**
 * Claim the next subtask number under a story. The story keeps a counter, so a key a moved or
 * deleted subtask held is never handed out again. The story is read here, inside the workspace,
 * so two claims in one mutation never get the same number. The counter is a bookkeeping field,
 * so claiming a number does not move the story's version.
 *
 * A story restored, imported or inserted by hand can lack the counter. Its first claim starts the
 * counter after the story's highest subtask in the workspace and stores it, so later claims count
 * on from there. A key a subtask vacated before the counter existed is unknown, so a claim can
 * hand it out again.
 */
export async function nextSubNumber(
  ctx: { db: MutationCtx["db"] },
  orgId: Id<"organizations">,
  storyId: Id<"issues">
): Promise<number> {
  const story = await requireOrgRow(ctx, orgId, storyId, "Parent issue");
  let subNumber = story.nextSubNumber;
  if (subNumber === undefined) {
    const subtasks = await orgChildren(ctx, orgId, storyId);
    subNumber = Math.max(FIRST_SUB_NUMBER, ...subtasks.map((subtask) => (subtask.subNumber ?? 0) + 1));
  }
  await patchIssue(ctx, story, { nextSubNumber: subNumber + 1 });
  return subNumber;
}
