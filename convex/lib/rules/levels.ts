import { Doc, Id } from "../../_generated/dataModel";
import { QueryCtx } from "../../_generated/server";
import { IssueKind } from "../../../lib/issue-key";

type Placement = {
  parentIssueId?: Id<"issues">;
  projectId?: Id<"projects">;
};

type ParentRule = {
  parent: IssueKind | null;
  parentRequired: boolean;
  projectRequired: boolean;
};

const PARENT_RULES: Record<IssueKind, ParentRule> = {
  epic: { parent: null, parentRequired: false, projectRequired: true },
  feature: { parent: "epic", parentRequired: true, projectRequired: false },
  story: { parent: "feature", parentRequired: false, projectRequired: false },
  subtask: { parent: "story", parentRequired: true, projectRequired: false },
};

function article(kind: IssueKind): string {
  return kind === "epic" ? "an" : "a";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function assertParentKind(kind: IssueKind, parentKind: IssueKind): void {
  const allowed = PARENT_RULES[kind].parent;
  const subject = capitalize(article(kind));
  if (allowed === null) {
    throw new Error(
      `${subject} ${kind} cannot have a parent (got ${article(parentKind)} ${parentKind})`
    );
  }
  if (parentKind !== allowed) {
    throw new Error(
      `${subject} ${kind}'s parent must be ${article(allowed)} ${allowed}, not ${article(parentKind)} ${parentKind}`
    );
  }
}

/** A child carries its parent's project: filled when missing, refused when different. */
function inheritedProject(
  kind: IssueKind,
  parent: Doc<"issues">,
  projectId: Id<"projects"> | undefined
): Id<"projects"> | undefined {
  if (projectId && projectId !== parent.projectId) {
    throw new Error(
      `${capitalize(article(kind))} ${kind}'s project must match its ${parent.kind}'s project`
    );
  }
  return parent.projectId;
}

/**
 * Enforce the level matrix (epic → project, feature → epic, story → feature or none,
 * subtask → story) and return the project the issue must carry.
 */
export async function assertValidParent(
  ctx: { db: QueryCtx["db"] },
  kind: IssueKind,
  placement: Placement
): Promise<Id<"projects"> | undefined> {
  const rule = PARENT_RULES[kind];
  const subject = capitalize(article(kind));
  if (rule.projectRequired && !placement.projectId) {
    throw new Error(`${subject} ${kind} needs a project`);
  }
  if (!placement.parentIssueId) {
    if (rule.parentRequired && rule.parent) {
      throw new Error(
        `${subject} ${kind} needs ${article(rule.parent)} ${rule.parent} as its parent`
      );
    }
    return placement.projectId;
  }
  const parent = await ctx.db.get(placement.parentIssueId);
  if (!parent) {
    throw new Error("Parent issue not found");
  }
  assertParentKind(kind, parent.kind);
  return inheritedProject(kind, parent, placement.projectId);
}

/** Next subtask number under a story. Mutations are serializable, so max + 1 is safe. */
export async function nextSubNumber(
  ctx: { db: QueryCtx["db"] },
  storyId: Id<"issues">
): Promise<number> {
  const subtasks = await ctx.db
    .query("issues")
    .withIndex("by_parent", (q) => q.eq("parentIssueId", storyId))
    .collect();
  const highest = Math.max(0, ...subtasks.map((subtask) => subtask.subNumber ?? 0));
  return highest + 1;
}
