import { PaginationOptions, paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ObjectType, v } from "convex/values";
import { invalid, notFound, refuse } from "./lib/refusals";
import { MAX_LABELS_PER_ISSUE } from "../lib/api-contract";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { PARENT_KIND } from "../lib/issue-key";
import { isGatedStatus } from "../lib/issue-status";
import { respaceTie, SORT_GAP } from "../lib/sort-order";
import { changedFields, fieldText, FieldLogOptions, logActivity, logFieldChanges } from "./lib/activity";
import { orgAdminMutation, orgMutation, orgQuery } from "./lib/customFunctions";
import { IssueKeys } from "./lib/issueKeys";
import { patchIssue } from "./lib/issueVersion";
import { findMembership } from "./lib/mirror";
import { inOrg, orgRow, requireOrgRow } from "./lib/orgRows";
import { OrgScope } from "./lib/orgScope";
import { assertCycleInTeam } from "./lib/rules/cycles";
import {
  assertDoneGate,
  assertDoneGateAfterUpdate,
  CLOSED_STATUSES,
} from "./lib/rules/doneGate";
import {
  assertParentOpen,
  assertValidParent,
  cascadeProject,
  FIRST_SUB_NUMBER,
  nextSubNumber,
} from "./lib/rules/levels";
import {
  assertProofUrl,
  assertTestingSubtask,
  createTestingSubtask,
} from "./lib/rules/testing";
import { assertWipFree, assertWipFreeAfterUpdate } from "./lib/rules/wip";
import {
  issueKindValidator,
  issuePriorityValidator,
  issueStatusValidator,
  issueTypeValidator,
} from "./schema";

export const issueShape = {
  _id: v.id("issues"),
  _creationTime: v.number(),
  orgId: v.id("organizations"),
  teamId: v.id("teams"),
  kind: issueKindValidator,
  type: v.optional(issueTypeValidator),
  number: v.optional(v.number()),
  subNumber: v.optional(v.number()),
  nextSubNumber: v.optional(v.number()),
  title: v.string(),
  description: v.optional(v.string()),
  status: issueStatusValidator,
  priority: issuePriorityValidator,
  assigneeId: v.optional(v.id("users")),
  creatorId: v.id("users"),
  projectId: v.optional(v.id("projects")),
  cycleId: v.optional(v.id("cycles")),
  parentIssueId: v.optional(v.id("issues")),
  estimate: v.optional(v.number()),
  dueDate: v.optional(v.number()),
  sortOrder: v.number(),
  testing: v.optional(v.boolean()),
  proofUrl: v.optional(v.string()),
  version: v.optional(v.number()),
};

/** Verify an issue belongs to the caller's org before any read/write. */
export async function getOrgIssue(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
  issueId: Id<"issues">
): Promise<Doc<"issues">> {
  return await requireOrgRow(ctx, orgId, issueId, "Issue");
}

/** The most issues one list or page returns. */
export const LIST_LIMIT = 500;

const OPEN_STATUSES = issueStatusValidator.members
  .map((member) => member.value)
  .filter((status) => !CLOSED_STATUSES.has(status));

/** Convex fails a query or mutation past this many documents read. */
const CONVEX_DOCUMENT_READS = 32_000;

/** Rows and bytes one page may read, rows its filter drops included: well inside `CONVEX_DOCUMENT_READS` and 16 MiB. */
export const PAGE_READ_ROWS = 8_000;
const PAGE_READ_BYTES = 8 * 1024 * 1024;

/**
 * `paginationOpts` with the page held to at most `LIST_LIMIT` items and `PAGE_READ_ROWS` rows or `PAGE_READ_BYTES`
 * read, whatever the client asks for. A page that runs out of reads first comes back `SplitRequired`, holding every
 * match among the rows it read, and its `continueCursor` resumes after the last row read. A caller that follows
 * `continueCursor`, like the REST list, misses nothing; `usePaginatedQuery` replaces the page by its two halves at
 * `splitCursor`.
 */
