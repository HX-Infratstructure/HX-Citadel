import { Doc, Id } from "../../_generated/dataModel";
import { refuse } from "../refusals";
import { QueryCtx } from "../../_generated/server";
import {
  IssueKind,
  PARENT_KIND,
  PARENT_REQUIRED,
  PROJECT_REQUIRED,
} from "../../../lib/issue-key";
import { GATED_LABELS, isGatedStatus } from "../../../lib/issue-status";
import { IssueKeys } from "../issueKeys";
import { MAX_CHILDREN, orgChildren, requireOrgRow } from "../orgRows";

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

/** A `ResolvedPlacement` with the parent it was resolved from, or null when the issue has none. */
export type PlacementWithParent = ResolvedPlacement & { parent: Doc<"issues"> | null };

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
 * subtask → story) and return the team and project the issue must carry, with the parent it read.
 */
export async function resolvePlacement(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  kind: IssueKind,
  placement: Placement
): Promise<PlacementWithParent> {
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
    return { teamId: placement.teamId, projectId: placement.projectId, parent: null };
  }
  const parent = await requireOrgRow(ctx, orgId, placement.parentIssueId, "Parent issue");
  assertParentKind(kind, parent.kind);
  return {
    teamId: inheritedTeam(kind, parent, placement.teamId),
    projectId: inheritedProject(kind, parent, placement.projectId),
    parent,
  };
}

/** `resolvePlacement` without the parent, for callers that need only the team and project. */
export async function assertValidParent(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  kind: IssueKind,
  placement: Placement
): Promise<ResolvedPlacement> {
  const { teamId, projectId } = await resolvePlacement(ctx, orgId, kind, placement);
  return { teamId, projectId };
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
