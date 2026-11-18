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

/** An issue's children inside the workspace; a row from another workspace pointing at it is not one. */
export async function orgChildren(
  ctx: Db,
  orgId: Id<"organizations">,
  parentId: Id<"issues">
): Promise<Doc<"issues">[]> {
  const children = await ctx.db
    .query("issues")
    .withIndex("by_parent", (q) => q.eq("parentIssueId", parentId))
    .collect();
  return children.filter((child) => child.orgId === orgId);
}
