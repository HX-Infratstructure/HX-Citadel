import { formatIssueKey } from "../../../lib/issue-key";
import { Doc } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { TESTING_SUBTASK_TITLE } from "./testing";

type IssueStatus = Doc<"issues">["status"];

const GATED_LABELS: Partial<Record<IssueStatus, string>> = {
  in_review: "In Review",
  done: "Done",
};

/** Canceled work is out of scope, so a canceled child never holds its parent back. */
export const CLOSED_STATUSES: ReadonlySet<IssueStatus> = new Set(["done", "canceled"]);

const NO_PROOF = "(no proof link)";

function isOpen(child: Doc<"issues">): boolean {
  return !CLOSED_STATUSES.has(child.status);
}

function lacksProof(parent: Doc<"issues">, child: Doc<"issues">): boolean {
  return parent.kind === "story" && child.testing === true && !child.proofUrl;
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
    .filter((child) => isOpen(child) || lacksProof(parent, child))
    .map((child) => blockerLabel(teamKey, parent, child));
  if (missingTestingSubtask(parent, children)) {
    listed.push(`${TESTING_SUBTASK_TITLE} ${NO_PROOF}`);
  }
  return listed;
}

/**
 * In Review and Done need every direct child done (or canceled); a story also needs its
 * Complete testing sub-task to carry a proof link. The refusal lists what is still open.
 */
export async function assertDoneGate(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  nextStatus: IssueStatus
): Promise<void> {
  const target = GATED_LABELS[nextStatus];
  if (target === undefined) {
    return;
  }
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
