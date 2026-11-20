import { PaginationOptions, PaginationResult } from "convex/server";
import { Infer, v } from "convex/values";
import { refuse } from "./refusals";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { LIST_LIMIT } from "../../lib/api-contract";
import { decisionFields, decisionViaValidator } from "../schema";
import { logActivity } from "./activity";
import { answerSummary, DecisionAnswer, DecisionAsk, parseAnswer, parseAsk } from "./decisionInput";
import { IssueKeys } from "./issueKeys";
import { getOrgIssue, inOrg, orgRow, requireOrgRow } from "./orgRows";
import { OrgScope } from "./orgScope";

/** The most decisions one page of a story's history holds. One is open at a time and a person answers each. */
export const DECISION_PAGE_MAX = 50;

export type AnswerVia = Infer<typeof decisionViaValidator>;

export const decisionValidator = v.object({ _id: v.id("decisions"), _creationTime: v.number(), ...decisionFields });
export const listedDecisionValidator = v.object({
  ...decisionValidator.fields,
  asker: v.union(v.string(), v.null()),
  answerer: v.union(v.string(), v.null()),
});
export type ListedDecision = Infer<typeof listedDecisionValidator>;

type Db = { db: QueryCtx["db"] };

/** Decisions sit on stories, where the board shows the flag; a sub-task's refusal names its story. */
async function assertStory(ctx: Db, issue: Doc<"issues">): Promise<void> {
  if (issue.kind === "story") {
    return;
  }
  const parent = issue.parentIssueId === undefined ? null : await orgRow(ctx, issue.orgId, issue.parentIssueId);
  if (issue.kind === "subtask" && parent !== null) {
    refuse(`Decisions are asked on stories: ask on ${await new IssueKeys(ctx, issue.orgId).name(parent)}`);
  }
  refuse("Decisions are asked on stories");
}

async function openDecision(ctx: Db, issue: Doc<"issues">): Promise<Doc<"decisions"> | null> {
  return await inOrg(
    ctx.db.query("decisions").withIndex("by_issue_and_status", (q) => q.eq("issueId", issue._id).eq("status", "open")),
    issue.orgId
  ).first();
}

/** Ask the owner about one story; at most one decision per story is open. Never changes the issue. */
export async function askDecision(ctx: MutationCtx, scope: OrgScope, ask: DecisionAsk): Promise<Doc<"decisions">> {
  const issue = await getOrgIssue(ctx, scope.org._id, ask.issueId);
  await assertStory(ctx, issue);
  const fields = parseAsk(ask);
  const waiting = await openDecision(ctx, issue);
  if (waiting !== null) {
    refuse(`${await new IssueKeys(ctx, issue.orgId).name(issue)} is already waiting on the owner: ${waiting.question}`);
  }
  const decisionId = await ctx.db.insert("decisions", {
    ...fields,
    orgId: scope.org._id,
    issueId: issue._id,
    askedBy: scope.actorId,
    status: "open",
  });
  await logActivity(ctx, {
    orgId: scope.org._id,
    actorId: scope.actorId,
    issueId: issue._id,
    type: "decision_asked",
    newValue: fields.question,
  });
  return await requireOrgRow(ctx, scope.org._id, decisionId, "Decision");
}

/** Record the owner's answer to an open decision; the first answer wins. Never changes the issue. */
export async function answerDecision(ctx: MutationCtx, scope: OrgScope, answer: DecisionAnswer, via: AnswerVia): Promise<void> {
  const decision = await requireOrgRow(ctx, scope.org._id, answer.decisionId, "Decision");
  if (decision.status !== "open") {
    refuse("This decision was already answered");
  }
  const parsed = parseAnswer(decision, answer);
  await ctx.db.patch(decision._id, {
    status: "answered",
    answer: parsed,
    answeredBy: scope.actorId,
    answeredVia: via,
    answeredAt: Date.now(),
  });
  await logActivity(ctx, {
    orgId: scope.org._id,
    actorId: scope.actorId,
    issueId: decision.issueId,
    type: "decided",
    newValue: answerSummary(parsed),
  });
}

/** The story's decisions in the workspace, newest first. */
async function storyDecisions(ctx: Db, orgId: Id<"organizations">, issueId: Id<"issues">) {
  await getOrgIssue(ctx, orgId, issueId);
  return inOrg(ctx.db.query("decisions").withIndex("by_issue", (q) => q.eq("issueId", issueId)).order("desc"), orgId);
}

/** The rows with the asker's and the answerer's names. Each user is read once, however many rows name them. */
async function withNames(ctx: Db, decisions: Doc<"decisions">[]): Promise<ListedDecision[]> {
  const userIds = new Set(decisions.flatMap(({ askedBy, answeredBy }) => (answeredBy === undefined ? [askedBy] : [askedBy, answeredBy])));
  const names = new Map(await Promise.all([...userIds].map(async (id) => [id, (await ctx.db.get(id))?.name ?? null] as const)));
  const name = (id: Id<"users"> | undefined) => (id === undefined ? null : (names.get(id) ?? null));
  return decisions.map((decision) => ({ ...decision, asker: name(decision.askedBy), answerer: name(decision.answeredBy) }));
}

/** One page of a story's decisions for the story panel, newest first, with at most DECISION_PAGE_MAX rows. */
export async function pageIssueDecisions(
  ctx: Db,
  orgId: Id<"organizations">,
  issueId: Id<"issues">,
  paginationOpts: PaginationOptions
): Promise<PaginationResult<ListedDecision>> {
  const decisions = await storyDecisions(ctx, orgId, issueId);
  const result = await decisions.paginate({ ...paginationOpts, numItems: Math.min(paginationOpts.numItems, DECISION_PAGE_MAX) });
  return { ...result, page: await withNames(ctx, result.page) };
}

/** A story's newest LIST_LIMIT decisions for REST GET, which takes no cursor. */
export async function listIssueDecisions(ctx: Db, orgId: Id<"organizations">, issueId: Id<"issues">): Promise<ListedDecision[]> {
  const decisions = await storyDecisions(ctx, orgId, issueId);
  return await withNames(ctx, await decisions.take(LIST_LIMIT));
}
