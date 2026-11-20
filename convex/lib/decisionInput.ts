import { Infer } from "convex/values";
import { invalid } from "./refusals";
import { Doc, Id } from "../_generated/dataModel";
import { decisionAnswerValidator } from "../schema";

export const QUESTION_MAX = 500;
export const CHOICES_MIN = 2;
export const CHOICES_MAX = 5;
export const CHOICE_MAX = 60;
export const ANSWER_TEXT_MAX = 2000;
/** How much of an answer's text the `decided` activity row keeps. */
const SUMMARY_TEXT_MAX = 80;

type Answer = Infer<typeof decisionAnswerValidator>;
export type DecisionAsk = { issueId: Id<"issues">; question: string; choices?: string[]; recommended?: string };
export type DecisionAnswer = { decisionId: Id<"decisions">; choice?: string; text?: string };

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

export function parseAsk({ question, choices, recommended }: DecisionAsk) {
  const parsedChoices = choices === undefined ? undefined : parseChoices(choices);
  return {
    question: boundedText(question, QUESTION_MAX, "the question"),
    choices: parsedChoices,
    recommended: recommended === undefined ? undefined : pickChoice(parsedChoices, recommended),
  };
}

export function parseAnswer(decision: Doc<"decisions">, { choice, text }: DecisionAnswer): Answer {
  if (choice === undefined && text === undefined) {
    invalidDecision("answer with a choice, a text, or both");
  }
  return {
    choice: choice === undefined ? undefined : pickChoice(decision.choices, choice),
    text: text === undefined ? undefined : boundedText(text, ANSWER_TEXT_MAX, "the answer text"),
  };
}

/** The `decided` activity row's value: the choice and/or the start of the text. */
export function answerSummary({ choice, text }: Answer): string {
  const start = text !== undefined && text.length > SUMMARY_TEXT_MAX ? `${text.slice(0, SUMMARY_TEXT_MAX)}…` : text;
  return [choice, start].filter((part) => part !== undefined).join(": ");
}
