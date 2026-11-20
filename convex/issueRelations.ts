import { v } from "convex/values";
import { notFound, refuse } from "./lib/refusals";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { changedFields, logActivity, logFieldChanges } from "./lib/activity";
import { orgMutation, orgQuery } from "./lib/customFunctions";
import { IssueKeys } from "./lib/issueKeys";
import { RELATION_LIMIT, relationsOf } from "./lib/issueRelations";
import { patchIssue } from "./lib/issueVersion";
import { getOrgIssue, orgChildren, orgRow } from "./lib/orgRows";
import { cascadeProject } from "./lib/rules/cascade";
import { assertParentOpen, assertValidParent } from "./lib/rules/levels";
import { nextSubNumber } from "./lib/rules/subNumbers";
import { assertNotTestingSubtask } from "./lib/rules/testing";
import {
  issueKindValidator,
  issuePriorityValidator,
  issueRelationTypeValidator,
  issueStatusValidator,
  issueTypeValidator,
} from "./schema";

/**
 * Issue relations + sub-issue hierarchy.
 *
 * Relations are stored once per pair (blocked_by is normalized to the
 * inverse `blocks` row) and inverted at query time, so each side of a
 * relation sees the right direction.
 */

/** Relation direction as seen from the queried issue (includes inverses). */
const displayRelationTypeValidator = v.union(
  v.literal("blocks"),
  v.literal("blocked_by"),
  v.literal("related"),
  v.literal("duplicate_of"),
  v.literal("duplicated_by")
);

const issueSummaryValidator = v.object({
  _id: v.id("issues"),
  /** Display identifier, e.g. "ENG-42". */
  identifier: v.string(),
  kind: issueKindValidator,
  type: v.optional(issueTypeValidator),
  title: v.string(),
  status: issueStatusValidator,
  priority: issuePriorityValidator,
  assigneeId: v.optional(v.id("users")),
});

type IssueSummary = {
  _id: Id<"issues">;
  identifier: string;
  kind: Doc<"issues">["kind"];
  type?: Doc<"issues">["type"];
  title: string;
  status: Doc<"issues">["status"];
  priority: Doc<"issues">["priority"];
  assigneeId?: Id<"users">;
};

/** Order siblings by their own sequence: story number or subtask number. */
function siblingOrder(issue: Doc<"issues">): number {
  return issue.number ?? issue.subNumber ?? 0;
}

async function summarizeIssue(keys: IssueKeys, issue: Doc<"issues">): Promise<IssueSummary> {
  return {
    _id: issue._id,
    identifier: await keys.name(issue),
    kind: issue.kind,
    type: issue.type,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    assigneeId: issue.assigneeId,
  };
}

type StoredRelationType = Doc<"issueRelations">["type"];
type DisplayRelationType = StoredRelationType | "duplicated_by";

/** Direction of a stored relation as seen from the *related* issue's side. */
const INVERSE: Record<StoredRelationType, DisplayRelationType> = {
  blocks: "blocked_by",
  blocked_by: "blocks",
  related: "related",
  duplicate_of: "duplicated_by",
};

/** A relation as one of its ends sees it: the issue at the other end, and the direction. */
function seenFrom(
  relation: Doc<"issueRelations">,
  issueId: Id<"issues">
): { otherId: Id<"issues">; type: DisplayRelationType } {
  if (relation.issueId === issueId) {
    return { otherId: relation.relatedIssueId, type: relation.type };
  }
  return { otherId: relation.issueId, type: INVERSE[relation.type] };
}

/** Refuses a new relation on an issue that already holds `RELATION_LIMIT`. */
async function assertRoomForRelation(keys: IssueKeys, issue: Doc<"issues">, relations: Doc<"issueRelations">[]) {
  if (relations.length >= RELATION_LIMIT) {
    refuse(`${await keys.name(issue)} already has ${RELATION_LIMIT} relations`);
  }
}

export const listForIssue = orgQuery({
  args: { issueId: v.id("issues") },
  returns: v.array(
    v.object({
      relationId: v.id("issueRelations"),
      type: displayRelationTypeValidator,
      issue: issueSummaryValidator,
    })
  ),
  handler: async (ctx, args) => {
    await getOrgIssue(ctx, ctx.org._id, args.issueId);
    const keys = new IssueKeys(ctx, ctx.org._id);

    const result = [];
    for (const relation of await relationsOf(ctx, args.issueId)) {
      const { otherId, type } = seenFrom(relation, args.issueId);
      const other = await orgRow(ctx, ctx.org._id, otherId);
      if (other === null) {
        continue;
      }
      result.push({ relationId: relation._id, type, issue: await summarizeIssue(keys, other) });
    }
    return result;
  },
});

