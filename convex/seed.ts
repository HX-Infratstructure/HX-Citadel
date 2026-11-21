import { v } from "convex/values";
import { refuse } from "./lib/refusals";
import { formatIssueKey } from "../lib/issue-key";
import { isGatedStatus } from "../lib/issue-status";
import { DAY_MS, SPRINT_DAYS, sprintEnd } from "../lib/sprint";
import { Doc, Id } from "./_generated/dataModel";
import { logActivity } from "./lib/activity";
import { patchIssue } from "./lib/issueVersion";
import { internalMutation } from "./_generated/server";
import { storyType } from "./lib/issues/create";
import { getMembershipOrThrow, getOrgByClerkIdOrThrow, getUserByClerkIdOrThrow } from "./lib/mirror";
import { claimStoryNumber, FIRST_ISSUE_NUMBER, nextSubNumber } from "./lib/rules/numbering";
import { createTestingSubtask } from "./lib/rules/testing";

/**
 * Dev-only demo workspace, run with `pnpm seed:demo` (never from the UI,
 * a build or a deploy). Populates teams, labels, projects, cycles and a few
 * dozen issues (epics, features, stories and their sub-tasks, relations,
 * comments and activity) so an empty development org shows the app in full
 * flight. The rows follow the phase 2 rules the mutations enforce.
 */

type IssueStatus = Doc<"issues">["status"];
type IssuePriority = Doc<"issues">["priority"];

type SubtaskSpec = { title: string; status: IssueStatus };

type IssueSpec = {
  /** Omitted for a story. */
  kind?: "epic" | "feature";
  /** A story's type when it is not a plain story. */
  type?: "bug" | "chore";
  title: string;
  description?: string;
  status: IssueStatus;
  priority: IssuePriority;
  estimate?: number;
  /** Due date relative to now; negative = overdue. */
  dueInDays?: number;
  /** Assign to the seeding user. */
  assign?: boolean;
  /** Index into PROJECTS; a child inherits its parent's. */
  project?: number;
  cycle?: "prev" | "current" | "next";
  labels?: string[];
  /** Features under an epic, stories under a feature. */
  children?: IssueSpec[];
  /** A story's sub-tasks besides its Complete testing sub-task. */
  subtasks?: SubtaskSpec[];
};

const LABELS: { name: string; color: string }[] = [
  { name: "Bug", color: "#eb5757" },
  { name: "Feature", color: "#5e6ad2" },
  { name: "Polish", color: "#4cb782" },
  { name: "Performance", color: "#f2994a" },
  { name: "Security", color: "#c970ff" },
  { name: "Infra", color: "#95a2b3" },
  { name: "Design system", color: "#26b5ce" },
  { name: "Accessibility", color: "#4ea7fc" },
];

const PROJECTS: {
  name: string;
  description: string;
  status: Doc<"projects">["status"];
  targetInDays: number;
  color: string;
}[] = [
  {
    name: "Mobile & board experience",
    description:
      "Make the board first-class on every screen size: touch drag-and-drop, responsive columns and a mobile-friendly issue list.",
    status: "in_progress",
    targetInDays: 45,
    color: "#5e6ad2",
  },
  {
    name: "Launch readiness",
    description:
      "Everything standing between us and the public launch: security hardening, marketing assets and the day-one checklist.",
    status: "in_progress",
    targetInDays: 30,
    color: "#f2994a",
  },
];

