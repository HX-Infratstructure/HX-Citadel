/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import schema from "@/convex/schema";
import { TeamIssue } from "@/components/shared/issue-meta";
import { EMPTY_FILTERS, IssueFilters, issueMatchesFilters, UNASSIGNED_FILTER } from "./filters";

const modules = import.meta.glob("../../convex/**/*.*s");
const ORG_CLAIM = "org_test";
const MEMBER_CLERK_ID = "user_member";
const PAGE_ITEMS = 2;

type Match = "status" | "priority" | "assignee" | "unassigned" | "label";
type Fields = Pick<Doc<"issues">, "orgId" | "teamId" | "kind" | "status" | "priority" | "creatorId" | "assigneeId">;

/**
 * A team whose first page of `listByTeam` holds two issues no filter below matches, and whose later pages hold one
 * issue per filter. Returns the loaded pages in order and the ids of the later-page issues.
 */
async function loadPages() {
  const t = convexTest({ schema, modules });
  const ids = await t.run(async (ctx) => {
    const memberId = await ctx.db.insert("users", { clerkId: MEMBER_CLERK_ID, name: "Member", email: "m@example.com" });
    const otherId = await ctx.db.insert("users", { clerkId: "user_other", name: "Other", email: "o@example.com" });
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG_CLAIM, name: "Org", slug: "org" });
    await ctx.db.insert("members", { orgId, userId: memberId, role: "member", clerkMembershipId: "mem_member" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Eng", key: "ENG", nextIssueNumber: 1 });
    const bug = await ctx.db.insert("labels", { orgId, name: "Bug", color: "#ff0000" });
    const other = await ctx.db.insert("labels", { orgId, name: "Other", color: "#0000ff" });
    const base: Fields = { orgId, teamId, kind: "story", status: "backlog", priority: "none", creatorId: memberId, assigneeId: memberId };
    let sortOrder = 10_000;
    const insert = async (title: string, patch: Partial<Fields> = {}, labelId?: Id<"labels">) => {
      sortOrder -= 1000;
      const issueId = await ctx.db.insert("issues", { ...base, ...patch, title, sortOrder });
      if (labelId) {
        await ctx.db.insert("issueLabels", { issueId, labelId });
      }
      return issueId;
    };
    await insert("Page 1 plain");
    await insert("Page 1 other label", {}, other);
    const later: Record<Match, Id<"issues">> = {
      status: await insert("Later status", { status: "in_review" }),
      priority: await insert("Later priority", { priority: "urgent" }),
      assignee: await insert("Later assignee", { assigneeId: otherId }),
      unassigned: await insert("Later unassigned", { assigneeId: undefined }),
      label: await insert("Later label", {}, bug),
    };
    return { teamId, otherId, bug, later };
  });

  const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });
  const pages: TeamIssue[][] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: { page: TeamIssue[]; isDone: boolean; continueCursor: string } = await asMember.query(api.issues.listByTeam, { teamId: ids.teamId, paginationOpts: { numItems: PAGE_ITEMS, cursor } });
    pages.push(result.page);
    if (result.isDone) {
      return { ...ids, pages };
    }
    cursor = result.continueCursor;
  }
}

const matching = (pages: TeamIssue[][], filters: IssueFilters) =>
  pages.flat().filter((issue) => issueMatchesFilters(issue, filters)).map((issue) => issue._id);

describe("issueMatchesFilters over the pages listByTeam loads", () => {
  it("finds each later-page match only once that page is loaded", async () => {
    const { pages, otherId, bug, later } = await loadPages();
    const cases: [Match, IssueFilters][] = [
      ["status", { ...EMPTY_FILTERS, statuses: ["in_review"] }],
      ["priority", { ...EMPTY_FILTERS, priorities: ["urgent"] }],
      ["assignee", { ...EMPTY_FILTERS, assignees: [otherId] }],
      ["unassigned", { ...EMPTY_FILTERS, assignees: [UNASSIGNED_FILTER] }],
      ["label", { ...EMPTY_FILTERS, labels: [bug] }],
    ];
    expect(pages.length).toBeGreaterThan(2);
    for (const [name, filters] of cases) {
      const loadedAt = pages.findIndex((page) => page.some((issue) => issue._id === later[name]));
      expect(loadedAt, name).toBeGreaterThan(0);
      expect(matching(pages.slice(0, loadedAt), filters), name).toEqual([]);
      expect(matching(pages.slice(0, loadedAt + 1), filters), name).toEqual([later[name]]);
      expect(matching(pages, filters), name).toEqual([later[name]]);
    }
  });
});
