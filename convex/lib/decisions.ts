import { Infer, v } from "convex/values";
import { invalid, refuse } from "./refusals";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { getOrgIssue, LIST_LIMIT } from "../issues";
import { decisionAnswerValidator, decisionFields, decisionViaValidator } from "../schema";
import { logActivity } from "./activity";
import { IssueKeys } from "./issueKeys";
import { inOrg, orgRow, requireOrgRow } from "./orgRows";
import { OrgScope } from "./orgScope";

export const QUESTION_MAX = 500;
export const CHOICES_MIN = 2;
export const CHOICES_MAX = 5;
export const CHOICE_MAX = 60;
export const ANSWER_TEXT_MAX = 2000;
/** How much of an answer's text the `decided` activity row keeps. */
const SUMMARY_TEXT_MAX = 80;

export type AnswerVia = Infer<typeof decisionViaValidator>;
type Answer = Infer<typeof decisionAnswerValidator>;
export type DecisionAsk = { issueId: Id<"issues">; question: string; choices?: string[]; recommended?: string };
export type DecisionAnswer = { decisionId: Id<"decisions">; choice?: string; text?: string };

export const decisionValidator = v.object({ _id: v.id("decisions"), _creationTime: v.number(), ...decisionFields });
export const listedDecisionValidator = v.object({
  ...decisionValidator.fields,
  asker: v.union(v.string(), v.null()),
  answerer: v.union(v.string(), v.null()),
});
export type ListedDecision = Infer<typeof listedDecisionValidator>;

type Db = { db: QueryCtx["db"] };

function invalidDecision(message: string): never {
  invalid(`Invalid decision: ${message}`);
}

function boundedText(value: string, max: number, what: string): string {
  const text = value.trim();
  if (text.length === 0 || text.length > max) {
    invalidDecision(`${what} must be 1 to ${max} characters`);
  }
  return text;
}

function parseChoices(choices: string[]): string[] {
  if (choices.length < CHOICES_MIN || choices.length > CHOICES_MAX) {
    invalidDecision(`give ${CHOICES_MIN} to ${CHOICES_MAX} choices, not ${choices.length}`);
  }
  const parsed = choices.map((choice) => boundedText(choice, CHOICE_MAX, "each choice"));
  if (new Set(parsed).size !== parsed.length) {
    invalidDecision("the choices must all be different");
  }
  return parsed;
}

function pickChoice(choices: string[] | undefined, choice: string): string {
  const picked = choice.trim();
  if (!(choices ?? []).includes(picked)) {
    invalidDecision(`"${picked}" is not one of the choices`);
  }
  return picked;
}

function parseAsk({ question, choices, recommended }: DecisionAsk) {
  const parsedChoices = choices === undefined ? undefined : parseChoices(choices);
  return {
    question: boundedText(question, QUESTION_MAX, "the question"),
    choices: parsedChoices,
    recommended: recommended === undefined ? undefined : pickChoice(parsedChoices, recommended),
  };
}

function parseAnswer(decision: Doc<"decisions">, { choice, text }: DecisionAnswer): Answer {
  if (choice === undefined && text === undefined) {
    invalidDecision("answer with a choice, a text, or both");
  }
  return {
    choice: choice === undefined ? undefined : pickChoice(decision.choices, choice),
    text: text === undefined ? undefined : boundedText(text, ANSWER_TEXT_MAX, "the answer text"),
  };
}

/** The `decided` activity row's value: the choice and/or the start of the text. */
function answerSummary({ choice, text }: Answer): string {
  const start = text !== undefined && text.length > SUMMARY_TEXT_MAX ? `${text.slice(0, SUMMARY_TEXT_MAX)}…` : text;
  return [choice, start].filter((part) => part !== undefined).join(": ");
}

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

async function userName(ctx: Db, userId: Id<"users"> | undefined): Promise<string | null> {
  const user = userId === undefined ? null : await ctx.db.get(userId);
  return user?.name ?? null;
}

/** A story's latest LIST_LIMIT decisions, newest first, with the asker's and the answerer's names. */
export async function listIssueDecisions(ctx: Db, orgId: Id<"organizations">, issueId: Id<"issues">): Promise<ListedDecision[]> {
  await getOrgIssue(ctx, orgId, issueId);
  const decisions = await inOrg(
    ctx.db.query("decisions").withIndex("by_issue", (q) => q.eq("issueId", issueId)).order("desc"),
    orgId
  ).take(LIST_LIMIT);
  return await Promise.all(
    decisions.map(async (decision) => ({
      ...decision,
      asker: await userName(ctx, decision.askedBy),
      answerer: await userName(ctx, decision.answeredBy),
    }))
  );
}
