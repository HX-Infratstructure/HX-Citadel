import { errorLine } from "../../cli/commands";
import type { Infer } from "convex/values";
import { AGENT_HEADER, RULE_REFUSED } from "../../convex/lib/httpApi";
import type { ReusedData } from "../../convex/lib/idempotency";
import type { StaleData } from "../../convex/lib/issueVersion";
import type { issuePriorityValidator, issueStatusValidator } from "../../convex/schema";
import { type ApiBody, CitadelApi, CitadelApiError, issuePath } from "../../lib/citadel-api";
import { MCP_TOOL_NAMES } from "../../lib/mcp/tools";

/** The checker's own agent, so the WIP state it creates and clears is its own. */
export const AGENT = "live-check";
const BACKLOG: Infer<typeof issueStatusValidator> = "backlog";
const IN_PROGRESS: Infer<typeof issueStatusValidator> = "in_progress";
const DONE: Infer<typeof issueStatusValidator> = "done";
const CANCELED: Infer<typeof issueStatusValidator> = "canceled";
const LOW: Infer<typeof issuePriorityValidator> = "low";
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

function idempotencyKey(check: LiveCheck, step: string): string {
  return `live-check-${check.runId}-${step}`;
}

function firstStory(check: LiveCheck): Story {
  if (!check.first) {
    throw new Error("no story: agent-create did not pass");
  }
  return check.first;
}

function story(check: LiveCheck, body: ApiBody): Story {
  const issue = body.issue as { key?: unknown } | undefined;
  const key = typeof issue?.key === "string" ? issue.key : "";
  expect(key !== "", `no issue key in ${JSON.stringify(body)}`);
  if (!check.created.includes(key)) {
    check.created.push(key);
  }
  return { key, version: Number(body.version) };
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
  const issue = body.issue as { key?: unknown } | undefined;
  if (typeof issue?.key === "string") {
    story(check, body);
  }
  throw new Error(`expected ${code}, got success ${JSON.stringify(body)}`);
}

async function appStatus(check: LiveCheck, path: string): Promise<number> {
  const response = await fetch(new URL(path, check.appUrl).toString(), { method: "GET" });
  await response.body?.cancel();
  return response.status;
}

/** One JSON-RPC call to `<app>/mcp`; a streamed answer is read from its `data:` line. */
async function mcp(check: LiveCheck, id: number, method: string, params: ApiBody): Promise<ApiBody> {
  const response = await fetch(new URL("/mcp", check.appUrl).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", [AGENT_HEADER]: AGENT },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  expect(response.status === 200, `${method} answered ${response.status}`);
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  const message = JSON.parse(data ? data.slice("data:".length) : text) as { result?: ApiBody };
  return message.result ?? {};
}

const createBody = (check: LiveCheck, title: string): ApiBody => ({ teamKey: check.team, title, status: BACKLOG });

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
      const options = { idempotencyKey: idempotencyKey(check, "create") };
      check.first = story(check, await check.api.write("POST", issuePath(), createBody(check, `Live check ${check.runId}`), options));
      return `${check.first.key} v${check.first.version}`;
    },
  },
  {
    name: "replay",
    run: async (check) => {
      const first = firstStory(check);
      const options = { idempotencyKey: idempotencyKey(check, "create") };
      const replayed = story(check, await check.api.write("POST", issuePath(), createBody(check, `Live check ${check.runId}`), options));
      expect(replayed.key === first.key && replayed.version === first.version, `replay gave ${replayed.key} v${replayed.version}`);
      return `${replayed.key} v${replayed.version}, no new story`;
    },
  },
  {
    name: "key-reuse",
    run: async (check) => {
      const options = { idempotencyKey: idempotencyKey(check, "create") };
      return refusal(check, () => check.api.write("POST", issuePath(), createBody(check, `Live check ${check.runId} other`), options), REUSED);
    },
  },
  {
    name: "stale-if-match",
    run: async (check) => {
      const first = firstStory(check);
      const options = { idempotencyKey: idempotencyKey(check, "stale"), ifMatch: first.version + 1 };
      return refusal(check, () => check.api.write("PATCH", issuePath(first.key), { priority: LOW }, options), STALE);
    },
  },
  {
    name: "wip-refusal",
    run: async (check) => {
      const first = firstStory(check);
      const moved = { status: IN_PROGRESS, assignee: AGENT };
      check.first = story(check, await check.api.write("PATCH", issuePath(first.key), moved, { idempotencyKey: idempotencyKey(check, "start") }));
      const second = { ...createBody(check, `Live check ${check.runId} second`), ...moved };
      const message = await refusal(check, () => check.api.write("POST", issuePath(), second, { idempotencyKey: idempotencyKey(check, "second") }), RULE_REFUSED);
      expect(message.includes(first.key), `the refusal does not name ${first.key}: ${message}`);
      return message;
    },
  },
  {
    name: "done-gate",
    run: async (check) => {
      const first = firstStory(check);
      const options = { idempotencyKey: idempotencyKey(check, "done") };
      const message = await refusal(check, () => check.api.write("PATCH", issuePath(first.key), { status: DONE }, options), RULE_REFUSED);
      expect(message.startsWith(`Can't move ${first.key}`), `unexpected Done-gate message: ${message}`);
      return message;
    },
  },
  {
    name: "tidy-up",
    run: async (check) => {
      const failed: string[] = [];
      for (const key of check.created) {
        await check.api
          .write("PATCH", issuePath(key), { status: CANCELED }, { idempotencyKey: idempotencyKey(check, `cancel-${key}`) })
          .catch((error: unknown) => failed.push(`${key}: ${errorLine(error)}`));
      }
      expect(failed.length === 0, `could not cancel ${failed.join("; ")}`);
      return `canceled ${check.created.join(", ") || "nothing"}`;
    },
  },
];
