import { formatIssueKey } from "../../../lib/issue-key";
import { GATED_LABELS, isGatedStatus } from "../../../lib/issue-status";
import { Doc } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { TESTING_SUBTASK_TITLE } from "./testing";

type IssueStatus = Doc<"issues">["status"];

/**
 * Canceled work is out of scope, so a canceled child never holds its parent back. The one
 * exception is a story's Complete testing sub-task, which must be done (P2.4).
 */
export const CLOSED_STATUSES: ReadonlySet<IssueStatus> = new Set(["done", "canceled"]);

const NO_PROOF = "(no proof link)";

function isStoryTesting(parent: Doc<"issues">, child: Doc<"issues">): boolean {
  return parent.kind === "story" && child.testing === true;
}

function isOpen(parent: Doc<"issues">, child: Doc<"issues">): boolean {
  if (isStoryTesting(parent, child)) {
    return child.status !== "done";
  }
  return !CLOSED_STATUSES.has(child.status);
}

function lacksProof(parent: Doc<"issues">, child: Doc<"issues">): boolean {
  return isStoryTesting(parent, child) && !child.proofUrl;
}

function issueLabel(teamKey: string, issue: Doc<"issues">, parentNumber?: number): string {
  const key = formatIssueKey(teamKey, issue, parentNumber);
  return key === null ? issue.title : `${key} ${issue.title}`;
}

function blockerLabel(teamKey: string, parent: Doc<"issues">, child: Doc<"issues">): string {
  const label = issueLabel(teamKey, child, parent.number);
  return lacksProof(parent, child) ? `${label} ${NO_PROOF}` : label;
}

function missingTestingSubtask(parent: Doc<"issues">, children: Doc<"issues">[]): boolean {
  return parent.kind === "story" && !children.some((child) => child.testing === true);
}

function blockers(teamKey: string, parent: Doc<"issues">, children: Doc<"issues">[]): string[] {
  const listed = children
    .filter((child) => isOpen(parent, child) || lacksProof(parent, child))
    .map((child) => blockerLabel(teamKey, parent, child));
  if (missingTestingSubtask(parent, children)) {
    listed.push(`${TESTING_SUBTASK_TITLE} ${NO_PROOF}`);
  }
  return listed;
}

/**
 * In Review and Done need every direct child done (or canceled); a story also needs its
 * Complete testing sub-task done, never canceled, with a proof link. The refusal lists
 * what is still open.
 */
export async function assertDoneGate(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  nextStatus: IssueStatus
): Promise<void> {
  if (!isGatedStatus(nextStatus)) {
    return;
  }
  const target = GATED_LABELS[nextStatus];
  const children = await ctx.db
    .query("issues")
    .withIndex("by_parent", (q) => q.eq("parentIssueId", issue._id))
    .collect();
  const team = await ctx.db.get(issue.teamId);
  const teamKey = team?.key ?? "";
  const open = blockers(teamKey, issue, children);
  if (open.length > 0) {
    const name = formatIssueKey(teamKey, issue) ?? issue.title;
    throw new Error(`Can't move ${name} to ${target}: open — ${open.join(", ")}`);
  }
}

/** An update that changes status is gated against the status it would leave. */
export async function assertDoneGateAfterUpdate(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  updates: Partial<Doc<"issues">>
): Promise<void> {
  if (updates.status === undefined) {
    return;
  }
  await assertDoneGate(ctx, issue, updates.status);
}
