import { Doc, Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { nextSubNumber } from "./levels";

export const TESTING_SUBTASK_TITLE = "Complete testing";

type GuardedAction = "deleted" | "moved";

const PROOF_PROTOCOLS = new Set(["http:", "https:"]);

/** Every new story starts with its Complete testing sub-task, KEY-n.1. */
export async function createTestingSubtask(
  ctx: MutationCtx,
  story: Doc<"issues">
): Promise<Id<"issues">> {
  return await ctx.db.insert("issues", {
    orgId: story.orgId,
    teamId: story.teamId,
    kind: "subtask",
    testing: true,
    subNumber: await nextSubNumber(ctx, story._id),
    title: TESTING_SUBTASK_TITLE,
    status: "todo",
    priority: "none",
    assigneeId: story.assigneeId,
    creatorId: story.creatorId,
    projectId: story.projectId,
    parentIssueId: story._id,
    sortOrder: story.sortOrder,
  });
}

export function assertNotTestingSubtask(issue: Doc<"issues">, action: GuardedAction): void {
  if (issue.testing) {
    throw new Error(`The ${TESTING_SUBTASK_TITLE} sub-task can't be ${action}`);
  }
}

export function assertTestingSubtask(issue: Doc<"issues">): void {
  if (!issue.testing) {
    throw new Error(`Only the ${TESTING_SUBTASK_TITLE} sub-task holds a proof URL`);
  }
}

function parsedProtocol(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/** A proof is an absolute http(s) URL; anything else is refused. */
export function assertProofUrl(url: string): void {
  const protocol = parsedProtocol(url);
  if (protocol === null || !PROOF_PROTOCOLS.has(protocol)) {
    throw new Error("The proof must be an absolute http:// or https:// URL");
  }
}
