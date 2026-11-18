import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

export const FIRST_VERSION = 1;

/** Rows written before `version` existed read as the first version. */
export function issueVersion(issue: Doc<"issues">): number {
  return issue.version ?? FIRST_VERSION;
}

type IssueFields = Partial<Omit<Doc<"issues">, "_id" | "_creationTime" | "version">>;

/**
 * The only place an issue row is patched, so every change bumps its version by one.
 * A patch that changes no field writes nothing, so it cannot make another writer's If-Match stale.
 */
export async function patchIssue(
  ctx: { db: MutationCtx["db"] },
  issueId: Id<"issues">,
  fields: IssueFields
): Promise<number> {
  const issue = await ctx.db.get(issueId);
  if (issue === null) {
    throw new Error(`Issue ${issueId} not found`);
  }
  const keys = Object.keys(fields) as (keyof IssueFields)[];
  if (keys.every((key) => fields[key] === issue[key])) {
    return issueVersion(issue);
  }
  const version = issueVersion(issue) + 1;
  await ctx.db.patch(issueId, { ...fields, version });
  return version;
}

export type StaleData = { code: "stale"; message: string };

/** A write that names a version the issue has moved past; the HTTP layer maps it to 412. */
export function assertIfMatch(issue: Doc<"issues">, label: string, ifMatch: number | undefined): void {
  if (ifMatch === undefined || ifMatch === issueVersion(issue)) {
    return;
  }
  throw new ConvexError<StaleData>({ code: "stale", message: `${label} is at version ${issueVersion(issue)}` });
}
