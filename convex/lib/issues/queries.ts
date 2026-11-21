import { paginationOptsValidator } from "convex/server";
import { ObjectType, v } from "convex/values";
import { Id } from "../../_generated/dataModel";
import { QueryCtx } from "../../_generated/server";
import { LIST_LIMIT, MAX_LABELS_PER_ISSUE } from "../../../lib/api-contract";
import { PARENT_KIND } from "../../../lib/issue-key";
import { isGatedStatus } from "../../../lib/issue-status";
import { inOrg, orgRow, requireOrgRow } from "../orgRows";
import { CLOSED_STATUSES } from "../rules/doneGate";
import { issueKindValidator, issueStatusValidator } from "../../schema";
import { capPage, PAGE_READ_ROWS } from "../paging";
import { TRANSACTION_LIMITS } from "../transactionLimits";

export const teamPageArgs = { teamId: v.id("teams"), paginationOpts: paginationOptsValidator };
export const parentCandidateArgs = { teamId: v.id("teams"), kind: issueKindValidator };
export const storyByNumberArgs = { teamId: v.id("teams"), number: v.number() };

const OPEN_STATUSES = issueStatusValidator.members
  .map((member) => member.value)
  .filter((status) => !CLOSED_STATUSES.has(status));

/**
 * The team's issues inside the workspace, highest `sortOrder` first. Other workspaces' rows are dropped inside the
 * query, so they never use up a page. A team that is missing or in another workspace is not found.
 */
async function teamIssuesByRank(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">, teamId: Id<"teams">) {
  await requireOrgRow(ctx, orgId, teamId, "Team");
  return inOrg(
    ctx.db.query("issues").withIndex("by_team_and_sort_order", (q) => q.eq("teamId", teamId)).order("desc"),
    orgId
  );
}

/**
 * An issue's label ids as stored, in link order. Only `attachLabel` (`convex/labels.ts`) and the dev seed
 * (`seed.demoData`) write links, and both link only a label of the issue's workspace. By owner decision
 * q-f874e530, the workspace is checked when a link is written, not here, so no label is read. A label delete must
 * delete its links first (`by_label`).
 */
async function issueLabelIds(ctx: { db: QueryCtx["db"] }, issueId: Id<"issues">): Promise<Id<"labels">[]> {
  const links = await ctx.db.query("issueLabels").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect();
  return links.map((link) => link.labelId);
}

/**
 * The backlog, one page at a time: open stories with no cycle, highest `sortOrder` (owner's rank) first.
 * It reads the team's rank index in order and filters inside the query, so the first page always starts at the
 * top-ranked story, however old it is. Closed rows count toward a page's reads, so a page under many of them
 * can come back short, or empty, with a cursor to the rest.
 */
export async function backlogPage(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  args: ObjectType<typeof teamPageArgs>
) {
  return await (await teamIssuesByRank(ctx, orgId, args.teamId))
    .filter((q) =>
      q.and(
        q.eq(q.field("kind"), "story"),
        q.eq(q.field("cycleId"), undefined),
        q.or(...OPEN_STATUSES.map((status) => q.eq(q.field("status"), status)))
      )
    )
    .paginate(capPage(args.paginationOpts));
}

/** The documents every `listByTeam` call reads before its page: the caller's user, workspace and membership, and the team (4), rounded up. */
const PAGE_FIXED_READS = 8;

/**
 * The most rows a `listByTeam` page pinned by an end cursor can hold and still read inside
 * `TRANSACTION_LIMITS.documentsRead`. Such a page reads its whole interval, ignoring `numItems` and `maximumRowsRead`
 * (convex-backend `crates/database/src/query/index_range.rs:168-170`), and `usePaginatedQuery` splits it only above 2 ×
 * `initialNumItems` rows, after a read that returned them, so it grows past 2 × LIST_LIMIT rows before a split; a test
 * in `issues.test.ts` holds this bound at 2 × LIST_LIMIT or more. It reads PAGE_FIXED_READS, at most
 * PAGE_READ_ROWS rows its filter drops, and for each row the row itself and its label links (at most
 * `MAX_LABELS_PER_ISSUE`, enforced when a label is added). A page of 2 × LIST_LIMIT rows then has
 * `PINNED_PAGE_MAX_ROWS - 2 * LIST_LIMIT` rows of headroom. Its index ranges, 1 + rows besides the fixed reads, stay
 * inside `TRANSACTION_LIMITS.databaseQueries`.
 */
export const PINNED_PAGE_MAX_ROWS = Math.floor(
  (TRANSACTION_LIMITS.documentsRead - PAGE_FIXED_READS - PAGE_READ_ROWS) / (MAX_LABELS_PER_ISSUE + 1)
);

/**
 * A team's issues, one page at a time, highest `sortOrder` first, each with the ids of the labels linked to it, in
 * link order. The loaded pages always hold the team's top-ranked issues, so a browser filter over them sees each
 * status's top-ranked issues.
 */
export async function teamPage(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  args: ObjectType<typeof teamPageArgs>
) {
  const result = await (await teamIssuesByRank(ctx, orgId, args.teamId)).paginate(capPage(args.paginationOpts));
  const page = await Promise.all(
    result.page.map(async (issue) => ({ ...issue, labelIds: await issueLabelIds(ctx, issue._id) }))
  );
  return { ...result, page };
}

const PARENT_STATUSES = issueStatusValidator.members
  .map((member) => member.value)
  .filter((status) => !isGatedStatus(status));

/** The issues a child of `kind` may sit under: the team's newest `LIST_LIMIT` issues one level up that are not In Review or Done. */
export async function parentCandidates(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  args: ObjectType<typeof parentCandidateArgs>
) {
  await requireOrgRow(ctx, orgId, args.teamId, "Team");
  const parentKind = PARENT_KIND[args.kind];
  if (parentKind === null) {
    return [];
  }
  const byStatus = await Promise.all(
    PARENT_STATUSES.map((status) =>
      inOrg(
        ctx.db
          .query("issues")
          .withIndex("by_team_kind_status", (q) => q.eq("teamId", args.teamId).eq("kind", parentKind).eq("status", status))
          .order("desc"),
        orgId
      ).take(LIST_LIMIT)
    )
  );
  return byStatus
    .flat()
    .sort((a, b) => b._creationTime - a._creationTime)
    .slice(0, LIST_LIMIT);
}

/** Look up a story by its display identifier (team key + number, e.g. ENG-42). */
export async function storyByNumber(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  args: ObjectType<typeof storyByNumberArgs>
) {
  if ((await orgRow(ctx, orgId, args.teamId)) === null) {
    return null;
  }
  const issue = await inOrg(
    ctx.db.query("issues").withIndex("by_team_and_number", (q) => q.eq("teamId", args.teamId).eq("number", args.number)),
    orgId
  ).unique();
  return issue?.kind === "story" ? issue : null;
}