export function capPage(paginationOpts: PaginationOptions): PaginationOptions {
  return {
    ...paginationOpts,
    numItems: Math.min(paginationOpts.numItems, LIST_LIMIT),
    maximumRowsRead: PAGE_READ_ROWS,
    maximumBytesRead: PAGE_READ_BYTES,
  };
}

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
 * An issue's label ids as stored, in link order. Only `labels.toggleOnIssue` and the dev seed (`seed.demoData`) write
 * links, and both link only a label of the issue's workspace. By owner decision q-f874e530, the workspace is checked
 * when a link is written, not here, so no label is read. A label delete must delete its links first (`by_label`).
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
export const listBacklog = orgQuery({
  args: { teamId: v.id("teams"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object(issueShape)),
  handler: async (ctx, args) => {
    return await (await teamIssuesByRank(ctx, ctx.org._id, args.teamId))
      .filter((q) =>
        q.and(
          q.eq(q.field("kind"), "story"),
          q.eq(q.field("cycleId"), undefined),
          q.or(...OPEN_STATUSES.map((status) => q.eq(q.field("status"), status)))
        )
      )
      .paginate(capPage(args.paginationOpts));
  },
});

/** The documents every `listByTeam` call reads before its page: the caller's user, workspace and membership, and the team (4), rounded up. */
const PAGE_FIXED_READS = 8;

/**
 * The most rows a `listByTeam` page pinned by an end cursor can hold and still read inside `CONVEX_DOCUMENT_READS`.
 * Such a page reads its whole interval, ignoring `numItems` and `maximumRowsRead` (convex-backend
 * `crates/database/src/query/index_range.rs:168-170`), and `usePaginatedQuery` splits it only above 2 ×
 * `initialNumItems` rows, after a read that returned them, so it grows past 2 × LIST_LIMIT rows before a split; a test
 * in `issues.test.ts` holds this bound at 2 × LIST_LIMIT or more. It reads PAGE_FIXED_READS, at most
 * PAGE_READ_ROWS rows its filter drops, and for each row the row itself and its label links (at most
 * `MAX_LABELS_PER_ISSUE`, enforced when a label is added). A page of 2 × LIST_LIMIT rows then has
 * `PINNED_PAGE_MAX_ROWS - 2 * LIST_LIMIT` rows of headroom. Its index ranges, 1 + rows besides the fixed reads, stay
 * inside Convex's 4,096.
 */
export const PINNED_PAGE_MAX_ROWS = Math.floor(
  (CONVEX_DOCUMENT_READS - PAGE_FIXED_READS - PAGE_READ_ROWS) / (MAX_LABELS_PER_ISSUE + 1)
);

/**
 * A team's issues, one page at a time, highest `sortOrder` first, each with the ids of the labels linked to it, in
 * link order. The loaded pages always hold the team's top-ranked issues, so a browser filter over them sees each
 * status's top-ranked issues.
 */
export const listByTeam = orgQuery({
  args: { teamId: v.id("teams"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ ...issueShape, labelIds: v.array(v.id("labels")) })),
  handler: async (ctx, args) => {
    const result = await (await teamIssuesByRank(ctx, ctx.org._id, args.teamId)).paginate(capPage(args.paginationOpts));
    const page = await Promise.all(
      result.page.map(async (issue) => ({ ...issue, labelIds: await issueLabelIds(ctx, issue._id) }))
    );
    return { ...result, page };
  },
});

const PARENT_STATUSES = issueStatusValidator.members
  .map((member) => member.value)
  .filter((status) => !isGatedStatus(status));

/** The issues a child of `kind` may sit under: the team's newest `LIST_LIMIT` issues one level up that are not In Review or Done. */
export const listParentCandidates = orgQuery({
  args: { teamId: v.id("teams"), kind: issueKindValidator },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.teamId, "Team");
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
          ctx.org._id
        ).take(LIST_LIMIT)
      )
    );
    return byStatus
      .flat()
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, LIST_LIMIT);
  },
});

export const get = orgQuery({
  args: { issueId: v.id("issues") },
  returns: v.union(v.object(issueShape), v.null()),
  handler: async (ctx, args) => await orgRow(ctx, ctx.org._id, args.issueId),
});

/** Look up a story by its display identifier (team key + number, e.g. ENG-42). */
export const getByNumber = orgQuery({
  args: { teamId: v.id("teams"), number: v.number() },
  returns: v.union(v.object(issueShape), v.null()),
  handler: async (ctx, args) => {
    if ((await orgRow(ctx, ctx.org._id, args.teamId)) === null) {
      return null;
    }
    const issue = await inOrg(
      ctx.db.query("issues").withIndex("by_team_and_number", (q) => q.eq("teamId", args.teamId).eq("number", args.number)),
      ctx.org._id
    ).unique();
    return issue?.kind === "story" ? issue : null;
  },
});

