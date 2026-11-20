import { Doc, Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { logActivity } from "../activity";
import { patchIssue } from "../issueVersion";
import { OrgScope } from "../orgScope";
import { assertProofUrl, assertTestingSubtask } from "../rules/testing";
import { getOrgIssue } from "./shape";

async function logProofChange(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  proofUrl: string,
  actorId: Id<"users">
): Promise<void> {
  if (proofUrl === (issue.proofUrl ?? "")) {
    return;
  }
  await logActivity(ctx, {
    orgId: issue.orgId,
    issueId: issue._id,
    actorId,
    type: proofUrl === "" ? "proof_cleared" : "proof_set",
    field: "proof",
    oldValue: issue.proofUrl,
    newValue: proofUrl || undefined,
  });
}

/** Sets or clears (empty string) the proof URL on a Complete testing sub-task. */
export async function setIssueProof(
  ctx: MutationCtx,
  scope: OrgScope,
  args: { issueId: Id<"issues">; proofUrl: string }
): Promise<void> {
  const issue = await getOrgIssue(ctx, scope.org._id, args.issueId);
  assertTestingSubtask(issue);
  const proofUrl = args.proofUrl.trim();
  if (proofUrl !== "") {
    assertProofUrl(proofUrl);
  }
  await patchIssue(ctx, issue._id, { proofUrl: proofUrl || undefined });
  await logProofChange(ctx, issue, proofUrl, scope.actorId);
}
