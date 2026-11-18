import { errorLine } from "../../cli/commands";
import type { Infer } from "convex/values";
import { AGENT_HEADER } from "../../convex/lib/httpApi";
import { RULE_REFUSED } from "../../convex/lib/refusals";
import type { ReusedData } from "../../convex/lib/idempotency";
import type { StaleData } from "../../convex/lib/issueVersion";
import type { issuePriorityValidator, issueStatusValidator } from "../../convex/schema";
import { type ApiBody, CitadelApi, CitadelApiError, issuePath, type WriteOptions } from "../../lib/citadel-api";
import { MCP_TOOL_NAMES } from "../../lib/mcp/tools";

/** The checker's own agent, so the WIP state it creates and clears is its own. */
export const AGENT = "live-check";
/** How long each request may wait for its answer before the step fails. */
export const LIVE_CHECK_DEADLINE_MS = 15_000;
const BACKLOG: Infer<typeof issueStatusValidator> = "backlog";
const IN_PROGRESS: Infer<typeof issueStatusValidator> = "in_progress";
const DONE: Infer<typeof issueStatusValidator> = "done";
const CANCELED: Infer<typeof issueStatusValidator> = "canceled";
const LOW: Infer<typeof issuePriorityValidator> = "low";
const HIGH: Infer<typeof issuePriorityValidator> = "high";
const REUSED: ReusedData["code"] = "idempotency_key_reused";
const STALE: StaleData["code"] = "stale";

export type CheckStep<C> = { name: string; run: (context: C) => Promise<string> };

/** Runs every step in order, one `PASS|FAIL <name> <detail>` line each; a FAIL does not stop the rest. */
export async function runSteps<C>(steps: CheckStep<C>[], context: C, out: (line: string) => void): Promise<boolean> {
  let passed = true;
  for (const step of steps) {
    try {
      out(`PASS ${step.name} ${await step.run(context)}`);
    } catch (error) {
      passed = false;
      out(`FAIL ${step.name} ${errorLine(error)}`);
    }
  }
  return passed;
}

type Story = { key: string; version: number };

export type LiveCheck = {
  api: CitadelApi;
  appUrl: string;
  team: string;
  runId: string;
  /** Every story this run created, cancelled by the tidy-up. */
  created: string[];
  first?: Story;
};

function expect(condition: boolean, failure: string): void {
  if (!condition) {
    throw new Error(failure);
  }
}

/** A fresh deadline per request, so no call inherits one that already fired. */
const deadline = (): AbortSignal => AbortSignal.timeout(LIVE_CHECK_DEADLINE_MS);

/** A write's options: this run's Idempotency-Key for `step`, and its own deadline. */
function writeOptions(check: LiveCheck, step: string, ifMatch?: number): WriteOptions {
  return { idempotencyKey: `live-check-${check.runId}-${step}`, ifMatch, signal: deadline() };
}

function firstStory(check: LiveCheck): Story {
  if (!check.first) {
    throw new Error("no story: agent-create did not pass");
  }
  return check.first;
}

/** Adds the story a write answered with, if any, to the tidy-up's list, and returns its key or "". */
function keep(check: LiveCheck, body: ApiBody): string {
  const issue = body.issue as { key?: unknown } | undefined;
  const key = typeof issue?.key === "string" ? issue.key : "";
  if (key !== "" && !check.created.includes(key)) {
    check.created.push(key);
  }
  return key;
}

function story(check: LiveCheck, body: ApiBody): Story {
  const key = keep(check, body);
  expect(key !== "", `no issue key in ${JSON.stringify(body)}`);
  return { key, version: Number(body.version) };
}

/** No answer, or a 5xx without a `{code, message}` body: the write may still have been committed. */
function answerLost(error: unknown): boolean {
  return !(error instanceof CitadelApiError) || error.code === "server_error";
}

/**
 * POSTs a story. When the answer is lost, it POSTs once more with the same body and key, so a committed story
 * replays and the tidy-up learns its key; the first error still fails the step.
 */
async function create(check: LiveCheck, body: ApiBody, step: string): Promise<ApiBody> {
  const write = () => check.api.write("POST", issuePath(), body, writeOptions(check, step));
  try {
    return await write();
  } catch (error) {
    if (answerLost(error)) {
      keep(check, await write().catch(() => ({})));
    }
    throw error;
  }
}

/** Runs a write that must be refused with `code`, and returns the refusal's message. */
async function refusal(check: LiveCheck, write: () => Promise<ApiBody>, code: string): Promise<string> {
  let body: ApiBody;
  try {
    body = await write();
  } catch (error) {
    expect(error instanceof CitadelApiError && error.code === code, `expected ${code}, got ${errorLine(error)}`);
    return (error as CitadelApiError).message;
  }
  keep(check, body);
  throw new Error(`expected ${code}, got success ${JSON.stringify(body)}`);
}

async function appStatus(check: LiveCheck, path: string): Promise<number> {
  const response = await fetch(new URL(path, check.appUrl).toString(), { method: "GET", signal: deadline() });
  await response.body?.cancel();
  return response.status;
}