/** An assignee must be a member of the workspace. A non-member is never loaded, so the refusal can't name them. */
async function assertAssignee(ctx: MutationCtx, orgId: Id<"organizations">, userId: Id<"users">): Promise<void> {
  if ((await findMembership(ctx, orgId, userId)) === null) {
    notFound("Assignee not found");
  }
}

/** A title as stored: trimmed, and never empty. Every create and update path comes through here. */
function issueTitle(text: string): string {
  const title = text.trim();
  if (title === "") {
    invalid("Title cannot be empty");
  }
  return title;
}

/** Stories carry a type (default story); other levels carry none. */
export function storyType(
  kind: Doc<"issues">["kind"],
  type: Doc<"issues">["type"]
): Doc<"issues">["type"] {
  return kind === "story" ? (type ?? "story") : undefined;
}

/**
 * Stories take the next team number (ENG-1, ENG-2, ...) and start their own subtask counter;
 * subtasks take the next number under their story.
 */
async function claimNumbering(
  ctx: MutationCtx,
  team: Doc<"teams">,
  kind: Doc<"issues">["kind"],
  parentIssueId: Id<"issues"> | undefined
): Promise<Pick<Doc<"issues">, "number" | "subNumber" | "nextSubNumber">> {
  if (kind === "story") {
    const number = team.nextIssueNumber;
    await ctx.db.patch(team._id, { nextIssueNumber: number + 1 });
    return { number, nextSubNumber: FIRST_SUB_NUMBER };
  }
  if (kind === "subtask" && parentIssueId) {
    return { subNumber: await nextSubNumber(ctx, team.orgId, parentIssueId) };
  }
  return {};
}

const createArgs = {
  teamId: v.id("teams"),
  kind: v.optional(issueKindValidator),
  type: v.optional(issueTypeValidator),
  title: v.string(),
  description: v.optional(v.string()),
  status: v.optional(issueStatusValidator),
  priority: v.optional(issuePriorityValidator),
  assigneeId: v.optional(v.id("users")),
  projectId: v.optional(v.id("projects")),
  cycleId: v.optional(v.id("cycles")),
  parentIssueId: v.optional(v.id("issues")),
  estimate: v.optional(v.number()),
  dueDate: v.optional(v.number()),
};

export type CreateIssueArgs = ObjectType<typeof createArgs>;

/** Every create rule in one place; the Clerk session and agent calls both come through here. */
export async function createIssue(
  ctx: MutationCtx,
  scope: OrgScope,
  args: CreateIssueArgs
): Promise<Id<"issues">> {
  const { org, actorId } = scope;
  const title = issueTitle(args.title);
  const team = await requireOrgRow(ctx, org._id, args.teamId, "Team");

  const kind = args.kind ?? "story";
  const parent = args.parentIssueId ? await getOrgIssue(ctx, org._id, args.parentIssueId) : null;
  const placement = await assertValidParent(ctx, org._id, kind, {
    teamId: args.teamId,
    parentIssueId: args.parentIssueId,
    projectId: args.projectId,
  });
  if (parent !== null) {
    await assertParentOpen(ctx, parent, kind);
  }
  if (args.cycleId !== undefined) {
    await assertCycleInTeam(ctx, org._id, args.cycleId, placement.teamId);
  }
  if (args.assigneeId !== undefined) {
    await assertAssignee(ctx, org._id, args.assigneeId);
  }
  const status = args.status ?? "todo";
  await assertWipFree(ctx, { orgId: org._id, assigneeId: args.assigneeId, kind, status });
  const numbering = await claimNumbering(ctx, team, kind, args.parentIssueId);

  // New issues sort to the top of their column.
  const highest = await inOrg(
    ctx.db.query("issues").withIndex("by_team_and_sort_order", (q) => q.eq("teamId", placement.teamId)).order("desc"),
    org._id
  ).first();
  const sortOrder = (highest?.sortOrder ?? 0) + SORT_GAP;

  const issueId = await ctx.db.insert("issues", {
    orgId: org._id,
    teamId: placement.teamId,
    kind,
    type: storyType(kind, args.type),
    ...numbering,
    title,
    description: args.description,
    status,
    priority: args.priority ?? "none",
    assigneeId: args.assigneeId,
    creatorId: actorId,
    projectId: placement.projectId,
    cycleId: args.cycleId,
    parentIssueId: args.parentIssueId,
    estimate: args.estimate,
    dueDate: args.dueDate,
    sortOrder,
  });
  const created = await ctx.db.get(issueId);
  if (created?.kind === "story") {
    await createTestingSubtask(ctx, created);
  }
  if (created !== null) {
    await assertDoneGate(ctx, created, status);
  }

  await logActivity(ctx, { orgId: org._id, issueId, actorId, type: "created" });

  return issueId;
}

