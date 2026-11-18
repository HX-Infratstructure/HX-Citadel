import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

/** Who made a change, and in which org. */
export type ActivityActor = {
  orgId: Id<"organizations">;
  actorId: Id<"users">;
};

type ActivityEntry = ActivityActor & {
  issueId: Id<"issues">;
  type: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
};

export type FieldChange = {
  field: string;
  oldValue?: string;
  newValue?: string;
};

/** Issue fields whose changes reach the feed, keyed by document field, valued by feed field. */
const TRACKED_FIELDS = {
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  assigneeId: "assignee",
  projectId: "project",
  cycleId: "cycle",
  estimate: "estimate",
  dueDate: "dueDate",
  subNumber: "subNumber",
} as const satisfies Partial<Record<keyof Doc<"issues">, string>>;

type TrackedKey = keyof typeof TRACKED_FIELDS;

/** How a field change is recorded: `<field>_changed` by default, or one type for every change. */
export type FieldLogOptions = { type?: string };

function asText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

/** One change per tracked field the patch sets to a different value. */
export function changedFields(
  issue: Doc<"issues">,
  updates: Partial<Doc<"issues">>
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const key of Object.keys(TRACKED_FIELDS) as TrackedKey[]) {
    if (!(key in updates)) {
      continue;
    }
    const oldValue = asText(issue[key]);
    const newValue = asText(updates[key]);
    if (oldValue !== newValue) {
      changes.push({ field: TRACKED_FIELDS[key], oldValue, newValue });
    }
  }
  return changes;
}

/**
 * Append an event to an issue's activity feed. All mutations that change
 * issues should call this so the feed (Track C) stays complete.
 */
export async function logActivity(
  ctx: { db: MutationCtx["db"] },
  entry: ActivityEntry
): Promise<void> {
  await ctx.db.insert("activity", entry);
}

/** The issue's current value of a feed field, as text, the way `changedFields` records it. */
export function fieldText(issue: Doc<"issues">, field: string): string | undefined {
  const key = (Object.keys(TRACKED_FIELDS) as TrackedKey[]).find((k) => TRACKED_FIELDS[k] === field);
  return key ? asText(issue[key]) : undefined;
}

/** One row per field change, typed `<field>_changed` unless the options name the type. */
export async function logFieldChanges(
  ctx: { db: MutationCtx["db"] },
  actor: ActivityActor,
  issueId: Id<"issues">,
  changes: FieldChange[],
  options: FieldLogOptions = {}
): Promise<void> {
  for (const change of changes) {
    const type = options.type ?? `${change.field}_changed`;
    await logActivity(ctx, { ...actor, issueId, type, ...change });
  }
}