export const create = orgMutation({
  args: {
    issueId: v.id("issues"),
    relatedIssueId: v.id("issues"),
    type: issueRelationTypeValidator,
  },
  returns: v.id("issueRelations"),
  handler: async (ctx, args) => {
    if (args.issueId === args.relatedIssueId) {
      refuse("An issue cannot be related to itself");
    }
    const issue = await getOrgIssue(ctx, ctx.org._id, args.issueId);
    const related = await getOrgIssue(ctx, ctx.org._id, args.relatedIssueId);

    // Normalize "A blocked_by B" to "B blocks A" so each pair is stored once.
    let fromIssue = issue;
    let toIssue = related;
    let type: StoredRelationType = args.type;
    if (type === "blocked_by") {
      fromIssue = related;
      toIssue = issue;
      type = "blocks";
    }

    // One relation per pair, in either direction.
    const existing = await relationsOf(ctx, issue._id);
    if (existing.some((relation) => seenFrom(relation, issue._id).otherId === related._id)) {
      refuse("These issues are already linked");
    }
    const keys = new IssueKeys(ctx, ctx.org._id);
    await assertRoomForRelation(keys, issue, existing);
    await assertRoomForRelation(keys, related, await relationsOf(ctx, related._id));

    const relationId = await ctx.db.insert("issueRelations", {
      issueId: fromIssue._id,
      relatedIssueId: toIssue._id,
      type,
    });

    const fromIdentifier = await keys.name(fromIssue);
    const toIdentifier = await keys.name(toIssue);
    await logActivity(ctx, {
      orgId: ctx.org._id,
      issueId: fromIssue._id,
      actorId: ctx.user._id,
      type: "relation_added",
      field: type,
      newValue: toIdentifier,
    });
    await logActivity(ctx, {
      orgId: ctx.org._id,
      issueId: toIssue._id,
      actorId: ctx.user._id,
      type: "relation_added",
      field: INVERSE[type],
      newValue: fromIdentifier,
    });

    return relationId;
  },
});

