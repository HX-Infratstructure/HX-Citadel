import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { findMembership, findUserByClerkId } from "./mirror";
import { invalid } from "./refusals";

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
