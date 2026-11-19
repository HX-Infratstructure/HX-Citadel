import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { IssueKeys } from "./issueKeys";
import { findMembership, findUserByClerkId } from "./mirror";
import { invalid, refuse } from "./refusals";

const AGENT_NAME = /^[a-z0-9._-]{1,64}$/;

/** `assignee=me` selects the calling agent, so no agent may take `me` as its name. */
const SELF_SELECTOR = "me";

/** Trimmed and lower-cased; `[a-z0-9._-]`, 1 to 64 characters, never `me`. `system` is allowed for machine jobs. */
export function normalizeAgentName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!AGENT_NAME.test(name) || name === SELF_SELECTOR) {
    invalid("invalid agent name");
  }
  return name;
}

/** Agents are resolved by this synthetic id, never by display name, so a human can't be taken over. */
export function agentClerkId(name: string): string {
  return `agent:${normalizeAgentName(name)}`;
}

async function findOrCreateAgentUser(ctx: MutationCtx, name: string): Promise<Id<"users">> {
  const clerkId = agentClerkId(name);
  const existing = await findUserByClerkId(ctx, clerkId);
  if (existing) {
    return existing._id;
  }
  return await ctx.db.insert("users", { clerkId, name, email: "", kind: "agent" });
}

async function ensureAgentMembership(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  name: string
): Promise<void> {
  if (await findMembership(ctx, orgId, userId)) {
    return;
  }
  await ctx.db.insert("members", {
    orgId,
    userId,
    role: "member",
    clerkMembershipId: `${agentClerkId(name)}@${orgId}`,
  });
}

/** Finds or creates the agent's user row and its workspace membership; safe to call on every request. */
export async function ensureAgent(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  rawName: string
): Promise<Id<"users">> {
  const name = normalizeAgentName(rawName);
  const userId = await findOrCreateAgentUser(ctx, name);
  await ensureAgentMembership(ctx, orgId, userId, name);
  return userId;
}

/** How many assigned issues, and how many led projects, a refusal names. */
const NAMED_LIMIT = 10;

function namedList(names: string[]): string {
  const shown = names.slice(0, NAMED_LIMIT).join(", ");
  return names.length > NAMED_LIMIT ? `${shown} and more` : shown;
}

/** Any status counts, Done and Canceled included, so no issue or project ever points at a removed member. */
async function refuseWhileHeld(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  name: string
): Promise<void> {
  const issues = await ctx.db
    .query("issues")
    .withIndex("by_assignee_kind_status", (q) => q.eq("orgId", orgId).eq("assigneeId", userId))
    .take(NAMED_LIMIT + 1);
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    // No index covers a project's lead and the schema is frozen; a workspace holds few projects.
    // eslint-disable-next-line @convex-dev/no-filter-in-query
    .filter((q) => q.eq(q.field("leadId"), userId))
    .take(NAMED_LIMIT + 1);
  const held: string[] = [];
  if (issues.length > 0) {
    const keys = new IssueKeys(ctx, orgId);
    const issueNames = await Promise.all(issues.map((issue) => keys.name(issue)));
    held.push(`has ${namedList(issueNames)} assigned`);
  }
  if (projects.length > 0) {
    held.push(`leads ${namedList(projects.map((project) => project.name))}`);
  }
  if (held.length > 0) {
    refuse(`${name} still ${held.join(" and ")}; reassign them first`);
  }
}

/**
 * Removes the agent's membership and keeps its user row, so its comments and activity still name it.
 * False when the name is no agent member, so a rerun is a no-op. Its next successful write adds the membership back.
 */
export async function removeAgentMembership(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  rawName: string
): Promise<boolean> {
  const name = normalizeAgentName(rawName);
  const user = await findUserByClerkId(ctx, agentClerkId(name));
  if (user === null) {
    return false;
  }
  const membership = await findMembership(ctx, orgId, user._id);
  if (membership === null) {
    return false;
  }
  await refuseWhileHeld(ctx, orgId, user._id, name);
  await ctx.db.delete(membership._id);
  return true;
}
