import { ConvexError, v } from "convex/values";
import { MutationCtx } from "../_generated/server";
import { OrgScope } from "./orgScope";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

/** What a REST write passes to its internal mutation; MCP passes the same. */
export const idempotencyValidator = v.object({ key: v.string(), requestHash: v.string() });
export type Idempotency = { key: string; requestHash: string };

export type ReusedData = { code: "idempotency_key_reused"; message: string };

/** Whether a header value can be a key: 1 to 200 visible ASCII characters. */
export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonicalJson((value as Record<string, unknown>)[name])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** One hash per request: method, path, the parsed body in stable key order, and If-Match. */
export async function hashRequest(route: string, body: Record<string, unknown>, ifMatch: number | undefined): Promise<string> {
  const text = canonicalJson({ route, body, ifMatch: ifMatch ?? null });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function reused(key: string): ConvexError<ReusedData> {
  return new ConvexError({ code: "idempotency_key_reused", message: `${IDEMPOTENCY_HEADER} ${key} was already used for another request` });
}

/**
 * Runs `write` once per org and key, inside the caller's mutation, so the lookup, the write and the
 * stored result commit together. A replay by the same agent with the same request returns the stored
 * result; anything else under that key is refused. A write that throws rolls the key back with it.
 */
export async function withIdempotency<T>(
  ctx: MutationCtx,
  scope: OrgScope,
  idempotency: Idempotency | undefined,
  write: () => Promise<T>
): Promise<T> {
  if (idempotency === undefined) {
    return await write();
  }
  const { key, requestHash } = idempotency;
  const stored = await ctx.db
    .query("idempotencyKeys")
    .withIndex("by_org_and_key", (q) => q.eq("orgId", scope.org._id).eq("key", key))
    .unique();
  if (stored !== null) {
    if (stored.agentId !== scope.actorId || stored.requestHash !== requestHash) {
      throw reused(key);
    }
    return stored.body as T;
  }
  const body = await write();
  await ctx.db.insert("idempotencyKeys", {
    orgId: scope.org._id,
    agentId: scope.actorId,
    key,
    requestHash,
    body,
    createdAt: Date.now(),
  });
  return body;
}

/** Deletes keys older than the TTL; returns how many went. */
export async function expireKeys(ctx: MutationCtx, now: number): Promise<number> {
  const expired = await ctx.db
    .query("idempotencyKeys")
    .withIndex("by_created_at", (q) => q.lt("createdAt", now - IDEMPOTENCY_TTL_MS))
    .collect();
  await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
  return expired.length;
}
