import { Doc, Id } from "../../_generated/dataModel";
import { refuse } from "../refusals";
import { MutationCtx, QueryCtx } from "../../_generated/server";
import { childKindOf } from "../../../lib/issue-key";
import { ActivityActor, changedFields, logFieldChanges } from "../activity";
import { patchIssue } from "../issueVersion";
import { CASCADE_BUDGET, groupDigits, orgChildren } from "../orgRows";

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
