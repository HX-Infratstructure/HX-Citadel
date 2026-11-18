/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { Infer } from "convex/values";
import { afterEach, beforeEach } from "vitest";
import schema, { memberRoleValidator } from "./schema";

const modules = import.meta.glob("./**/*.*s");

/** The Clerk org id of the HX workspace and the value of HX_WORKSPACE_ORG_ID. */
export const ORG = "org_hx";

/** The header that names the agent cc1. The agent's user row does not exist until its first call. */
export const AGENT = { "X-Agent-Id": "cc1" } as const;

let keyCount = 0;
/** A new Idempotency-Key header. The counter only increases, so a key never repeats in one test file. */
export const freshKey = () => ({ "Idempotency-Key": `test-${++keyCount}` });

/** Sets HX_WORKSPACE_ORG_ID to ORG before each test and deletes it after. Call it once, at the top of the file. */
export function registerWorkspaceEnv(): void {
  beforeEach(() => {
    process.env.HX_WORKSPACE_ORG_ID = ORG;
  });
  afterEach(() => {
    delete process.env.HX_WORKSPACE_ORG_ID;
  });
}

export type Member = { clerkId: string; role: Infer<typeof memberRoleValidator> };

/** A convexTest instance with the HX organization, the ENG team and one user and membership per entry in members. */
export async function workspaceTest(options: { members?: readonly Member[]; transactionLimits?: boolean } = {}) {
  const t = convexTest({ schema, modules, transactionLimits: options.transactionLimits });
  await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG, name: "HX", slug: "hx" });
    await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
    for (const { clerkId, role } of options.members ?? []) {
      const userId = await ctx.db.insert("users", { clerkId, name: clerkId, email: `${clerkId}@example.com` });
      await ctx.db.insert("members", { orgId, userId, role, clerkMembershipId: `mem_${clerkId}` });
    }
  });
  return t;
}

export type WorkspaceTest = Awaited<ReturnType<typeof workspaceTest>>;
