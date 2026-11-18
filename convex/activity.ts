import { v } from "convex/values";
import { cycleName as formatCycleName } from "../lib/sprint";
import { Doc, Id } from "./_generated/dataModel";
import { getOrgIssue } from "./issues";
import { orgQuery } from "./lib/customFunctions";
import { orgRow } from "./lib/orgRows";

/**
 * Activity feed queries. Entries are written by `logActivity` in
 * `convex/lib/activity.ts` from every issue-changing mutation; this module
 * only renders them.
 */
const activityEntryValidator = v.object({
  _id: v.id("activity"),
  _creationTime: v.number(),
  issueId: v.id("issues"),
  actorId: v.id("users"),
  type: v.string(),
  field: v.optional(v.string()),
  oldValue: v.optional(v.string()),
  newValue: v.optional(v.string()),
  actorName: v.string(),
  actorImageUrl: v.optional(v.string()),
});

export const listByIssue = orgQuery({
  args: { issueId: v.id("issues") },
  returns: v.array(activityEntryValidator),
  handler: async (ctx, args) => {
    await getOrgIssue(ctx, ctx.org._id, args.issueId);

    const entries = await ctx.db
      .query("activity")
      .withIndex("by_issue", (q) => q.eq("issueId", args.issueId))
      .take(500);

    const userCache = new Map<Id<"users">, Doc<"users"> | null>();
    const getUser = async (userId: Id<"users">) => {
      if (!userCache.has(userId)) {
        userCache.set(userId, await ctx.db.get(userId));
      }
      return userCache.get(userId) ?? null;
    };

    const projectName = async (value: string): Promise<string | undefined> => {
      const projectId = ctx.db.normalizeId("projects", value);
      const project = projectId ? await orgRow(ctx, ctx.org._id, projectId) : null;
      return project?.name;
    };
    const cycleName = async (value: string): Promise<string | undefined> => {
      const cycleId = ctx.db.normalizeId("cycles", value);
      const cycle = cycleId ? await orgRow(ctx, ctx.org._id, cycleId) : null;
      return cycle ? formatCycleName(cycle) : undefined;
    };
    const userName = async (value: string): Promise<string | undefined> => {
      const userId = ctx.db.normalizeId("users", value);
      return userId ? (await getUser(userId))?.name : undefined;
    };
    const NAME_RESOLVERS: Record<string, (value: string) => Promise<string | undefined>> = {
      assignee: userName,
      project: projectName,
      cycle: cycleName,
    };

    /**
     * Assignee, project and cycle changes store raw ids — resolve them to
     * display names so the client never sees opaque ids.
     */
    const resolveValue = async (
      field: string | undefined,
      value: string | undefined
    ): Promise<string | undefined> => {
      const resolve = field === undefined ? undefined : NAME_RESOLVERS[field];
      if (value === undefined || resolve === undefined) {
        return value;
      }
      return (await resolve(value)) ?? value;
    };

    const result = [];
    for (const entry of entries) {
      const actor = await getUser(entry.actorId);
      result.push({
        _id: entry._id,
        _creationTime: entry._creationTime,
        issueId: entry.issueId,
        actorId: entry.actorId,
        type: entry.type,
        field: entry.field,
        oldValue: await resolveValue(entry.field, entry.oldValue),
        newValue: await resolveValue(entry.field, entry.newValue),
        actorName: actor?.name ?? "Unknown user",
        actorImageUrl: actor?.imageUrl,
      });
    }
    return result;
  },
});