export const remove = orgMutation({
  args: { relationId: v.id("issueRelations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const relation = await ctx.db.get(args.relationId);
    if (!relation) {
      notFound("Relation not found");
    }
    // Both ends must belong to the caller's org.
    const fromIssue = await getOrgIssue(ctx, ctx.org._id, relation.issueId);
    const toIssue = await getOrgIssue(
      ctx,
      ctx.org._id,
      relation.relatedIssueId
    );

    await ctx.db.delete(relation._id);

    const keys = new IssueKeys(ctx, ctx.org._id);
    const fromIdentifier = await keys.name(fromIssue);
    const toIdentifier = await keys.name(toIssue);
    await logActivity(ctx, {
      orgId: ctx.org._id,
      issueId: fromIssue._id,
      actorId: ctx.user._id,
      type: "relation_removed",
      field: relation.type,
      oldValue: toIdentifier,
    });
    await logActivity(ctx, {
      orgId: ctx.org._id,
      issueId: toIssue._id,
      actorId: ctx.user._id,
      type: "relation_removed",
      field: INVERSE[relation.type],
      oldValue: fromIdentifier,
    });
    return null;
  },
});

/** Parent + sub-issues for the hierarchy panel, in one subscription. */
export const hierarchy = orgQuery({
  args: { issueId: v.id("issues") },
  returns: v.object({
    parent: v.union(issueSummaryValidator, v.null()),
    subIssues: v.array(issueSummaryValidator),
  }),
  handler: async (ctx, args) => {
    const issue = await getOrgIssue(ctx, ctx.org._id, args.issueId);
    const keys = new IssueKeys(ctx, ctx.org._id);

    const parentIssue = issue.parentIssueId ? await orgRow(ctx, ctx.org._id, issue.parentIssueId) : null;
    const parent = parentIssue ? await summarizeIssue(keys, parentIssue) : null;

    const children = await orgChildren(ctx, ctx.org._id, issue._id);
    children.sort((a, b) => siblingOrder(a) - siblingOrder(b));

    const subIssues = [];
    for (const child of children) {
      subIssues.push(await summarizeIssue(keys, child));
    }
    return { parent, subIssues };
  },
});

/** A subtask moved to another story takes the next number there, so keys stay unique. */
async function renumberedSubtask(
  ctx: { db: MutationCtx["db"] },
  issue: Doc<"issues">,
  parentIssueId: Id<"issues"> | null
): Promise<Pick<Doc<"issues">, "subNumber">> {
  if (issue.kind !== "subtask" || parentIssueId === null) {
    return {};
  }
  return { subNumber: await nextSubNumber(ctx, issue.orgId, parentIssueId) };
}

export const setParent = orgMutation({
  args: {
    issueId: v.id("issues"),
    parentIssueId: v.union(v.id("issues"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const issue = await getOrgIssue(ctx, ctx.org._id, args.issueId);
    if ((issue.parentIssueId ?? null) === args.parentIssueId) {
      return null;
    }
    assertNotTestingSubtask(issue);
    const keys = new IssueKeys(ctx, ctx.org._id);

    let newParent: Doc<"issues"> | null = null;
    let newParentIdentifier: string | undefined;
    let projectId = issue.projectId;
    if (args.parentIssueId !== null) {
      if (args.parentIssueId === issue._id) {
        refuse("An issue cannot be its own parent");
      }
      const parent = await getOrgIssue(ctx, ctx.org._id, args.parentIssueId);
      newParent = parent;

      // Walk up from the new parent — hitting this issue means a cycle.
      let ancestorId: Id<"issues"> | undefined = parent.parentIssueId;
      for (let depth = 0; ancestorId && depth < 100; depth++) {
        if (ancestorId === issue._id) {
          refuse(
            "Cannot set a sub-issue of this issue as its parent"
          );
        }
        const ancestor: Doc<"issues"> | null = await orgRow(ctx, ctx.org._id, ancestorId);
        ancestorId = ancestor?.parentIssueId;
      }
      newParentIdentifier = await keys.name(parent);
      projectId = parent.projectId;
    }
    const placement = await assertValidParent(ctx, ctx.org._id, issue.kind, {
      teamId: issue.teamId,
      parentIssueId: args.parentIssueId ?? undefined,
      projectId,
    });
    if (newParent !== null) {
      await assertParentOpen(ctx, newParent, issue.kind);
    }

    const oldParent = issue.parentIssueId ? await orgRow(ctx, ctx.org._id, issue.parentIssueId) : null;
    const oldParentIdentifier = oldParent ? await keys.name(oldParent) : undefined;

    const moved = {
      parentIssueId: args.parentIssueId ?? undefined,
      projectId: placement.projectId,
      ...(await renumberedSubtask(ctx, issue, args.parentIssueId)),
    };
    const actor = { orgId: ctx.org._id, actorId: ctx.user._id };
    await patchIssue(ctx, issue._id, moved);
    await logFieldChanges(ctx, actor, issue._id, changedFields(issue, moved));
    await cascadeProject(ctx, issue, placement.projectId, actor);

    await logActivity(ctx, {
      orgId: ctx.org._id,
      issueId: issue._id,
      actorId: ctx.user._id,
      type: "parent_changed",
      field: "parent",
      oldValue: oldParentIdentifier,
      newValue: newParentIdentifier,
    });
    return null;
  },
});

/**
 * Lightweight org-scoped issue finder for the relation / parent pickers.
 * Empty query returns the most recent issues.
 */
export const searchIssues = orgQuery({
  args: {
    query: v.string(),
    excludeIssueId: v.optional(v.id("issues")),
  },
  returns: v.array(issueSummaryValidator),
  handler: async (ctx, args) => {
    const term = args.query.trim();
    const matches = term
      ? await ctx.db
          .query("issues")
          .withSearchIndex("search_title", (q) =>
            q.search("title", term).eq("orgId", ctx.org._id)
          )
          .take(15)
      : await ctx.db
          .query("issues")
          .withIndex("by_org", (q) => q.eq("orgId", ctx.org._id))
          .order("desc")
          .take(15);

    const keys = new IssueKeys(ctx, ctx.org._id);
    const result = [];
    for (const issue of matches) {
      if (issue._id === args.excludeIssueId) {
        continue;
      }
      result.push(await summarizeIssue(keys, issue));
    }
    return result;
  },
});
