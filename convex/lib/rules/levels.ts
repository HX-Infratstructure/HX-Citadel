import { Doc, Id } from "../../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../../_generated/server";
import { IssueKind, PARENT_KIND } from "../../../lib/issue-key";
import { ActivityActor, changedFields, logFieldChanges } from "../activity";

type Placement = {
  teamId: Id<"teams">;
  parentIssueId?: Id<"issues">;
  projectId?: Id<"projects">;
};

/** Where an issue sits once its parent's team and project are inherited. */
export type ResolvedPlacement = {
  teamId: Id<"teams">;
  projectId?: Id<"projects">;
};

type ParentRule = {
  parent: IssueKind | null;
  parentRequired: boolean;
  projectRequired: boolean;
};

const PARENT_RULES: Record<IssueKind, ParentRule> = {
  epic: { parent: PARENT_KIND.epic, parentRequired: false, projectRequired: true },
  feature: { parent: PARENT_KIND.feature, parentRequired: true, projectRequired: false },
  story: { parent: PARENT_KIND.story, parentRequired: false, projectRequired: false },
  subtask: { parent: PARENT_KIND.subtask, parentRequired: true, projectRequired: false },
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

function mismatch(kind: IssueKind, parentKind: IssueKind, field: string): Error {
  return new Error(
    `${capitalize(article(kind))} ${kind}'s ${field} must match its ${parentKind}'s ${field}`
  );
}

/** A child carries its parent's team; a different one is refused. */
function inheritedTeam(
  kind: IssueKind,
  parent: Doc<"issues">,
  teamId: Id<"teams">
): Id<"teams"> {
  if (teamId !== parent.teamId) {
    throw mismatch(kind, parent.kind, "team");
  }
  return parent.teamId;
}

/** A child carries its parent's project: filled when missing, refused when different. */
function inheritedProject(
  kind: IssueKind,
  parent: Doc<"issues">,
  projectId: Id<"projects"> | undefined
): Id<"projects"> | undefined {
  if (projectId && projectId !== parent.projectId) {
    throw mismatch(kind, parent.kind, "project");
  }
  return parent.projectId;
}

/**
 * Enforce the level matrix (epic → project, feature → epic, story → feature or none,
 * subtask → story) and return the team and project the issue must carry.
 */
export async function assertValidParent(
  ctx: { db: QueryCtx["db"] },
  kind: IssueKind,
  placement: Placement
): Promise<ResolvedPlacement> {
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
    return { teamId: placement.teamId, projectId: placement.projectId };
  }
  const parent = await ctx.db.get(placement.parentIssueId);
  if (!parent) {
    throw new Error("Parent issue not found");
  }
  assertParentKind(kind, parent.kind);
  return {
    teamId: inheritedTeam(kind, parent, placement.teamId),
    projectId: inheritedProject(kind, parent, placement.projectId),
  };
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

/** Every descendant of an issue, found by walking by_parent. */
async function descendants(
  ctx: { db: QueryCtx["db"] },
  rootId: Id<"issues">
): Promise<Doc<"issues">[]> {
  const found: Doc<"issues">[] = [];
  const pending = [rootId];
  while (pending.length > 0) {
    const parentId = pending.pop()!;
    const children = await ctx.db
      .query("issues")
      .withIndex("by_parent", (q) => q.eq("parentIssueId", parentId))
      .collect();
    found.push(...children);
    pending.push(...children.map((child) => child._id));
  }
  return found;
}

/** Children follow their parent's project, so a project change reaches every descendant. */
export async function cascadeProject(
  ctx: { db: MutationCtx["db"] },
  rootId: Id<"issues">,
  projectId: Id<"projects"> | undefined,
  actor: ActivityActor
): Promise<void> {
  for (const descendant of await descendants(ctx, rootId)) {
    const changes = changedFields(descendant, { projectId });
    if (changes.length > 0) {
      await ctx.db.patch(descendant._id, { projectId });
      await logFieldChanges(ctx, actor, descendant._id, changes);
    }
  }
}

/** Epics need a project, so a project that still has epics cannot be deleted. */
export function assertNoEpics(issues: Doc<"issues">[]): void {
  const epicCount = issues.filter((issue) => issue.kind === "epic").length;
  if (epicCount > 0) {
    const noun = epicCount === 1 ? "epic" : "epics";
    throw new Error(
      `This project still has ${epicCount} ${noun}; move or delete them first`
    );
  }
}
