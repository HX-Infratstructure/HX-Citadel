import { Doc, Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import { logActivity } from "../activity";
import { FIRST_VERSION } from "../issueVersion";
import { nextSubNumber } from "./levels";

export const TESTING_SUBTASK_TITLE = "Complete testing";

type GuardedAction = "deleted" | "moved";

const PROOF_PROTOCOLS = new Set(["http:", "https:"]);

/** Every new story starts with its Complete testing sub-task, KEY-n.1, logged as created by the story's creator. */
export async function createTestingSubtask(
  ctx: MutationCtx,
  story: Doc<"issues">
): Promise<Id<"issues">> {
  const subtaskId = await ctx.db.insert("issues", {
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
    version: FIRST_VERSION,
  });
  await logActivity(ctx, {
    orgId: story.orgId,
    issueId: subtaskId,
    actorId: story.creatorId,
    type: "created",
  });
  return subtaskId;
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

function parsedUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The parser reads `http:foo` as http://foo/, so the written `scheme://` is checked too. */
function isAbsoluteHttpUrl(url: string): boolean {
  const parsed = parsedUrl(url);
  if (parsed === null || !PROOF_PROTOCOLS.has(parsed.protocol) || parsed.hostname === "") {
    return false;
  }
  return url.toLowerCase().startsWith(`${parsed.protocol}//`);
}

/** A proof is an absolute http(s) URL with a host; anything else is refused. */
export function assertProofUrl(url: string): void {
  if (!isAbsoluteHttpUrl(url)) {
    throw new Error("The proof must be an absolute http:// or https:// URL");
  }
}
