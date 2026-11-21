/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { MAX_LABELS_PER_ISSUE, TOO_MANY_LABELS } from "../lib/api-contract";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { footprint, refusalOf } from "./test-helpers.fixture";
import { ORG, workspaceTest } from "./workspace.fixture";

const MEMBER = "user_member";

/** The HX workspace with one story and no labels, a member signed in, and what that member can read and call. */
async function story() {
  const t = await workspaceTest({ members: [{ clerkId: MEMBER, role: "member" }] });
  const asMember = t.withIdentity({ subject: MEMBER, org_id: ORG });
  const { orgId, issueId } = await t.run(async (ctx) => {
    const team = (await ctx.db.query("teams").first())!;
    const user = (await ctx.db.query("users").first())!;
    const issueId = await ctx.db.insert("issues", {
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
    return { orgId: team.orgId, issueId };
  });
  const listed = async () => (await asMember.query(api.labels.listForIssue, { issueId })).map((label) => label._id);
  const workspaceLabels = async () => (await asMember.query(api.labels.list, {})).map((label) => label._id);
  const createOnIssue = (name: string) => asMember.mutation(api.labels.createOnIssue, { issueId, name, color: "#ff8800" });
  return { t, asMember, orgId, issueId, listed, workspaceLabels, createOnIssue };
}

/** One story, `MAX_LABELS_PER_ISSUE` + 1 workspace labels, and the story already carrying the first `MAX_LABELS_PER_ISSUE`. */
async function storyAtLimit() {
  const s = await story();
  const toggle = (labelId: Id<"labels">) => s.asMember.mutation(api.labels.toggleOnIssue, { issueId: s.issueId, labelId });
  const labelIds: Id<"labels">[] = [];
  const added: boolean[] = [];
  for (let i = 0; i <= MAX_LABELS_PER_ISSUE; i++) {
    labelIds.push(await s.t.run((ctx) => ctx.db.insert("labels", { orgId: s.orgId, name: `Label ${i}`, color: "#5e6ad2" })));
    if (i < MAX_LABELS_PER_ISSUE) {
      added.push(await toggle(labelIds[i]));
    }
  }
  return { ...s, toggle, added, labelIds, extra: labelIds[MAX_LABELS_PER_ISSUE] };
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

describe("labels.createOnIssue", () => {
  // Catches the two-call defect: a label created in the workspace but never attached, or attached without its activity row.
  test("creates the label in the workspace with the trimmed name, attaches it to the story, and logs one label_added row", async () => {
    const s = await story();

    const labelId = await s.createOnIssue("  Needs review  ");

    const labels = await s.asMember.query(api.labels.list, {});
    const feed = await s.asMember.query(api.activity.listByIssue, { issueId: s.issueId });
    expect(labels.map(({ _id, name, color }) => ({ _id, name, color }))).toEqual([
      { _id: labelId, name: "Needs review", color: "#ff8800" },
    ]);
    expect(await s.listed()).toEqual([labelId]);
    expect(feed.map(({ type, field, newValue }) => ({ type, field, newValue }))).toEqual([
      { type: "label_added", field: "label", newValue: "Needs review" },
    ]);
  });

  // Catches a cap checked only in the browser: the 21st label would be created and linked on the server.
  test(`at ${MAX_LABELS_PER_ISSUE} labels it is refused with a typed refusal, and no label, link or activity row is written`, async () => {
    const s = await storyAtLimit();
    const before = await footprint(s.t, s.issueId);

    const refused = await s.createOnIssue("One too many").catch(refusalOf);

    expect(await s.listed()).toEqual(s.labelIds.slice(0, MAX_LABELS_PER_ISSUE));
    expect(await s.workspaceLabels()).toEqual(s.labelIds);
    expect(await footprint(s.t, s.issueId)).toEqual(before);
    expect(refused).toEqual({ code: "rule_refused", message: TOO_MANY_LABELS });
  });

  // Catches a nameless label: an empty or blank name would create a label nobody can read or find.
  test.each(["", " \t  "])("the name %j is refused as a validation error, and nothing is written", async (name) => {
    const s = await story();
    const before = await footprint(s.t, s.issueId);

    const refused = await s.createOnIssue(name).catch(refusalOf);

    expect(refused).toEqual({ code: "validation", message: "A label needs a name" });
    expect(await s.workspaceLabels()).toEqual([]);
    expect(await s.listed()).toEqual([]);
    expect(await footprint(s.t, s.issueId)).toEqual(before);
  });
});
