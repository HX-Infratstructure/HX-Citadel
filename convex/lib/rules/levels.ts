import { Doc, Id } from "../../_generated/dataModel";
import { refuse } from "../refusals";
import { MutationCtx, QueryCtx } from "../../_generated/server";
import {
  childKindOf,
  IssueKind,
  PARENT_KIND,
  PARENT_REQUIRED,
  PROJECT_REQUIRED,
} from "../../../lib/issue-key";
import { GATED_LABELS, isGatedStatus } from "../../../lib/issue-status";
import { ActivityActor, changedFields, logFieldChanges } from "../activity";
import { IssueKeys } from "../issueKeys";
import { patchIssue } from "../issueVersion";
import { CASCADE_BUDGET, groupDigits, MAX_CHILDREN, orgChildren, requireOrgRow } from "../orgRows";

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

function article(kind: IssueKind): string {
  return kind === "epic" ? "an" : "a";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function assertParentKind(kind: IssueKind, parentKind: IssueKind): void {
  const allowed = PARENT_KIND[kind];
  const subject = capitalize(article(kind));
  if (allowed === null) {
    refuse(
      `${subject} ${kind} cannot have a parent (got ${article(parentKind)} ${parentKind})`
    );
  }
  if (parentKind !== allowed) {
    refuse(
      `${subject} ${kind}'s parent must be ${article(allowed)} ${allowed}, not ${article(parentKind)} ${parentKind}`
    );
  }
}

function mismatch(kind: IssueKind, parentKind: IssueKind, field: string): never {
  refuse(`${capitalize(article(kind))} ${kind}'s ${field} must match its ${parentKind}'s ${field}`);
}

/** A child carries its parent's team; a different one is refused. */
function inheritedTeam(
  kind: IssueKind,
  parent: Doc<"issues">,
  teamId: Id<"teams">
): Id<"teams"> {
  if (teamId !== parent.teamId) {
    mismatch(kind, parent.kind, "team");
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
    mismatch(kind, parent.kind, "project");
  }
  return parent.projectId;
}

/**
 * Enforce the level matrix (epic → project, feature → epic, story → feature or none,
 * subtask → story) and return the team and project the issue must carry.
 */
export async function assertValidParent(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  kind: IssueKind,
  placement: Placement
): Promise<ResolvedPlacement> {
  const parentKind = PARENT_KIND[kind];
  const subject = capitalize(article(kind));
  if (PROJECT_REQUIRED[kind] && !placement.projectId) {
    refuse(`${subject} ${kind} needs a project`);
  }
  if (!placement.parentIssueId) {
    if (PARENT_REQUIRED[kind] && parentKind) {
      refuse(
        `${subject} ${kind} needs ${article(parentKind)} ${parentKind} as its parent`
      );
    }
    if (placement.projectId) {
      await requireOrgRow(ctx, orgId, placement.projectId, "Project");
    }
    return { teamId: placement.teamId, projectId: placement.projectId };
  }
  const parent = await requireOrgRow(ctx, orgId, placement.parentIssueId, "Parent issue");
  assertParentKind(kind, parent.kind);
  return {
    teamId: inheritedTeam(kind, parent, placement.teamId),
    projectId: inheritedProject(kind, parent, placement.projectId),
  };
}

/**
 * Runs where a child joins a parent (create and move). The Done gate runs only on status changes, so an In Review
 * or Done parent takes no new child, and a parent with `MAX_CHILDREN` children takes no more.
 */
export async function assertParentOpen(
  ctx: { db: QueryCtx["db"] },
  parent: Doc<"issues">,
  childKind: IssueKind
): Promise<void> {
  const keys = new IssueKeys(ctx, parent.orgId);
  if (isGatedStatus(parent.status)) {
    refuse(
      `${await keys.name(parent)} is ${GATED_LABELS[parent.status]}; reopen it before adding ${article(childKind)} ${childKind}`
    );
  }
  const children = await orgChildren(ctx, parent.orgId, parent._id);
  if (children.length >= MAX_CHILDREN) {
    refuse(`${await keys.name(parent)} already has ${MAX_CHILDREN} children, the most one issue can have`);
  }
}

/** The counter every story is inserted with, so its first subtask (Complete testing) is KEY-n.1. */
export const FIRST_SUB_NUMBER = 1;

/**
 * Claim the next subtask number under a story. The story keeps a counter, so a key a moved or
 * deleted subtask held is never handed out again. The story is read here, inside the workspace,
 * so two claims in one mutation never get the same number. The counter is a bookkeeping field,
 * so claiming a number does not move the story's version.
 *
 * A story restored, imported or inserted by hand can lack the counter. Its first claim starts the
 * counter after the story's highest subtask in the workspace and stores it, so later claims count
 * on from there. A key a subtask vacated before the counter existed is unknown, so a claim can
 * hand it out again.
 */
export async function nextSubNumber(
  ctx: { db: MutationCtx["db"] },
  orgId: Id<"organizations">,
  storyId: Id<"issues">
): Promise<number> {
  const story = await requireOrgRow(ctx, orgId, storyId, "Parent issue");
  let subNumber = story.nextSubNumber;
  if (subNumber === undefined) {
    const subtasks = await orgChildren(ctx, orgId, storyId);
    subNumber = Math.max(FIRST_SUB_NUMBER, ...subtasks.map((subtask) => (subtask.subNumber ?? 0) + 1));
  }
  await patchIssue(ctx, story, { nextSubNumber: subNumber + 1 });
  return subNumber;
}

/**
 * Every descendant of an issue, found by walking each parent's children; leaf kinds are not queried. The walk
 * enforces both cascade caps: it is refused once it needs more than `CASCADE_BUDGET.queries` child queries, or as
 * soon as it has found more than `CASCADE_BUDGET.rows` descendants, so it never reads the rest of a large tree.
 */
async function descendants(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  rootId: Id<"issues">
): Promise<Doc<"issues">[]> {
  const found: Doc<"issues">[] = [];
  const pending = [rootId];
  let queries = 0;
  while (pending.length > 0) {
    const parentId = pending.pop()!;
    queries += 1;
    if (queries > CASCADE_BUDGET.queries) {
      refuse("This tree is too large to move in one step. Move a smaller part of it.");
    }
    const children = await orgChildren(ctx, orgId, parentId);
    found.push(...children);
    if (found.length > CASCADE_BUDGET.rows) {
      refuse(
        `This change would move more than ${groupDigits(CASCADE_BUDGET.rows)} issues to another project. Move a smaller part of the tree.`
      );
    }
    const parents = children.filter((child) => childKindOf(child.kind) !== null);
    pending.push(...parents.map((child) => child._id));
  }
  return found;
}

/**
 * Children follow their parent's project, so a change to the issue's project reaches every descendant; an unchanged
 * project touches nothing. The walk (`descendants`) enforces both caps before the first write.
 */
export async function cascadeProject(
  ctx: { db: MutationCtx["db"] },
  issue: Doc<"issues">,
  projectId: Id<"projects"> | undefined,
  actor: ActivityActor
): Promise<void> {
  if (projectId === issue.projectId) {
    return;
  }
  const moving = (await descendants(ctx, actor.orgId, issue._id)).filter(
    (descendant) => descendant.projectId !== projectId
  );
  for (const descendant of moving) {
    await patchIssue(ctx, descendant, { projectId });
    await logFieldChanges(ctx, actor, descendant._id, changedFields(descendant, { projectId }));
  }
}

/** Epics need a project, so a project that still has epics cannot be deleted. */
export function assertNoEpics(issues: Doc<"issues">[]): void {
  const epicCount = issues.filter((issue) => issue.kind === "epic").length;
  if (epicCount > 0) {
    const noun = epicCount === 1 ? "epic" : "epics";
    refuse(
      `This project still has ${epicCount} ${noun}; move or delete them first`
    );
  }
}
