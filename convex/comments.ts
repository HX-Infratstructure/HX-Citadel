import { ObjectType, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { getOrgIssue } from "./lib/issues/shape";
import { LIST_LIMIT } from "./lib/paging";
import { logActivity } from "./lib/activity";
import { orgMutation, orgQuery } from "./lib/customFunctions";
import { findMembership } from "./lib/mirror";
import { inOrg, requireOrgRow } from "./lib/orgRows";
import { OrgScope } from "./lib/orgScope";
import { invalid, refuse } from "./lib/refusals";

/** The most people one comment can mention; each mention is one membership read. */
export const MAX_MENTIONS = 50;

/** Comment enriched with author + mention display info for the feed. */
const enrichedCommentValidator = v.object({
  _id: v.id("comments"),
  _creationTime: v.number(),
  issueId: v.id("issues"),
  authorId: v.id("users"),
  body: v.string(),
  mentions: v.array(v.id("users")),
  authorName: v.string(),
  authorImageUrl: v.optional(v.string()),
  /** Resolved names for everyone @mentioned, for highlight rendering. */
  mentionedUsers: v.array(
    v.object({ userId: v.id("users"), name: v.string() })
  ),
});

/** Keep only mentioned users that are actually members of the org. */
async function filterToOrgMembers(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userIds: Id<"users">[]
): Promise<Id<"users">[]> {
  const unique = [...new Set(userIds)];
  if (unique.length > MAX_MENTIONS) {
    invalid(`A comment can mention at most ${MAX_MENTIONS} people`);
  }
  const valid: Id<"users">[] = [];
  for (const userId of unique) {
    if (await findMembership(ctx, orgId, userId)) {
      valid.push(userId);
    }
  }
  return valid;
}

function commentBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    invalid("Comment cannot be empty");
  }
  return trimmed;
}

/** The issue's newest `LIST_LIMIT` comments, oldest first. */
export const listByIssue = orgQuery({
  args: { issueId: v.id("issues") },
  returns: v.array(enrichedCommentValidator),
  handler: async (ctx, args) => {
    await getOrgIssue(ctx, ctx.org._id, args.issueId);

    const newestFirst = await inOrg(
      ctx.db.query("comments").withIndex("by_issue", (q) => q.eq("issueId", args.issueId)).order("desc"),
      ctx.org._id
    ).take(LIST_LIMIT);
    const comments = [...newestFirst].reverse();

    const userCache = new Map<Id<"users">, Doc<"users"> | null>();
    const getUser = async (userId: Id<"users">) => {
      if (!userCache.has(userId)) {
        userCache.set(userId, await ctx.db.get(userId));
      }
      return userCache.get(userId) ?? null;
    };

    const result = [];
    for (const comment of comments) {
      const author = await getUser(comment.authorId);
      const mentions = comment.mentions ?? [];
      const mentionedUsers = [];
      for (const userId of mentions) {
        const user = await getUser(userId);
        if (user) {
          mentionedUsers.push({ userId: user._id, name: user.name });
        }
      }
      result.push({
        _id: comment._id,
        _creationTime: comment._creationTime,
        issueId: comment.issueId,
        authorId: comment.authorId,
        body: comment.body,
        mentions,
        authorName: author?.name ?? "Unknown user",
        authorImageUrl: author?.imageUrl,
        mentionedUsers,
      });
    }
    return result;
  },
});

const createArgs = {
  issueId: v.id("issues"),
  body: v.string(),
  mentions: v.optional(v.array(v.id("users"))),
};

/** Every comment rule in one place; the Clerk session and agent calls both come through here. */
export async function createComment(
  ctx: MutationCtx,
  scope: OrgScope,
  args: ObjectType<typeof createArgs>
): Promise<Id<"comments">> {
  const { org, actorId } = scope;
  const issue = await getOrgIssue(ctx, org._id, args.issueId);
  const body = commentBody(args.body);
  const mentions = await filterToOrgMembers(ctx, org._id, args.mentions ?? []);

  const commentId = await ctx.db.insert("comments", {
    orgId: org._id,
    issueId: issue._id,
    authorId: actorId,
    body,
    mentions,
  });

  await logActivity(ctx, { orgId: org._id, issueId: issue._id, actorId, type: "commented" });

  return commentId;
}

export const create = orgMutation({
  args: createArgs,
  returns: v.id("comments"),
  handler: async (ctx, args) =>
    await createComment(ctx, { org: ctx.org, actorId: ctx.user._id }, args),
});

export const update = orgMutation({
  args: {
    commentId: v.id("comments"),
    body: v.string(),
    mentions: v.optional(v.array(v.id("users"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const comment = await requireOrgRow(ctx, ctx.org._id, args.commentId, "Comment");
    if (comment.authorId !== ctx.user._id) {
      refuse("Only the author can edit a comment");
    }

    const body = commentBody(args.body);
    const mentions =
      args.mentions !== undefined
        ? await filterToOrgMembers(ctx, ctx.org._id, args.mentions)
        : undefined;

    await ctx.db.patch(comment._id, {
      body,
      ...(mentions !== undefined ? { mentions } : {}),
    });
    return null;
  },
});

export const remove = orgMutation({
  args: { commentId: v.id("comments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const comment = await requireOrgRow(ctx, ctx.org._id, args.commentId, "Comment");
    const isAuthor = comment.authorId === ctx.user._id;
    const isAdmin = ctx.membership.role === "admin";
    if (!isAuthor && !isAdmin) {
      refuse("Only the author or an admin can delete a comment");
    }
    await ctx.db.delete(comment._id);
    return null;
  },
});
