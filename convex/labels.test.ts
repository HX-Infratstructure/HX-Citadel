/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { MAX_LABELS_PER_ISSUE } from "../lib/api-contract";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ORG, workspaceTest } from "./workspace.fixture";

const MEMBER = "user_member";

/** One story, `MAX_LABELS_PER_ISSUE` + 1 workspace labels, and the story already carrying the first `MAX_LABELS_PER_ISSUE`. */
async function storyAtLimit() {
  const t = await workspaceTest({ members: [{ clerkId: MEMBER, role: "member" }] });
  const asMember = t.withIdentity({ subject: MEMBER, org_id: ORG });
  const issueId = await t.run(async (ctx) => {
    const team = (await ctx.db.query("teams").first())!;
    const user = (await ctx.db.query("users").first())!;
    return await ctx.db.insert("issues", {
      orgId: team.orgId,
      teamId: team._id,
      kind: "story",
      number: 1,
      title: "Story",
      status: "todo",
      priority: "none",
      creatorId: user._id,
      sortOrder: 1,
    });
  });
  const toggle = (labelId: Id<"labels">) => asMember.mutation(api.labels.toggleOnIssue, { issueId, labelId });
  const labelIds: Id<"labels">[] = [];
  const added: boolean[] = [];
  for (let i = 0; i <= MAX_LABELS_PER_ISSUE; i++) {
    labelIds.push(await asMember.mutation(api.labels.create, { name: `Label ${i}`, color: "#5e6ad2" }));
    if (i < MAX_LABELS_PER_ISSUE) {
      added.push(await toggle(labelIds[i]));
    }
  }
  const listed = async () => (await asMember.query(api.labels.listForIssue, { issueId })).map((label) => label._id);
  return { t, toggle, listed, added, labelIds, extra: labelIds[MAX_LABELS_PER_ISSUE] };
}

describe("labels.toggleOnIssue at the per-issue limit", () => {
  test("the 21st label is refused with a typed refusal, and the issue keeps its 20", async () => {
    const s = await storyAtLimit();

    expect(s.added).toEqual(Array(20).fill(true));
    await expect(s.toggle(s.extra)).rejects.toMatchObject({
      data: { code: "rule_refused", message: "An issue can have at most 20 labels" },
    });
    expect(await s.listed()).toEqual(s.labelIds.slice(0, 20));
  });

  test("at the limit, removing a label still works, and then another can be added", async () => {
    const s = await storyAtLimit();

    expect(await s.toggle(s.labelIds[0])).toBe(false);
    expect(await s.toggle(s.extra)).toBe(true);
    expect(await s.listed()).toEqual([...s.labelIds.slice(1, 20), s.extra]);
  });

  test("a link to a deleted label counts toward the limit, because the board reads every link row", async () => {
    const s = await storyAtLimit();
    await s.t.run(async (ctx) => await ctx.db.delete(s.labelIds[0]));

    expect(await s.listed()).toHaveLength(19);
    await expect(s.toggle(s.extra)).rejects.toMatchObject({ data: { code: "rule_refused" } });
  });
});
