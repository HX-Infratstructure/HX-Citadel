import { formatIssueKey, IssueKind } from "../../../lib/issue-key";
import { refuse } from "../refusals";
import { Doc, Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { orgRow } from "../orgRows";

export type WipCandidate = {
  orgId: Id<"organizations">;
  assigneeId?: Id<"users">;
  issueId?: Id<"issues">;
  kind: IssueKind;
  status: Doc<"issues">["status"];
};

function isStoryInProgress(issue: Pick<Doc<"issues">, "kind" | "status">): boolean {
  return issue.kind === "story" && issue.status === "in_progress";
}

async function otherStoryInProgress(
  ctx: MutationCtx,
  candidate: WipCandidate & { assigneeId: Id<"users"> }
): Promise<Doc<"issues"> | null> {
  const inProgress = await ctx.db
    .query("issues")
    .withIndex("by_assignee_kind_status", (q) =>
      q
        .eq("orgId", candidate.orgId)
        .eq("assigneeId", candidate.assigneeId)
        .eq("kind", "story")
        .eq("status", "in_progress")
    )
    .take(2);
  return inProgress.find((issue) => issue._id !== candidate.issueId) ?? null;
}

async function refusal(
  ctx: MutationCtx,
  assigneeId: Id<"users">,
  holder: Doc<"issues">
): Promise<string> {
  const assignee = await ctx.db.get(assigneeId);
  const team = await orgRow(ctx, holder.orgId, holder.teamId);
  const key = formatIssueKey(team?.key ?? "", holder) ?? holder.title;
  const name = assignee?.name ?? "This person";
  return `${name} already has ${key} In Progress; move it to In Review or Done first`;
}

/** One story In Progress per assignee per workspace; sub-tasks, epics and features never count. */
export async function assertWipFree(ctx: MutationCtx, candidate: WipCandidate): Promise<void> {
  const { assigneeId } = candidate;
  if (assigneeId === undefined || !isStoryInProgress(candidate)) {
    return;
  }
  const holder = await otherStoryInProgress(ctx, { ...candidate, assigneeId });
  if (holder !== null) {
    refuse(await refusal(ctx, assigneeId, holder));
  }
}

function touchesWip(updates: Partial<Doc<"issues">>): boolean {
  return "status" in updates || "assigneeId" in updates;
}

/** An update that changes status or assignee is checked against the issue as it would be left. */
export async function assertWipFreeAfterUpdate(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  updates: Partial<Doc<"issues">>
): Promise<void> {
  if (!touchesWip(updates)) {
    return;
  }
  const next = { ...issue, ...updates };
  await assertWipFree(ctx, {
    orgId: next.orgId,
    assigneeId: next.assigneeId,
    issueId: next._id,
    kind: next.kind,
    status: next.status,
  });
}