export const create = orgMutation({
  args: createArgs,
  returns: v.id("issues"),
  handler: async (ctx, args) =>
    await createIssue(ctx, { org: ctx.org, actorId: ctx.user._id }, args),
});

/**
 * The team's issues at `rank`, other than `issue`, in creation order. Bounded by design: create takes the highest +
 * `SORT_GAP`, `placeRank` re-spaces every row it ties and the seed spaces by position, so a rank holds one story,
 * its Complete testing sub-task (which takes the story's rank, `createTestingSubtask`) and rows a legacy write left tied.
 */
async function othersAtRank(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  rank: number
): Promise<Doc<"issues">[]> {
  const atRank = await inOrg(
    ctx.db.query("issues").withIndex("by_team_and_sort_order", (q) => q.eq("teamId", issue.teamId).eq("sortOrder", rank)),
    issue.orgId
  ).collect();
  return atRank.filter((other) => other._id !== issue._id);
}

/** The team's closest rank above `rank`, if any. */
async function nextHigherRank(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  rank: number
): Promise<number | undefined> {
  const nextHigher = await inOrg(
    ctx.db
      .query("issues")
      .withIndex("by_team_and_sort_order", (q) => q.eq("teamId", issue.teamId).gt("sortOrder", rank))
      .order("asc"),
    issue.orgId
  ).first();
  return nextHigher?.sortOrder;
}

/**
 * The rank to store for an issue moved to `rank`. Other issues in the team that already hold `rank` are re-spaced
 * upward first (`respaceTie`), and the moved issue takes the middle of their run, so it never ties a neighbour and no
 * issue ends below `rank`. When the gap to the next higher rank can't hold distinct numbers, the issues at that rank
 * join the run and the gap widens to the rank above them.
 */
async function placeRank(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  rank: number
): Promise<number> {
  const run = await othersAtRank(ctx, issue, rank);
  if (run.length === 0) {
    return rank;
  }
  let ceiling = await nextHigherRank(ctx, issue, rank);
  let ranks = respaceTie(rank, run, ceiling);
  while (ranks === undefined && ceiling !== undefined) {
    run.push(...(await othersAtRank(ctx, issue, ceiling)));
    ceiling = await nextHigherRank(ctx, issue, ceiling);
    ranks = respaceTie(rank, run, ceiling);
  }
  if (ranks === undefined) {
    // Unreachable while ranks stay within ±2^62: with no ceiling the run steps by SORT_GAP, wider than a float's
    // spacing there.
    refuse("There is no room to rank this issue here");
  }
  for (const { row, sortOrder } of ranks.others) {
    await patchIssue(ctx, row, { sortOrder });
  }
  return ranks.moved;
}

const updateArgs = {
  issueId: v.id("issues"),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  status: v.optional(issueStatusValidator),
  priority: v.optional(issuePriorityValidator),
  assigneeId: v.optional(v.union(v.id("users"), v.null())),
  projectId: v.optional(v.union(v.id("projects"), v.null())),
  cycleId: v.optional(v.union(v.id("cycles"), v.null())),
  estimate: v.optional(v.union(v.number(), v.null())),
  dueDate: v.optional(v.union(v.number(), v.null())),
  sortOrder: v.optional(v.number()),
};

export type UpdateIssueArgs = ObjectType<typeof updateArgs>;