const TEAMS: { name: string; key: string; description: string; cycles: ("prev" | "current" | "next")[]; issues: IssueSpec[] }[] = [
  {
    name: "Engineering",
    key: "ENG",
    description: "Product engineering — app, API and infrastructure.",
    cycles: ["prev", "current", "next"],
    issues: [
      {
        kind: "epic",
        title: "Board on every screen",
        status: "in_progress",
        priority: "high",
        project: 0,
        children: [
          {
            kind: "feature",
            title: "Touch-first board",
            status: "in_progress",
            priority: "high",
            children: [
              {
                title: "Mobile responsive board view",
                description: "The board is unusable below 768px. Columns should scroll horizontally with snap points and support touch drag.",
                status: "in_progress",
                priority: "high",
                estimate: 8,
                assign: true,
                cycle: "current",
                labels: ["Feature"],
                subtasks: [
                  { title: "Touch drag-and-drop support", status: "in_progress" },
                  { title: "Collapsible column headers on small screens", status: "todo" },
                  { title: "Swipe between board columns", status: "backlog" },
                ],
              },
              { title: "Issue list virtualization", description: "Render only visible rows so 5k-issue workspaces stay at 60fps.", status: "in_review", priority: "high", estimate: 5, assign: true, cycle: "current", labels: ["Performance"], subtasks: [{ title: "Windowed row renderer", status: "done" }] },
            ],
          },
          {
            kind: "feature",
            title: "Fast issue list",
            status: "done",
            priority: "urgent",
            children: [
              { title: "Fix N+1 queries on issue list", description: "The list view fires one query per row for labels. Batch them with a single indexed query.", status: "done", priority: "urgent", estimate: 2, assign: true, cycle: "prev", labels: ["Performance", "Bug"] },
            ],
          },
        ],
      },
      {
        kind: "epic",
        title: "Launch hardening",
        status: "in_progress",
        priority: "urgent",
        project: 1,
        children: [
          {
            kind: "feature",
            title: "Session security",
            status: "in_progress",
            priority: "urgent",
            children: [
              { title: "Migrate auth tokens to httpOnly cookies", description: "Move session tokens out of localStorage ahead of the security review.", status: "in_progress", priority: "urgent", estimate: 3, cycle: "current", dueInDays: 5, labels: ["Security"] },
              { title: "Rate-limit public API endpoints", status: "todo", priority: "high", estimate: 2, cycle: "next", labels: ["Security"] },
            ],
          },
        ],
      },
      { title: "Set up CI pipeline with preview deploys", type: "chore", status: "done", priority: "high", estimate: 3, assign: true, cycle: "prev", labels: ["Infra"] },
      { title: "Webhook retries drop events on 5xx", type: "bug", description: "Failed webhook deliveries were ACKed instead of retried, silently losing events. Make handlers fail loudly so the queue retries.", status: "done", priority: "urgent", estimate: 2, assign: true, cycle: "prev", labels: ["Bug"] },
      { title: "Realtime presence indicators flicker on reconnect", status: "todo", priority: "medium", estimate: 2, assign: true, cycle: "current", labels: ["Bug"] },
      { title: "Dark mode flash on first paint", type: "bug", status: "in_review", priority: "medium", estimate: 1, cycle: "current", labels: ["Bug", "Polish"] },
      { title: "Flaky e2e: drag-and-drop board test", status: "todo", priority: "medium", estimate: 1, assign: true, cycle: "current", labels: ["Bug", "Infra"] },
      { title: "Add keyboard shortcut cheat sheet (?)", status: "todo", priority: "low", estimate: 1, cycle: "current", labels: ["Polish"] },
      { title: "Reduce cold-start time of dashboard", status: "todo", priority: "high", estimate: 3, cycle: "next", dueInDays: 14, labels: ["Performance"] },
      { title: "Public launch checklist", description: "Track every launch-blocking item: status page, error budgets, on-call rotation, rollback plan.", status: "todo", priority: "urgent", estimate: 2, assign: true, project: 1, dueInDays: 10 },
      { title: "Audit log for admin actions", status: "backlog", priority: "medium", estimate: 3, project: 1, labels: ["Security", "Feature"] },
      { title: "Slack integration for issue notifications", status: "backlog", priority: "medium", estimate: 5, project: 0, labels: ["Feature"] },
      { title: "Bulk edit issues from list view", status: "backlog", priority: "medium", estimate: 3, labels: ["Feature"] },
      { title: "Export workspace data as CSV", status: "backlog", priority: "low", estimate: 2, labels: ["Feature"] },
      { title: "Upgrade to React 19.3", type: "chore", status: "canceled", priority: "low", labels: ["Infra"] },
    ],
  },
  {
    name: "Design",
    key: "DSN",
    description: "Product and brand design.",
    cycles: ["current"],
    issues: [
      { title: "Design system: dark mode color audit", status: "done", priority: "high", estimate: 3, assign: true, cycle: "current", labels: ["Design system"] },
      { title: "Issue detail spacing & typography pass", status: "done", priority: "medium", estimate: 1, assign: true, cycle: "current", labels: ["Polish"] },
      { title: "Mobile board interaction spec", status: "done", priority: "high", estimate: 2, assign: true, project: 0 },
      { title: "Empty states for projects & cycles", status: "todo", priority: "medium", estimate: 2, assign: true, cycle: "current", labels: ["Polish"] },
      { title: "Onboarding flow redesign", description: "Collapse org + team creation into a single screen with sensible defaults.", status: "in_review", priority: "high", estimate: 5, assign: true, project: 0, labels: ["Feature"] },
      { title: "Marketing site hero illustration", status: "in_progress", priority: "medium", estimate: 3, project: 1 },
      { title: "Pricing page comparison table polish", status: "todo", priority: "medium", estimate: 2, cycle: "current", project: 1, dueInDays: -1, labels: ["Polish"] },
      { title: "Command palette result grouping", status: "todo", priority: "medium", estimate: 2, labels: ["Polish"] },
      { title: "Accessibility audit: keyboard traps", status: "todo", priority: "high", estimate: 3, dueInDays: 21, labels: ["Accessibility"] },
      { title: "Icon set consolidation (lucide only)", status: "todo", priority: "low", estimate: 1, labels: ["Design system"] },
      { title: "Customizable avatar colors", status: "backlog", priority: "low", estimate: 2, labels: ["Feature"] },
      { title: "Notification preferences UI", status: "backlog", priority: "medium", estimate: 3, labels: ["Feature"] },
    ],
  },
  {
    name: "Marketing",
    key: "MKT",
    description: "Growth, content and launch.",
    cycles: [],
    issues: [
      { title: "Newsletter #12: cycles deep dive", status: "done", priority: "medium", estimate: 1, assign: true },
      { title: "Launch blog post draft", status: "todo", priority: "high", estimate: 2, assign: true, project: 1, dueInDays: 9 },
      { title: "Founding-customer outreach list", status: "in_progress", priority: "medium", estimate: 2 },
      { title: "Pricing FAQ copy", status: "in_review", priority: "medium", estimate: 1, project: 1 },
      { title: "Product Hunt launch assets", status: "todo", priority: "urgent", estimate: 3, project: 1, dueInDays: 8 },
      { title: "Twitter/X launch thread", status: "todo", priority: "high", estimate: 1, project: 1, dueInDays: 10 },
      { title: "SEO: docs landing pages", status: "todo", priority: "medium", estimate: 2 },
      { title: "Update screenshots after dark-mode audit", status: "todo", priority: "low", estimate: 1, labels: ["Polish"] },
      { title: "Customer case study: Acme Inc", status: "backlog", priority: "medium", estimate: 3 },
      { title: "Analytics events for signup funnel", status: "backlog", priority: "high", estimate: 2, labels: ["Feature"] },
    ],
  },
];