/** One JSON-RPC call to `<app>/mcp`; a streamed answer is read from its `data:` line. */
async function mcp(check: LiveCheck, id: number, method: string, params: ApiBody): Promise<ApiBody> {
  const response = await fetch(new URL("/mcp", check.appUrl).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", [AGENT_HEADER]: AGENT },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: deadline(),
  });
  const text = await response.text();
  expect(response.status === 200, `${method} answered ${response.status}`);
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  const message = JSON.parse(data ? data.slice("data:".length) : text) as { result?: ApiBody };
  return message.result ?? {};
}

const createBody = (check: LiveCheck, title: string): ApiBody => ({ teamKey: check.team, title, status: BACKLOG });

/** The keys of a story's Complete testing sub-tasks, read from the story's record. */
async function testingSubtasks(check: LiveCheck, key: string): Promise<string[]> {
  const { subtasks } = await check.api.get(issuePath(key), {}, deadline());
  const records = Array.isArray(subtasks) ? (subtasks as { key?: unknown; testing?: unknown }[]) : [];
  return records.flatMap((record) => (record.testing === true && typeof record.key === "string" ? [record.key] : []));
}

export const STEPS: CheckStep<LiveCheck>[] = [
  {
    name: "app",
    run: async (check) => {
      const signIn = await appStatus(check, "/sign-in");
      const mcpGet = await appStatus(check, "/mcp");
      expect(signIn === 200 && mcpGet === 405, `GET /sign-in ${signIn} (want 200), GET /mcp ${mcpGet} (want 405)`);
      return "GET /sign-in 200, GET /mcp 405";
    },
  },
  {
    name: "mcp",
    run: async (check) => {
      const init = await mcp(check, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: AGENT, version: "1" } });
      expect(init.serverInfo !== undefined, "initialize has no serverInfo");
      const tools = (await mcp(check, 2, "tools/list", {})).tools;
      const names = new Set(Array.isArray(tools) ? tools.map((tool: { name?: unknown }) => tool.name) : []);
      const want = new Set(MCP_TOOL_NAMES);
      const same = names.size === want.size && [...want].every((name) => names.has(name));
      expect(same, `tools/list gave ${[...names].join(", ")} (want ${MCP_TOOL_NAMES.join(", ")})`);
      return `initialize serverInfo, tools ${MCP_TOOL_NAMES.join(", ")}`;
    },
  },
  {
    name: "agent-create",
    run: async (check) => {
      check.first = story(check, await create(check, createBody(check, `Live check ${check.runId}`), "create"));
      return `${check.first.key} v${check.first.version}`;
    },
  },
  {
    name: "replay",
    run: async (check) => {
      const first = firstStory(check);
      const replayed = story(check, await create(check, createBody(check, `Live check ${check.runId}`), "create"));
      expect(replayed.key === first.key && replayed.version === first.version, `replay gave ${replayed.key} v${replayed.version}`);
      return `${replayed.key} v${replayed.version}, no new story`;
    },
  },
  {
    name: "key-reuse",
    run: async (check) => {
      return refusal(check, () => create(check, createBody(check, `Live check ${check.runId} other`), "create"), REUSED);
    },
  },
  {
    name: "stale-if-match",
    run: async (check) => {
      const first = firstStory(check);
      const advance = writeOptions(check, "advance", first.version);
      check.first = story(check, await check.api.write("PATCH", issuePath(first.key), { priority: LOW }, advance));
      expect(check.first.version > first.version, `If-Match ${first.version} left ${first.key} at v${check.first.version}`);
      const stale = () => check.api.write("PATCH", issuePath(first.key), { priority: HIGH }, writeOptions(check, "stale", first.version));
      return refusal(check, stale, STALE);
    },
  },
  {
    name: "wip-refusal",
    run: async (check) => {
      const first = firstStory(check);
      const moved = { status: IN_PROGRESS, assignee: AGENT };
      check.first = story(check, await check.api.write("PATCH", issuePath(first.key), moved, writeOptions(check, "start")));
      const second = { ...createBody(check, `Live check ${check.runId} second`), ...moved };
      const message = await refusal(check, () => create(check, second, "second"), RULE_REFUSED);
      expect(message.includes(first.key), `the refusal does not name ${first.key}: ${message}`);
      return message;
    },
  },
  {
    name: "done-gate",
    run: async (check) => {
      const first = firstStory(check);
      const done = () => check.api.write("PATCH", issuePath(first.key), { status: DONE }, writeOptions(check, "done"));
      const message = await refusal(check, done, RULE_REFUSED);
      expect(message.startsWith(`Can't move ${first.key}`), `unexpected Done-gate message: ${message}`);
      return message;
    },
  },
  {
    name: "tidy-up",
    run: async (check) => {
      const failed: string[] = [];
      const canceled: string[] = [];
      for (const key of check.created) {
        const subtasks = await testingSubtasks(check, key).catch((error: unknown) => {
          failed.push(`${key} testing sub-task: ${errorLine(error)}`);
          return [];
        });
        for (const target of [...subtasks, key]) {
          canceled.push(target);
          await check.api
            .write("PATCH", issuePath(target), { status: CANCELED }, writeOptions(check, `cancel-${target}`))
            .catch((error: unknown) => failed.push(`${target}: ${errorLine(error)}`));
        }
      }
      expect(failed.length === 0, `could not cancel ${failed.join("; ")}`);
      return `canceled ${canceled.join(", ") || "nothing"}`;
    },
  },
];
