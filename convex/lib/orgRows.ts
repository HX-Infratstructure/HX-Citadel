import { FilterBuilder, GenericTableInfo, OrderedQuery } from "convex/server";
import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { notFound, refuse } from "./refusals";

type Db = { db: QueryCtx["db"] };

/** Tables whose rows carry the workspace they belong to. */
type OrgTable =
  | "issues"
  | "teams"
  | "projects"
  | "cycles"
  | "labels"
  | "comments"
  | "decisions"
  | "attachments"
  | "views"
  | "activity";

/** A row by id, or null when it is missing or belongs to another workspace. */
export async function orgRow<T extends OrgTable>(
  ctx: Db,
  orgId: Id<"organizations">,
  id: Id<T>
): Promise<Doc<T> | null> {
  const row = await ctx.db.get(id);
  return row !== null && row.orgId === orgId ? row : null;
}

/** A row by id; a missing row and another workspace's row are both a typed `"<label> not found"`. */
export async function requireOrgRow<T extends OrgTable>(
  ctx: Db,
  orgId: Id<"organizations">,
  id: Id<T>,
  label: string
): Promise<Doc<T>> {
  const row = await orgRow(ctx, orgId, id);
  if (row === null) {
    notFound(`${label} not found`);
  }
  return row;
}

/** Verify an issue belongs to the caller's org before any read/write. */
export async function getOrgIssue(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  issueId: Id<"issues">
): Promise<Doc<"issues">> {
  return await requireOrgRow(ctx, orgId, issueId, "Issue");
}

/**
 * The query's rows that belong to the workspace. It filters inside the query, so a row from another workspace
 * that points at one of ours never uses up a `take` or `paginate` limit, never comes back from `first`, and never
 * makes `unique` throw.
 */
export function inOrg<TableInfo extends GenericTableInfo & { document: { orgId: Id<"organizations"> } }>(
  query: OrderedQuery<TableInfo>,
  orgId: Id<"organizations">
): OrderedQuery<TableInfo> {
  return query.filter((q: FilterBuilder<GenericTableInfo>) => q.eq(q.field("orgId"), orgId));
}

/**
 * The most children one issue may have. Above the largest fan-out in use (a feature with 200 stories), and small
 * enough that every reader of one issue's children (the Done gate, the hierarchy panel, a project cascade's level)
 * stays a small read.
 */
export const MAX_CHILDREN = 250;

/**
 * The most rows a project cascade, or a project or cycle remove, may change, and the most child queries a cascade's
 * walk may make. Each changed row is two writes (the issue and its activity row), so both stay inside Convex's
 * per-transaction limits (16,000 writes, 4,096 index ranges); past them the mutation is refused before any write
 * persists.
 */
export const CASCADE_BUDGET = { rows: 7_900, queries: 4_000 } as const;

/** A whole number with a comma between each group of three digits, as the refusal messages show a cap. */
export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** An issue's children inside the workspace; more than `MAX_CHILDREN` is refused, never cut short. */
export async function orgChildren(
  ctx: Db,
  orgId: Id<"organizations">,
  parentId: Id<"issues">
): Promise<Doc<"issues">[]> {
  const children = await ctx.db
    .query("issues")
    .withIndex("by_org_and_parent", (q) => q.eq("orgId", orgId).eq("parentIssueId", parentId))
    .take(MAX_CHILDREN + 1);
  if (children.length > MAX_CHILDREN) {
    refuse(`Issue ${parentId} has more than ${MAX_CHILDREN} children, the most one issue can have`);
  }
  return children;
}