const COMMENTS: { issue: string; body: string; mention?: boolean }[] = [
  { issue: "Issue list virtualization", body: "Windowing plays nicely with the drag overlay after the sensor fix — ready for review." },
  { issue: "Issue list virtualization", body: "Profiled on a 5k-issue workspace: scroll holds 60fps. 🎉" },
  { issue: "Migrate auth tokens to httpOnly cookies", body: "Flagging the cookie domain config for staging — needs your sign-off before we ship.", mention: true },
  { issue: "Onboarding flow redesign", body: "Latest mock is linked in the description — team creation is now a single screen." },
  { issue: "Product Hunt launch assets", body: "Waiting on the final logo lockup from design before cutting the gallery images." },
];

const RELATIONS: { from: string; to: string; type: Doc<"issueRelations">["type"] }[] = [
  { from: "Fix N+1 queries on issue list", to: "Issue list virtualization", type: "related" },
  { from: "Migrate auth tokens to httpOnly cookies", to: "Public launch checklist", type: "blocks" },
];

export const demoData = internalMutation({
  args: { clerkOrgId: v.string(), clerkUserId: v.string() },
  returns: v.object({
    teams: v.number(),
    labels: v.number(),
    projects: v.number(),
    cycles: v.number(),
    issues: v.number(),
    comments: v.number(),
  }),
  handler: async (ctx, { clerkOrgId, clerkUserId }) => {
    const org = await getOrgByClerkIdOrThrow(
      ctx,
      clerkOrgId,
      `Organization ${clerkOrgId} is not synced to Convex.`
    );
    const user = await getUserByClerkIdOrThrow(
      ctx,
      clerkUserId,
      `User ${clerkUserId} is not synced to Convex.`
    );
    await getMembershipOrThrow(
      ctx,
      org._id,
      user._id,
      `User ${clerkUserId} is not a member of organization ${clerkOrgId}.`
    );

    const existingTeams = await ctx.db
      .query("teams")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    if (existingTeams.length > 0) {
      refuse("This workspace already has teams — demo data can only seed an empty workspace.");
    }

    const now = Date.now();
    const orgId = org._id;
    const userId = user._id;

    const labelIds = new Map<string, Id<"labels">>();
    for (const label of LABELS) {
      labelIds.set(label.name, await ctx.db.insert("labels", { orgId, ...label }));
    }

    const projectIds: Id<"projects">[] = [];
    for (const project of PROJECTS) {
      projectIds.push(
        await ctx.db.insert("projects", {
          orgId,
          name: project.name,
          description: project.description,
          status: project.status,
          leadId: userId,
          targetDate: now + project.targetInDays * DAY_MS,
          color: project.color,
        })
      );
    }

    // Sprints relative to today so "current" is always live.
    const sprintFrom = (startDate: number) => ({ startDate, endDate: sprintEnd(startDate) });
    const currentStart = now - Math.floor(SPRINT_DAYS / 2) * DAY_MS;
    const cycleWindows = {
      prev: sprintFrom(currentStart - SPRINT_DAYS * DAY_MS),
      current: sprintFrom(currentStart),
      next: sprintFrom(currentStart + SPRINT_DAYS * DAY_MS),
    } as const;

    let cycleCount = 0;
    let issueCount = 0;
    const issuesByTitle = new Map<string, Doc<"issues">>();

    for (const team of TEAMS) {
      const teamId = await ctx.db.insert("teams", {
        orgId,
        name: team.name,
        key: team.key,
        description: team.description,
        nextIssueNumber: FIRST_ISSUE_NUMBER,
      });

      const cycleIds = new Map<"prev" | "current" | "next", Id<"cycles">>();
      for (let i = 0; i < team.cycles.length; i++) {
        const phase = team.cycles[i];
        cycleIds.set(
          phase,
          await ctx.db.insert("cycles", {
            orgId,
            teamId,
            number: i + 1,
            ...cycleWindows[phase],
          })
        );
        cycleCount++;
      }

      let position = 0;

      const logSeededState = async (issueId: Id<"issues">, status: IssueStatus, assign?: boolean) => {
        await logActivity(ctx, { orgId, issueId, actorId: userId, type: "created" });
        if (status !== "backlog" && status !== "todo") {
          await logActivity(ctx, {
            orgId,
            issueId,
            actorId: userId,
            type: "status_changed",
            field: "status",
            oldValue: "todo",
            newValue: status,
          });
        }
        if (assign) {
          await logActivity(ctx, {
            orgId,
            issueId,
            actorId: userId,
            type: "assignee_changed",
            field: "assignee",
            newValue: user.name,
          });
        }
      };

      /** A gated story's testing sub-task is done with a proof link, so the story passes the Done gate. */
      const insertSubtasks = async (story: Doc<"issues">, subtasks: SubtaskSpec[]) => {
        const testingId = await createTestingSubtask(ctx, story);
        issueCount++;
        if (isGatedStatus(story.status)) {
          const proofUrl = `https://example.com/proof/${formatIssueKey(team.key, story)}`;
          await patchIssue(ctx, testingId, { status: "done", proofUrl });
        }
        for (const subtask of subtasks) {
          const subtaskId = await ctx.db.insert("issues", {
            orgId,
            teamId,
            kind: "subtask",
            subNumber: await nextSubNumber(ctx, orgId, story._id),
            title: subtask.title,
            status: subtask.status,
            priority: "none",
            assigneeId: story.assigneeId,
            creatorId: userId,
            projectId: story.projectId,
            parentIssueId: story._id,
            sortOrder: story.sortOrder,
          });
          issueCount++;
          await logSeededState(subtaskId, subtask.status);
        }
      };

      const insertIssue = async (spec: IssueSpec, parent?: Doc<"issues">): Promise<void> => {
        const kind = spec.kind ?? "story";
        const numbering = kind === "story" ? await claimStoryNumber(ctx, orgId, teamId) : {};
        const ownProject = spec.project === undefined ? undefined : projectIds[spec.project];
        position++;
        const issueId = await ctx.db.insert("issues", {
          orgId,
          teamId,
          kind,
          type: storyType(kind, spec.type),
          ...numbering,
          title: spec.title,
          description: spec.description,
          status: spec.status,
          priority: spec.priority,
          assigneeId: spec.assign ? userId : undefined,
          creatorId: userId,
          projectId: parent ? parent.projectId : ownProject,
          cycleId: spec.cycle ? cycleIds.get(spec.cycle) : undefined,
          parentIssueId: parent?._id,
          estimate: spec.estimate,
          dueDate: spec.dueInDays !== undefined ? now + spec.dueInDays * DAY_MS : undefined,
          sortOrder: position * 1024,
        });
        issueCount++;

        for (const labelName of spec.labels ?? []) {
          const labelId = labelIds.get(labelName);
          if (labelId) {
            await ctx.db.insert("issueLabels", { issueId, labelId });
          }
        }
        await logSeededState(issueId, spec.status, spec.assign);

        const doc = (await ctx.db.get(issueId))!;
        issuesByTitle.set(spec.title, doc);
        for (const child of spec.children ?? []) {
          await insertIssue(child, doc);
        }
        if (kind === "story") {
          await insertSubtasks(doc, spec.subtasks ?? []);
        }
      };

      for (const spec of team.issues) {
        await insertIssue(spec);
      }
    }

    let commentCount = 0;
    for (const comment of COMMENTS) {
      const issue = issuesByTitle.get(comment.issue);
      if (!issue) {
        continue;
      }
      const body = comment.mention ? `@${user.name} ${comment.body}` : comment.body;
      await ctx.db.insert("comments", {
        orgId,
        issueId: issue._id,
        authorId: userId,
        body,
        mentions: comment.mention ? [userId] : undefined,
      });
      await logActivity(ctx, { orgId, issueId: issue._id, actorId: userId, type: "commented" });
      commentCount++;
    }

    for (const relation of RELATIONS) {
      const from = issuesByTitle.get(relation.from);
      const to = issuesByTitle.get(relation.to);
      if (from && to) {
        await ctx.db.insert("issueRelations", {
          issueId: from._id,
          relatedIssueId: to._id,
          type: relation.type,
        });
      }
    }

    return {
      teams: TEAMS.length,
      labels: LABELS.length,
      projects: PROJECTS.length,
      cycles: cycleCount,
      issues: issueCount,
      comments: commentCount,
    };
  },
});
