import { v } from "convex/values";
import { orgMutation, orgQuery } from "./lib/customFunctions";
import { requireOrgRow } from "./lib/orgRows";
import { invalid, refuse } from "./lib/refusals";

const viewShape = {
  _id: v.id("views"),
  _creationTime: v.number(),
  orgId: v.id("organizations"),
  creatorId: v.id("users"),
  name: v.string(),
  /** JSON-serialized filter configuration (see components/views/filters.ts) */
  filters: v.string(),
  shared: v.boolean(),
};

const MAX_FILTERS_LENGTH = 4096;

/** Reject payloads that aren't valid JSON before they hit the table. */
function assertValidFilters(filters: string): void {
  if (filters.length > MAX_FILTERS_LENGTH) {
    invalid("View filters are too large");
  }
  try {
    JSON.parse(filters);
  } catch {
    invalid("View filters must be valid JSON");
  }
}

function viewName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    invalid("View name is required");
  }
  return trimmed;
}

/**
 * Saved views visible to the caller: every shared view in the org plus the
 * caller's own private views.
 */
export const list = orgQuery({
  args: {},
  returns: v.array(v.object(viewShape)),
  handler: async (ctx) => {
    // Bounded by design: people save views by hand, a few dozen per workspace; no agent route creates one.
    const views = await ctx.db
      .query("views")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.org._id))
      .collect();
    return views
      .filter((view) => view.shared || view.creatorId === ctx.user._id)
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const create = orgMutation({
  args: {
    name: v.string(),
    filters: v.string(),
    shared: v.boolean(),
  },
  returns: v.id("views"),
  handler: async (ctx, args) => {
    const name = viewName(args.name);
    assertValidFilters(args.filters);
    return await ctx.db.insert("views", {
      orgId: ctx.org._id,
      creatorId: ctx.user._id,
      name,
      filters: args.filters,
      shared: args.shared,
    });
  },
});

export const update = orgMutation({
  args: {
    viewId: v.id("views"),
    name: v.optional(v.string()),
    filters: v.optional(v.string()),
    shared: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const view = await requireOrgRow(ctx, ctx.org._id, args.viewId, "View");
    if (view.creatorId !== ctx.user._id && ctx.membership.role !== "admin") {
      refuse("Only the view's creator or an admin can edit it");
    }

    const updates: { name?: string; filters?: string; shared?: boolean } = {};
    if (args.name !== undefined) {
      updates.name = viewName(args.name);
    }
    if (args.filters !== undefined) {
      assertValidFilters(args.filters);
      updates.filters = args.filters;
    }
    if (args.shared !== undefined) {
      updates.shared = args.shared;
    }
    await ctx.db.patch(view._id, updates);
    return null;
  },
});

export const remove = orgMutation({
  args: { viewId: v.id("views") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const view = await requireOrgRow(ctx, ctx.org._id, args.viewId, "View");
    if (view.creatorId !== ctx.user._id && ctx.membership.role !== "admin") {
      refuse("Only the view's creator or an admin can delete it");
    }
    await ctx.db.delete(view._id);
    return null;
  },
});
