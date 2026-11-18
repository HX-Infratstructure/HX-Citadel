import { Doc, Id } from "../../_generated/dataModel";
import { invalid, refuse } from "../refusals";
import { MutationCtx } from "../../_generated/server";
import { logActivity } from "../activity";
import { nextSubNumber } from "./levels";

export const TESTING_SUBTASK_TITLE = "Complete testing";

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
    subNumber: await nextSubNumber(ctx, story.orgId, story._id),
    title: TESTING_SUBTASK_TITLE,
    status: "todo",
    priority: "none",
    assigneeId: story.assigneeId,
    creatorId: story.creatorId,
    projectId: story.projectId,
    parentIssueId: story._id,
    sortOrder: story.sortOrder,
  });
  await logActivity(ctx, {
    orgId: story.orgId,
    issueId: subtaskId,
    actorId: story.creatorId,
    type: "created",
  });
  return subtaskId;
}

export function assertNotTestingSubtask(issue: Doc<"issues">): void {
  if (issue.testing) {
    refuse(`The ${TESTING_SUBTASK_TITLE} sub-task can't be moved`);
  }
}

export function assertTestingSubtask(issue: Doc<"issues">): void {
  if (!issue.testing) {
    refuse(`Only the ${TESTING_SUBTASK_TITLE} sub-task holds a proof URL`);
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
    invalid("The proof must be an absolute http:// or https:// URL");
  }
}