/** Every update rule in one place; the Clerk session and agent calls both come through here. */
export async function updateIssue(
  ctx: MutationCtx,
  scope: OrgScope,
  args: UpdateIssueArgs,
  log: FieldLogOptions = {}
): Promise<void> {
  const issue = await getOrgIssue(ctx, scope.org._id, args.issueId);

  const actor = { orgId: scope.org._id, actorId: scope.actorId };
  const updates: Partial<Doc<"issues">> = {};

  if (args.title !== undefined) {
    const title = issueTitle(args.title);
    if (title !== issue.title) {
      updates.title = title;
    }
  }
  if (args.description !== undefined) {
    updates.description = args.description;
  }
  if (args.status !== undefined && args.status !== issue.status) {
    updates.status = args.status;
  }
  if (args.priority !== undefined && args.priority !== issue.priority) {
    updates.priority = args.priority;
  }
  if (args.assigneeId !== undefined) {
    if (args.assigneeId !== null) {
      await assertAssignee(ctx, scope.org._id, args.assigneeId);
    }
    updates.assigneeId = args.assigneeId ?? undefined;
  }
  if (args.projectId !== undefined) {
    const placement = await assertValidParent(ctx, scope.org._id, issue.kind, {
      teamId: issue.teamId,
      parentIssueId: issue.parentIssueId,
      projectId: args.projectId ?? undefined,
    });
    if (args.projectId === null && placement.projectId !== undefined) {
      const parentKind = PARENT_KIND[issue.kind];
      refuse(
        `This ${issue.kind}'s project comes from its ${parentKind}; move it out of the ${parentKind} to clear the project`
      );
    }
    updates.projectId = placement.projectId;
    if (placement.projectId !== issue.projectId) {
      await cascadeProject(ctx, issue._id, placement.projectId, actor);
    }
  }
  if (args.cycleId !== undefined) {
    if (args.cycleId !== null) {
      await assertCycleInTeam(ctx, scope.org._id, args.cycleId, issue.teamId);
    }
    updates.cycleId = args.cycleId ?? undefined;
  }
  if (args.estimate !== undefined) {
    updates.estimate = args.estimate ?? undefined;
  }
  if (args.dueDate !== undefined) {
    updates.dueDate = args.dueDate ?? undefined;
  }
  if (args.sortOrder !== undefined && args.sortOrder !== issue.sortOrder) {
    updates.sortOrder = await placeRank(ctx, issue, args.sortOrder);
  }

  await assertWipFreeAfterUpdate(ctx, issue, updates);
  await assertDoneGateAfterUpdate(ctx, issue, updates);
  await patchIssue(ctx, issue._id, updates);
  await logFieldChanges(ctx, actor, issue._id, changedFields(issue, updates), log);
}

export const update = orgMutation({
  args: updateArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await updateIssue(ctx, { org: ctx.org, actorId: ctx.user._id }, args);
    return null;
  },
});

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
export const revertChange = orgAdminMutation({
  args: { activityId: v.id("activity") },
  returns: v.null(),
  handler: async (ctx, { activityId }) => {
    const change = await requireOrgRow(ctx, ctx.org._id, activityId, "Change");
    const issue = await getOrgIssue(ctx, ctx.org._id, change.issueId);
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
      { org: ctx.org, actorId: ctx.user._id },
      { issueId: issue._id, ...(await toArgs(ctx, issue, change.oldValue)) },
      { type: "reverted" }
    );
    return null;
  },
});

async function logProofChange(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  proofUrl: string,
  actorId: Id<"users">
): Promise<void> {
  if (proofUrl === (issue.proofUrl ?? "")) {
    return;
  }
  await logActivity(ctx, {
    orgId: issue.orgId,
    issueId: issue._id,
    actorId,
    type: proofUrl === "" ? "proof_cleared" : "proof_set",
    field: "proof",
    oldValue: issue.proofUrl,
    newValue: proofUrl || undefined,
  });
}

/** Sets or clears (empty string) the proof URL on a Complete testing sub-task. */
export async function setIssueProof(
  ctx: MutationCtx,
  scope: OrgScope,
  args: { issueId: Id<"issues">; proofUrl: string }
): Promise<void> {
  const issue = await getOrgIssue(ctx, scope.org._id, args.issueId);
  assertTestingSubtask(issue);
  const proofUrl = args.proofUrl.trim();
  if (proofUrl !== "") {
    assertProofUrl(proofUrl);
  }
  await patchIssue(ctx, issue._id, { proofUrl: proofUrl || undefined });
  await logProofChange(ctx, issue, proofUrl, scope.actorId);
}

export const setProof = orgMutation({
  args: { issueId: v.id("issues"), proofUrl: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await setIssueProof(ctx, { org: ctx.org, actorId: ctx.user._id }, args);
    return null;
  },
});
