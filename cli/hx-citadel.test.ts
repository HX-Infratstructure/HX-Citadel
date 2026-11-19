// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES } from "./commands";
import { run } from "./hx-citadel";

const API = "http://convex.test:3211";
const ENV = { HX_CITADEL_API: API, HX_CITADEL_AGENT: "cc1" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Reply = { status: number; body: unknown; etag?: string };

function stubFetch(...replies: Reply[]) {
  const queue = [...replies];
  const fetchMock = vi.fn(async () => {
    const { status, body, etag } = queue.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(body), { status, headers: etag ? { ETag: etag } : {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function call(fetchMock: ReturnType<typeof stubFetch>, index: number) {
  const [url, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  return { url, method: init.method, headers: new Headers(init.headers), body };
}

async function cli(argv: string[], env: Record<string, string | undefined> = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, env, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const issue = { issue: { key: "HX-1", version: 7 } };
const record = { ...issue, subtasks: [] };

describe("hx-citadel", () => {
  beforeEach(() => stubFetch({ status: 200, body: {} }));
  afterEach(() => vi.unstubAllGlobals());

  it("list sends the team, status and assignee as query filters and prints the JSON body", async () => {
    const fetchMock = stubFetch({ status: 200, body: { issues: [{ key: "HX-1" }] } });
    const result = await cli(["list", "--team", "HX", "--status", "in_progress", "--assignee", "me"]);

    expect(result.code).toBe(0);
    expect(call(fetchMock, 0)).toMatchObject({ url: `${API}/api/v1/issues?team=HX&status=in_progress&assignee=me`, method: "GET" });
    expect(call(fetchMock, 0).headers.get("X-Agent-Id")).toBe("cc1");
    expect(JSON.parse(result.out)).toEqual({ issues: [{ key: "HX-1" }] });
  });

  it("list --cursor asks for the next page and prints its nextCursor", async () => {
    const fetchMock = stubFetch({ status: 200, body: { issues: [{ key: "HX-1" }], nextCursor: "c2" } });
    const result = await cli(["list", "--team", "HX", "--cursor", "c1"]);

    expect(result.code).toBe(0);
    expect(call(fetchMock, 0).url).toBe(`${API}/api/v1/issues?team=HX&cursor=c1`);
    expect(JSON.parse(result.out)).toEqual({ issues: [{ key: "HX-1" }], nextCursor: "c2" });
  });

  it("get reads one issue by key", async () => {
    const fetchMock = stubFetch({ status: 200, body: record, etag: '"7"' });
    const result = await cli(["get", "HX-1.2"]);

    expect(result.code).toBe(0);
    expect(call(fetchMock, 0)).toMatchObject({ url: `${API}/api/v1/issues/HX-1.2`, method: "GET" });
  });

  it("create --parent maps its flags to the REST body and sends the parent's version as If-Match", async () => {
    const fetchMock = stubFetch({ status: 200, body: record, etag: '"7"' }, { status: 201, body: issue });
    const args = ["create", "--team", "HX", "--title", "Ship it", "--kind", "story", "--priority", "high", "--parent", "HX-0", "--assignee", "cc1"];
    const result = await cli(args);

    expect(result.code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(fetchMock, 0)).toMatchObject({ url: `${API}/api/v1/issues/HX-0`, method: "GET" });
    const sent = call(fetchMock, 1);
    expect(sent).toMatchObject({ url: `${API}/api/v1/issues`, method: "POST" });
    expect(sent.body).toEqual({ teamKey: "HX", title: "Ship it", kind: "story", priority: "high", parentKey: "HX-0", assignee: "cc1" });
    expect(sent.headers.get("If-Match")).toBe('"7"');
  });

  it("create --parent without --team leaves the team to the server, which takes the parent's", async () => {
    const fetchMock = stubFetch({ status: 200, body: record, etag: '"7"' }, { status: 201, body: issue });
    const result = await cli(["create", "--parent", "HX-1", "--title", "Wire it"]);

    expect(result.code).toBe(0);
    const sent = call(fetchMock, 1);
    expect(sent).toMatchObject({ url: `${API}/api/v1/issues`, method: "POST" });
    expect(sent.body).toEqual({ title: "Wire it", parentKey: "HX-1" });
    expect(sent.headers.get("If-Match")).toBe('"7"');
  });

  it("create without --parent sends no read and no If-Match", async () => {
    const fetchMock = stubFetch({ status: 201, body: issue });
    const result = await cli(["create", "--team", "HX", "--title", "Ship it"]);

    expect(result.code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(fetchMock, 0).headers.has("If-Match")).toBe(false);
  });

  it("sends the read's issue.version as If-Match, with no ETag to read", async () => {
    const fetchMock = stubFetch({ status: 200, body: record }, { status: 201, body: { comment: { body: "Started" } } });
    const result = await cli(["comment", "HX-1", "Started"]);

    expect(result.code).toBe(0);
    expect(call(fetchMock, 1).headers.get("If-Match")).toBe('"7"');
  });

  it("refuses to write when the read returns no version", async () => {
    const fetchMock = stubFetch({ status: 200, body: { issue: { key: "HX-1" }, subtasks: [] } });
    const result = await cli(["comment", "HX-1", "Started"]);

    expect(result.code).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.err).toMatch(/server_error: .*GET \/api\/v1\/issues\/HX-1 result is unconfirmed/);
  });

  it("update sends assignee none as null, after reading the version for If-Match", async () => {
    const fetchMock = stubFetch({ status: 200, body: record, etag: '"7"' }, { status: 200, body: issue, etag: '"8"' });
    const result = await cli(["update", "HX-1", "--status", "in_progress", "--assignee", "none"]);

    expect(result.code).toBe(0);
    expect(call(fetchMock, 0)).toMatchObject({ url: `${API}/api/v1/issues/HX-1`, method: "GET" });
    const sent = call(fetchMock, 1);
    expect(sent).toMatchObject({ url: `${API}/api/v1/issues/HX-1`, method: "PATCH", body: { status: "in_progress", assignee: null } });
    expect(sent.headers.get("If-Match")).toBe('"7"');
  });

  it.each([
    [["proof", "HX-1.1", "https://example.test/run/1"], "/api/v1/issues/HX-1.1/proof", { proofUrl: "https://example.test/run/1" }],
    [["comment", "HX-1", "Started"], "/api/v1/issues/HX-1/comments", { body: "Started" }],
    [["subtask", "HX-1", "--title", "Wire it", "--status", "todo"], "/api/v1/issues/HX-1/subtasks", { title: "Wire it", status: "todo" }],
  ])("%j reads the version, then posts with If-Match", async (argv, path, body) => {
    const fetchMock = stubFetch({ status: 200, body: record, etag: '"7"' }, { status: 201, body: issue });
    const result = await cli(argv);

    expect(result.code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(fetchMock, 1)).toMatchObject({ url: `${API}${path}`, method: "POST", body });
    expect(call(fetchMock, 1).headers.get("If-Match")).toBe('"7"');
  });

  it("--no-if-match skips the read and sends no If-Match", async () => {
    const fetchMock = stubFetch({ status: 201, body: issue });
    const result = await cli(["comment", "HX-1", "Started", "--no-if-match"]);

    expect(result.code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(fetchMock, 0).headers.has("If-Match")).toBe(false);
  });

  it("a write sends a generated UUID Idempotency-Key and prints it on stderr", async () => {
    const fetchMock = stubFetch({ status: 201, body: issue });
    const result = await cli(["create", "--team", "HX", "--title", "T"]);

    const key = call(fetchMock, 0).headers.get("Idempotency-Key");
    expect(key).toMatch(UUID);
    expect(result.err).toContain(key);
  });

  it("--idempotency-key is passed through unchanged", async () => {
    const fetchMock = stubFetch({ status: 201, body: issue });
    await cli(["create", "--team", "HX", "--title", "T", "--idempotency-key", "retry-42"]);

    expect(call(fetchMock, 0).headers.get("Idempotency-Key")).toBe("retry-42");
  });

  it("--agent overrides HX_CITADEL_AGENT, and HX_CITADEL_API wins over NEXT_PUBLIC_CONVEX_SITE_URL", async () => {
    const fetchMock = stubFetch({ status: 200, body: record });
    await cli(["get", "HX-1", "--agent", "cc2"], { ...ENV, NEXT_PUBLIC_CONVEX_SITE_URL: "http://other.test" });

    expect(call(fetchMock, 0).url).toBe(`${API}/api/v1/issues/HX-1`);
    expect(call(fetchMock, 0).headers.get("X-Agent-Id")).toBe("cc2");
  });

  it("falls back to NEXT_PUBLIC_CONVEX_SITE_URL for the base URL", async () => {
    const fetchMock = stubFetch({ status: 200, body: record });
    await cli(["get", "HX-1"], { HX_CITADEL_AGENT: "cc1", NEXT_PUBLIC_CONVEX_SITE_URL: "http://site.test" });

    expect(call(fetchMock, 0).url).toBe("http://site.test/api/v1/issues/HX-1");
  });

  it.each([
    ["no agent", ["get", "HX-1"], { HX_CITADEL_API: API }, /--agent|HX_CITADEL_AGENT/],
    ["no base URL", ["get", "HX-1"], { HX_CITADEL_AGENT: "cc1" }, /HX_CITADEL_API/],
    ["no command", [], ENV, /Usage/],
    ["an unknown command", ["destroy"], ENV, /destroy/],
    ["an unknown flag", ["get", "HX-1", "--force"], ENV, /--force/],
    ["a missing positional", ["proof", "HX-1"], ENV, /URL/],
    ["an extra positional", ["get", "HX-1", "HX-2"], ENV, /HX-2/],
    ["a missing required flag", ["list"], ENV, /--team/],
    ["a create with neither --team nor --parent", ["create", "--title", "T"], ENV, /--team KEY or --parent KEY/],
  ])("%s gives exit 2 before any call", async (_name, argv, env, message) => {
    const fetchMock = stubFetch();
    const result = await cli(argv, env);

    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("--help prints the usage and exits 0 without a call or config", async () => {
    const fetchMock = stubFetch();
    const result = await cli(["--help"], {});

    expect(result.code).toBe(0);
    expect(result.out).toMatch(/proof KEY URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("--help prints one line per exit code, from EXIT_CODES", async () => {
    const result = await cli(["--help"], {});
    const lines = result.out.split("\n").map((line) => line.trim());

    for (const { code, meaning } of Object.values(EXIT_CODES)) {
      expect(meaning).toBeTruthy();
      expect(lines).toContain(`${code}  ${meaning}`);
    }
  });

  it("a stale If-Match (412) prints the server's message and exits 3, with no retry", async () => {
    const fetchMock = stubFetch(
      { status: 200, body: record, etag: '"7"' },
      { status: 412, body: { code: "stale", message: "HX-1 is at version 8" } }
    );
    const result = await cli(["update", "HX-1", "--status", "done"]);

    expect(result.code).toBe(3);
    expect(result.err).toContain("HX-1 is at version 8");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a rule refusal (409) prints the code and message and exits 1", async () => {
    stubFetch({ status: 200, body: record, etag: '"7"' }, { status: 409, body: { code: "rule_refused", message: "cc1 already has HX-2 in progress" } });
    const result = await cli(["update", "HX-1", "--status", "in_progress"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("cc1 already has HX-2 in progress");
  });
});
