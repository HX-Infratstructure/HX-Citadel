// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES } from "../cli/commands";
import { MCP_TOOL_NAMES } from "../lib/mcp/tools";
import { main } from "./live-check";
import { type CheckStep, LIVE_CHECK_DEADLINE_MS, runSteps } from "./live-check/steps";

const ENV = { HX_CITADEL_API: "http://convex.test:3211", HX_CITADEL_APP: "http://app.test:8460" };

type Reply = { status: number; body?: unknown; etag?: string; text?: string };

const ok = (body: unknown, etag?: string): Reply => ({ status: 200, body, etag });
const refused = (status: number, code: string, message: string): Reply => ({ status, body: { code, message } });
const story = (key: string, version: number): Reply => ({ status: 201, body: { issue: { key, version } }, etag: `"${version}"` });
const LOST = new TypeError("fetch failed");
/** The tidy-up's three answers for one story: its record with the Complete testing sub-task, then both cancels. */
const tidy = (key: string, version: number): Reply[] => [
  ok({ issue: { key, version }, subtasks: [{ key: `${key}.1`, version: 1, title: "Complete testing", testing: true }] }),
  story(`${key}.1`, 2),
  story(key, version),
];
const VALIDATOR_REFUSAL = refused(400, "validation", "ArgumentValidationError: Value does not match validator. Path: .title");

const HAPPY: Reply[] = [
  { status: 200, text: "<html>sign in</html>" },
  { status: 405, text: "" },
  ok({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "hx-citadel" } } }),
  ok({ jsonrpc: "2.0", id: 2, result: { tools: MCP_TOOL_NAMES.map((name) => ({ name })) } }),
  story("LCK-1", 1),
  story("LCK-1", 1),
  refused(409, "idempotency_key_reused", "That Idempotency-Key was used with another body"),
  story("LCK-1", 2),
  refused(412, "stale", "LCK-1 is at version 2"),
  story("LCK-1", 3),
  refused(409, "rule_refused", "live-check already has LCK-1 In Progress; finish it first"),
  refused(409, "rule_refused", "Can't move LCK-1 to Done: open — no proof link"),
  VALIDATOR_REFUSAL,
  ...tidy("LCK-1", 5),
];

