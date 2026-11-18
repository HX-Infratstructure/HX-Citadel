import { type Refusal, STALE } from "../../lib/api-contract";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { notFound, refusal } from "./refusals";

export const FIRST_VERSION = 1;

/** Rows written before `version` existed read as the first version. */
export function issueVersion(issue: Doc<"issues">): number {
  return issue.version ?? FIRST_VERSION;
}

type IssueFields = Partial<Omit<Doc<"issues">, "_id" | "_creationTime" | "version">>;

/** Fields the server keeps for itself. No client reads or If-Match guards them, so they never move the version. */
export const BOOKKEEPING_FIELDS: ReadonlySet<keyof IssueFields> = new Set(["nextSubNumber"]);

/**
 * The only place an issue row is patched, so every change bumps its version by one, unless it
 * changes only bookkeeping fields. A patch that changes no field writes nothing, so it cannot make
 * another writer's If-Match stale. A caller that already holds the row passes it and saves a read.
 */
export async function patchIssue(
  ctx: { db: MutationCtx["db"] },
  issueOrId: Doc<"issues"> | Id<"issues">,
  fields: IssueFields
): Promise<number> {
  const issue = typeof issueOrId === "string" ? await ctx.db.get(issueOrId) : issueOrId;
  if (issue === null) {
    notFound(`Issue ${issueOrId} not found`);
  }
  const keys = Object.keys(fields) as (keyof IssueFields)[];
  const changed = keys.filter((key) => fields[key] !== issue[key]);
  if (changed.length === 0) {
    return issueVersion(issue);
  }
  const bumps = changed.some((key) => !BOOKKEEPING_FIELDS.has(key));
  const version = bumps ? issueVersion(issue) + 1 : issueVersion(issue);
  await ctx.db.patch(issue._id, { ...fields, version });
  return version;
}

/** The clients still read the stale code through this type; it goes once they import `lib/api-contract`. */
export type StaleData = Refusal & { code: typeof STALE };

/** A write that names a version the issue has moved past. */
export function assertIfMatch(issue: Doc<"issues">, label: string, ifMatch: number | undefined): void {
  if (ifMatch === undefined || ifMatch === issueVersion(issue)) {
    return;
  }
  refusal(STALE, `${label} is at version ${issueVersion(issue)}`);
}
