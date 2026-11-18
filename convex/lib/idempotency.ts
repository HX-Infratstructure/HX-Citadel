import { ConvexError, getDocumentSize, v } from "convex/values";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { OrgScope } from "./orgScope";
import { IDEMPOTENCY_KEY_REUSED } from "./refusals";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Receipts hold whole write results of any size, so one cleanup run stops after `rows` receipts or once the
 * receipts it read pass `bytes`, which keeps the run well under Convex's 16 MiB read limit.
 */
export const EXPIRY_BATCH = { rows: 256, bytes: 4 * 1024 * 1024 } as const;
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

/** What a REST write passes to its internal mutation; MCP passes the same. */
export const idempotencyValidator = v.object({ key: v.string(), requestHash: v.string() });
export type Idempotency = { key: string; requestHash: string };

export type ReusedData = { code: typeof IDEMPOTENCY_KEY_REUSED; message: string };

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

/**
 * One hash per request: method, path and the parsed body in stable key order. If-Match is left out: it is
 * the precondition of the first attempt, and a retry that re-reads the version must still replay.
 */
export async function hashRequest(route: string, body: Record<string, unknown>): Promise<string> {
  const text = canonicalJson({ route, body });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function reused(key: string): ConvexError<ReusedData> {
  return new ConvexError({ code: IDEMPOTENCY_KEY_REUSED, message: `${IDEMPOTENCY_HEADER} ${key} was already used for another request` });
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

/** Deletes one `EXPIRY_BATCH` of the oldest keys past the TTL and schedules the next batch when it stopped early; returns how many went. */
export async function expireKeys(ctx: MutationCtx, now: number): Promise<number> {
  const expired: Id<"idempotencyKeys">[] = [];
  let bytes = 0;
  let more = false;
  const oldestFirst = ctx.db
    .query("idempotencyKeys")
    .withIndex("by_created_at", (q) => q.lt("createdAt", now - IDEMPOTENCY_TTL_MS));
  for await (const row of oldestFirst) {
    expired.push(row._id);
    bytes += getDocumentSize(row);
    if (expired.length === EXPIRY_BATCH.rows || bytes >= EXPIRY_BATCH.bytes) {
      more = true;
      break;
    }
  }
  await Promise.all(expired.map((id) => ctx.db.delete(id)));
  if (more) {
    await ctx.scheduler.runAfter(0, internal.agentApi.expireIdempotencyKeys, {});
  }
  return expired.length;
}
