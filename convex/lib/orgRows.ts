import { FilterBuilder, GenericTableInfo, OrderedQuery } from "convex/server";
import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

type Db = { db: QueryCtx["db"] };

/** Tables whose rows carry the workspace they belong to. */
type OrgTable = "issues" | "teams" | "projects" | "cycles";

/** A row by id, or null when it is missing or belongs to another workspace. */
export async function orgRow<T extends OrgTable>(
  ctx: Db,
  orgId: Id<"organizations">,
  id: Id<T>
): Promise<Doc<T> | null> {
  const row = await ctx.db.get(id);
  return row !== null && row.orgId === orgId ? row : null;
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

/** An issue's children inside the workspace; a row from another workspace pointing at it is not one. */
export async function orgChildren(
  ctx: Db,
  orgId: Id<"organizations">,
  parentId: Id<"issues">
): Promise<Doc<"issues">[]> {
  return await inOrg(
    ctx.db.query("issues").withIndex("by_parent", (q) => q.eq("parentIssueId", parentId)),
    orgId
  ).collect();
}
