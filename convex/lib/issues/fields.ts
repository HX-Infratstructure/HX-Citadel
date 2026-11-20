import { Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { findMembership } from "../mirror";
import { invalid, notFound } from "../refusals";

/** An assignee must be a member of the workspace. A non-member is never loaded, so the refusal can't name them. */
export async function assertAssignee(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">
): Promise<void> {
  if ((await findMembership(ctx, orgId, userId)) === null) {
    notFound("Assignee not found");
  }
}

/** A title as stored: trimmed, and never empty. Every create and update path comes through here. */
export function issueTitle(text: string): string {
  const title = text.trim();
  if (title === "") {
    invalid("Title cannot be empty");
  }
  return title;
}
