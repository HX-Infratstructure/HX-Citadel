import { Doc, Id } from "../../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../../_generated/server";
import { fieldText } from "../activity";
import { IssueKeys } from "../issueKeys";
import { inOrg, requireOrgRow } from "../orgRows";
import { OrgScope } from "../orgScope";
import { LIST_LIMIT } from "../paging";
import { refuse } from "../refusals";
import { issuePriorityValidator, issueStatusValidator } from "../../schema";
import { getOrgIssue } from "./shape";
import { updateIssue, UpdateIssueArgs } from "./update";

function literalOf<T extends string>(validator: { members: { value: T }[] }, text: string | undefined): T {
  const member = validator.members.find((candidate) => candidate.value === text);
  if (!member) {
    refuse(`Unknown value ${text}`);
  }
  return member.value;
}

/** A recorded assignee: absent means unassigned. `updateIssue` checks that anyone else is still a member. */
function assigneeOf(ctx: MutationCtx, text: string | undefined) {
  if (text === undefined) {
    return null;
  }
  const userId = ctx.db.normalizeId("users", text);
  if (!userId) {
    refuse(`Unknown value ${text}`);
  }
  return userId;
}

type RevertArgs = Omit<UpdateIssueArgs, "issueId">;
type ToRevertArgs = (ctx: MutationCtx, issue: Doc<"issues">, text: string | undefined) => Promise<RevertArgs>;

/** The fields a revert may touch, each turning recorded text back into its update argument. */
const REVERT_ARGS: Record<string, ToRevertArgs> = {
  title: async (_ctx, _issue, text) => ({ title: text ?? "" }),
  status: async (_ctx, _issue, text) => ({ status: literalOf(issueStatusValidator, text) }),
  priority: async (_ctx, _issue, text) => ({ priority: literalOf(issuePriorityValidator, text) }),
  assignee: async (ctx, _issue, text) => ({ assigneeId: assigneeOf(ctx, text) }),
};

/** The issue's activity, newest first: by creation time, then `_id`, the `by_issue` index order. */
export function activityNewestFirst(ctx: { db: QueryCtx["db"] }, issue: Doc<"issues">) {
  return inOrg(
    ctx.db.query("activity").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).order("desc"),
    issue.orgId
  );
}

/**
 * Why an owner can't revert `row`, or null when they can. Only a `<field>_changed` row of a field in
 * `REVERT_ARGS` can be reverted, while it is the newest row for its field and the issue still holds its new value.
 * A `reverted` row never is: to redo, make the change again.
 */
function revertRefusal(issue: Doc<"issues">, row: Doc<"activity">, newestForField: boolean) {
  if (row.field === undefined || !(row.field in REVERT_ARGS) || row.type !== `${row.field}_changed`) {
    return "not_revertible";
  }
  if (!newestForField || fieldText(issue, row.field) !== row.newValue) {
    return "changed_since";
  }
  return null;
}

/** The rows of `newestFirst`, an `activityNewestFirst` prefix, that an owner can revert. */
export function revertibleRows(issue: Doc<"issues">, newestFirst: Doc<"activity">[]): Set<Id<"activity">> {
  const seenFields = new Set<string | undefined>();
  const revertible = new Set<Id<"activity">>();
  for (const row of newestFirst) {
    if (revertRefusal(issue, row, !seenFields.has(row.field)) === null) {
      revertible.add(row._id);
    }
    seenFields.add(row.field);
  }
  return revertible;
}

/**
 * Whether `row` is the newest activity row for its field among the issue's newest `LIST_LIMIT` rows, the window
 * the feed offers Revert in. A row outside it is not offered, so `revertChange` refuses it too.
 */
async function isNewestForField(ctx: MutationCtx, issue: Doc<"issues">, row: Doc<"activity">) {
  const recent = await activityNewestFirst(ctx, issue).take(LIST_LIMIT);
  return recent.find((newer) => newer.field === row.field)?._id === row._id;
}

/** Apply an activity row's old value back through `updateIssue`, logged as one `reverted` row. */
export async function revertActivity(ctx: MutationCtx, scope: OrgScope, activityId: Id<"activity">): Promise<void> {
  const change = await requireOrgRow(ctx, scope.org._id, activityId, "Change");
  const issue = await getOrgIssue(ctx, scope.org._id, change.issueId);
  const refusal = revertRefusal(issue, change, await isNewestForField(ctx, issue, change));
  if (refusal === "not_revertible") {
    refuse("Only status, assignee, priority and title changes can be reverted");
  }
  if (refusal === "changed_since") {
    const name = await new IssueKeys(ctx, issue.orgId).name(issue);
    refuse(`${name} ${change.field} has changed since; revert the latest change instead`);
  }
  const toArgs = REVERT_ARGS[change.field!];
  await updateIssue(
    ctx,
    scope,
    { issueId: issue._id, ...(await toArgs(ctx, issue, change.oldValue)) },
    { type: "reverted" }
  );
}