function stubFetch(replies: (Reply | Error)[]) {
  const queue = [...replies];
  const fetchMock = vi.fn(async () => {
    const reply = queue.shift() ?? ok({});
    if (reply instanceof Error) {
      throw reply;
    }
    const { status, body, etag, text } = reply;
    const payload = text ?? JSON.stringify(body);
    return new Response(status === 405 ? null : payload, { status, headers: etag ? { ETag: etag } : {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function call(fetchMock: ReturnType<typeof stubFetch>, index: number) {
  const [url, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  return { url, method: init.method ?? "GET", headers: new Headers(init.headers), body };
}

async function check(argv: string[], env: Record<string, string | undefined> = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, env, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err: err.join("\n") };
}

describe("runSteps", () => {
  it("reports PASS and FAIL and carries on after a FAIL", async () => {
    const lines: string[] = [];
    const steps: CheckStep<null>[] = [
      { name: "one", run: async () => "fine" },
      {
        name: "two",
        run: async () => {
          throw new Error("broke");
        },
      },
      { name: "three", run: async () => "also fine" },
    ];
    const passed = await runSteps(steps, null, (line) => lines.push(line));
    expect(passed).toBe(false);
    expect(lines).toEqual(["PASS one fine", "FAIL two broke", "PASS three also fine"]);
  });
});

describe("live-check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes every step against canned answers and exits 0", async () => {
    stubFetch(HAPPY);
    const { code, out } = await check(["--team", "LCK"]);
    expect(out.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "PASS app",
      "PASS mcp",
      "PASS agent-create",
      "PASS replay",
      "PASS key-reuse",
      "PASS stale-if-match",
      "PASS wip-refusal",
      "PASS done-gate",
      "PASS validation",
      "PASS tidy-up",
    ]);
    expect(code).toBe(EXIT_CODES.ok.code);
  });

  it("sends each step's request as the brief names it", async () => {
    const fetchMock = stubFetch(HAPPY);
    await check(["--team", "LCK"]);
    expect(call(fetchMock, 0)).toMatchObject({ url: "http://app.test:8460/sign-in", method: "GET" });
    expect(call(fetchMock, 1)).toMatchObject({ url: "http://app.test:8460/mcp", method: "GET" });
    const initialize = call(fetchMock, 2);
    expect(initialize).toMatchObject({ url: "http://app.test:8460/mcp", method: "POST", body: { method: "initialize" } });
    expect(initialize.headers.get("X-Agent-Id")).toBe("live-check");
    expect(initialize.headers.get("Accept")).toBe("application/json, text/event-stream");
    expect(call(fetchMock, 3).body).toMatchObject({ method: "tools/list" });

    const create = call(fetchMock, 4);
    const replay = call(fetchMock, 5);
    const reuse = call(fetchMock, 6);
    expect(create).toMatchObject({ url: "http://convex.test:3211/api/v1/issues", method: "POST", body: { teamKey: "LCK" } });
    expect(create.headers.get("X-Agent-Id")).toBe("live-check");
    expect(create.headers.get("Idempotency-Key")).toMatch(/^live-check-.+-create$/);
    expect(replay.headers.get("Idempotency-Key")).toBe(create.headers.get("Idempotency-Key"));
    expect(replay.body).toEqual(create.body);
    expect(reuse.headers.get("Idempotency-Key")).toBe(create.headers.get("Idempotency-Key"));
    expect(reuse.body).not.toEqual(create.body);

    const advance = call(fetchMock, 7);
    const stale = call(fetchMock, 8);
    expect(advance).toMatchObject({ url: "http://convex.test:3211/api/v1/issues/LCK-1", method: "PATCH", body: { priority: "low" } });
    expect(advance.headers.get("If-Match")).toBe('"1"');
    expect(stale).toMatchObject({ url: "http://convex.test:3211/api/v1/issues/LCK-1", method: "PATCH" });
    expect(stale.headers.get("If-Match")).toBe('"1"');
    expect(stale.body).not.toEqual(advance.body);
    expect(stale.headers.get("Idempotency-Key")).not.toBe(advance.headers.get("Idempotency-Key"));

    expect(call(fetchMock, 9).body).toMatchObject({ status: "in_progress", assignee: "live-check" });
    expect(call(fetchMock, 10).body).toMatchObject({ teamKey: "LCK", status: "in_progress", assignee: "live-check" });
    expect(call(fetchMock, 11).body).toMatchObject({ status: "done" });
    const validation = call(fetchMock, 12);
    expect(validation).toMatchObject({ url: "http://convex.test:3211/api/v1/issues", method: "POST", body: { teamKey: "LCK", title: 5 } });
    expect(validation.headers.get("Idempotency-Key")).toMatch(/^live-check-.+-validation$/);
    expect(call(fetchMock, 13)).toMatchObject({ url: "http://convex.test:3211/api/v1/issues/LCK-1", method: "GET" });
    expect(call(fetchMock, 14)).toMatchObject({ url: "http://convex.test:3211/api/v1/issues/LCK-1.1", method: "PATCH", body: { status: "canceled" } });
    expect(call(fetchMock, 15)).toMatchObject({ url: "http://convex.test:3211/api/v1/issues/LCK-1", method: "PATCH", body: { status: "canceled" } });
  });

  it.each([
    ["app", 1, { status: 200, text: "" }],
    ["mcp", 3, ok({ jsonrpc: "2.0", id: 2, result: { tools: [] } })],
    ["mcp", 3, ok({ jsonrpc: "2.0", id: 2, result: { tools: [...MCP_TOOL_NAMES.slice(1), "other_tool"].map((name) => ({ name })) } })],
    ["agent-create", 4, refused(409, "rule_refused", "nope")],
    ["replay", 5, story("LCK-2", 2)],
    ["key-reuse", 6, story("LCK-1", 1)],
    ["stale-if-match", 7, story("LCK-1", 1)],
    ["stale-if-match", 8, story("LCK-1", 3)],
    ["wip-refusal", 10, refused(409, "rule_refused", "live-check already has LCK-9 In Progress; finish it first")],
    ["done-gate", 11, story("LCK-1", 4)],
    ["validation", 12, story("LCK-2", 1)],
    ["validation", 12, refused(409, "rule_refused", "live-check already has LCK-1 In Progress; finish it first")],
    ["validation", 12, refused(400, "actor_required", "The X-Agent-Id header names the acting agent and is required")],
    ["validation", 12, refused(500, "server_error", "Internal error")],
  ])("fails %s when its answer is wrong, and the rest still run", async (name, index, wrong) => {
    const replies = [...HAPPY];
    replies[index] = wrong;
    stubFetch(replies);
    const { code, out } = await check(["--team", "LCK"]);
    expect(out.filter((line) => line.startsWith("FAIL")).map((line) => line.split(" ")[1])).toContain(name);
    expect(out.at(-1)).toMatch(/^(PASS|FAIL) tidy-up/);
    expect(code).toBe(EXIT_CODES.refused.code);
  });

  it("tidies up even when an earlier step failed, cancelling every story it created", async () => {
    const replies = [...HAPPY];
    replies[10] = story("LCK-2", 1);
    replies.splice(13, 3, ...tidy("LCK-1", 5), ...tidy("LCK-2", 2));
    const fetchMock = stubFetch(replies);
    const { code, out } = await check(["--team", "LCK"]);
    expect(out).toContain(out.find((line) => line.startsWith("FAIL wip-refusal")));
    expect(out.at(-1)).toMatch(/^PASS tidy-up/);
    const cancels = fetchMock.mock.calls.map((_, index) => call(fetchMock, index)).filter((request) => request.body?.status === "canceled");
    expect(cancels.map((request) => request.url.split("/").at(-1))).toEqual(["LCK-1.1", "LCK-1", "LCK-2.1", "LCK-2"]);
    expect(code).toBe(EXIT_CODES.refused.code);
  });

  it("cancels the Complete testing sub-task that the story's record names, and no other sub-task", async () => {
    const record = ok({ issue: { key: "LCK-1", version: 4 }, subtasks: [{ key: "LCK-1.2", version: 1, testing: false }, { key: "LCK-1.3", version: 1, testing: true }] });
    const fetchMock = stubFetch([...HAPPY.slice(0, 13), record, story("LCK-1.3", 2), story("LCK-1", 5)]);
    const { out } = await check(["--team", "LCK"]);
    const cancels = fetchMock.mock.calls.map((_, index) => call(fetchMock, index)).filter((request) => request.body?.status === "canceled");
    expect(cancels.map((request) => request.url.split("/").at(-1))).toEqual(["LCK-1.3", "LCK-1"]);
    expect(out.at(-1)).toBe("PASS tidy-up canceled LCK-1.3, LCK-1");
  });

  it("still cancels the story when its record can't be read, and fails tidy-up naming it", async () => {
    const fetchMock = stubFetch([...HAPPY.slice(0, 13), refused(404, "not_found", "Issue LCK-1 not found"), story("LCK-1", 5)]);
    const { out } = await check(["--team", "LCK"]);
    expect(call(fetchMock, 14)).toMatchObject({ url: "http://convex.test:3211/api/v1/issues/LCK-1", body: { status: "canceled" } });
    expect(out.at(-1)).toMatch(/^FAIL tidy-up could not cancel LCK-1 testing sub-task: .*not found/);
  });

  it("asks once more with the same key when the create's answer is lost, and cancels the story it made", async () => {
    const replies = [...HAPPY.slice(0, 4), { status: 502, text: "" }, story("LCK-1", 1), HAPPY[6], VALIDATOR_REFUSAL, ...tidy("LCK-1", 2)];
    const fetchMock = stubFetch(replies);
    const { code, out } = await check(["--team", "LCK"]);
    expect(out[2]).toMatch(/^FAIL agent-create .*502/);
    const [create, retry] = [call(fetchMock, 4), call(fetchMock, 5)];
    expect(retry).toMatchObject({ url: create.url, method: "POST", body: create.body });
    expect(retry.headers.get("Idempotency-Key")).toBe(create.headers.get("Idempotency-Key"));
    expect(call(fetchMock, 10)).toMatchObject({ url: "http://convex.test:3211/api/v1/issues/LCK-1", body: { status: "canceled" } });
    expect(out.at(-1)).toBe("PASS tidy-up canceled LCK-1.1, LCK-1");
    expect(code).toBe(EXIT_CODES.refused.code);
  });

  it("recovers the key when a refusal step's create was made but its answer was lost", async () => {
    const replies = [...HAPPY.slice(0, 10), LOST, story("LCK-2", 1), HAPPY[11], VALIDATOR_REFUSAL, ...tidy("LCK-1", 5), ...tidy("LCK-2", 2)];
    const fetchMock = stubFetch(replies);
    const { out } = await check(["--team", "LCK"]);
    expect(out.find((line) => line.startsWith("FAIL wip-refusal"))).toContain("fetch failed");
    const [second, retry] = [call(fetchMock, 10), call(fetchMock, 11)];
    expect(retry).toMatchObject({ url: second.url, method: "POST", body: second.body });
    expect(retry.headers.get("Idempotency-Key")).toBe(second.headers.get("Idempotency-Key"));
    expect(out.at(-1)).toBe("PASS tidy-up canceled LCK-1.1, LCK-1, LCK-2.1, LCK-2");
  });

  it("fails every step that sends a request once its deadline passes with no answer", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(5));
    const silent = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
    );
    vi.stubGlobal("fetch", silent);
    const { code, out } = await check(["--team", "LCK"]);
    expect(out.filter((line) => line.startsWith("FAIL")).map((line) => line.split(" ")[1])).toEqual([
      "app",
      "mcp",
      "agent-create",
      "replay",
      "key-reuse",
      "stale-if-match",
      "wip-refusal",
      "done-gate",
      "validation",
    ]);
    expect(out.at(-1)).toBe("PASS tidy-up canceled nothing");
    expect(timeout.mock.calls.every(([ms]) => ms === LIVE_CHECK_DEADLINE_MS)).toBe(true);
    expect(code).toBe(EXIT_CODES.refused.code);
  }, 2000);

  it.each([
    ["no team", [], ENV],
    ["no base URL", ["--team", "LCK"], { HX_CITADEL_APP: "http://app.test:8460" }],
  ])("exits 2 with %s and sends nothing", async (_label, argv, env) => {
    const fetchMock = stubFetch([]);
    const { code, err } = await check(argv, env);
    expect(code).toBe(EXIT_CODES.usage.code);
    expect(err).not.toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prints help with the exit codes and sends nothing", async () => {
    const fetchMock = stubFetch([]);
    const { code, out } = await check(["--help"]);
    expect(code).toBe(EXIT_CODES.ok.code);
    expect(out.join("\n")).toContain("--team KEY");
    expect(out.join("\n")).toContain(EXIT_CODES.usage.meaning);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
