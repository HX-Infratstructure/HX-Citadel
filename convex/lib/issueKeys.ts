import { formatIssueKey } from "../../lib/issue-key";
import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { orgRow } from "./orgRows";

type Db = { db: QueryCtx["db"] };

function cached<K, V>(cache: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> {
  let value = cache.get(key);
  if (value === undefined) {
    value = load();
    cache.set(key, value);
  }
  return value;
}

/**
 * How one request names one workspace's issues. A story's key is KEY-12 and a sub-task's is KEY-12.3. An issue
 * has no key (null) when it is an epic or a feature, when its number is missing, or when its team or parent is not
 * a row of this workspace, so a key is never partial and never carries another workspace's number. Where a name
 * is needed, the title stands in for a missing key. Each team and parent is read once per instance.
 */
export class IssueKeys {
  private readonly teams = new Map<Id<"teams">, Promise<Doc<"teams"> | null>>();
  private readonly parents = new Map<Id<"issues">, Promise<Doc<"issues"> | null>>();

  constructor(
    private readonly ctx: Db,
    private readonly orgId: Id<"organizations">
  ) {}

  /** KEY-12 or KEY-12.3, or null when the issue has no key. */
  async key(issue: Doc<"issues">): Promise<string | null> {
    const team = await cached(this.teams, issue.teamId, () => orgRow(this.ctx, this.orgId, issue.teamId));
    if (team === null) {
      return null;
    }
    const parent = await this.parent(issue);
    return formatIssueKey(team.key, issue, parent?.number);
  }

  /** The key, or the title when there is none: how a refusal names an issue. */
  async name(issue: Doc<"issues">): Promise<string> {
    return (await this.key(issue)) ?? issue.title;
  }

  /** "KEY-12.3 Write API", or the title alone when there is no key. */
  async label(issue: Doc<"issues">): Promise<string> {
    const key = await this.key(issue);
    return key === null ? issue.title : `${key} ${issue.title}`;
  }

  /** The parent's key, or null when there is no parent in this workspace or it has no key. */
  async parentKey(issue: Doc<"issues">): Promise<string | null> {
    const parent = await this.parent(issue);
    return parent === null ? null : await this.key(parent);
  }

  private async parent(issue: Doc<"issues">): Promise<Doc<"issues"> | null> {
    const parentId = issue.parentIssueId;
    if (parentId === undefined) {
      return null;
    }
    return await cached(this.parents, parentId, () => orgRow(this.ctx, this.orgId, parentId));
  }
}
