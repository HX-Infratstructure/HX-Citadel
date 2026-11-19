import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CitadelApi, toolResult } from "./citadel-api";

const SITE = "http://convex.test:3211";

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A fetch that never answers; like the real one, it rejects once the request's signal aborts. */
function stubSilentFetch() {
  const fetchMock = vi.fn(
    (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const textOf = (result: Awaited<ReturnType<typeof toolResult>>) => JSON.parse((result.content[0] as { text: string }).text);

describe("CitadelApi", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", SITE));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards X-Agent-Id, Idempotency-Key and If-Match, and returns the body as the server sent it", async () => {
    const fetchMock = stubFetch(200, { issue: { key: "HX-1", version: 4 } }, { ETag: '"4"' });
    const result = await new CitadelApi("cc1").updateIssue("HX-1", { status: "todo" }, { idempotencyKey: "k-1", ifMatch: 3 });

    expect(result).toEqual({ issue: { key: "HX-1", version: 4 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SITE}/api/v1/issues/HX-1`);
    expect(init.method).toBe("PATCH");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Agent-Id")).toBe("cc1");
    expect(headers.get("Idempotency-Key")).toBe("k-1");
    expect(headers.get("If-Match")).toBe('"3"');
    expect(JSON.parse(init.body as string)).toEqual({ status: "todo" });
  });

  it("sends query filters on reads, without the undefined ones", async () => {
    const fetchMock = stubFetch(200, { issues: [] });
    await new CitadelApi("cc1").listIssues({ team: "HX", status: undefined, assignee: "me" });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${SITE}/api/v1/issues?team=HX&assignee=me`);
  });

  it("sends no If-Match on a write when the caller gave no version", async () => {
    const fetchMock = stubFetch(201, { issue: { key: "HX-2", version: 1 } });
    await new CitadelApi("cc1").createIssue({ teamKey: "HX", title: "T" }, { idempotencyKey: "k-2" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Idempotency-Key")).toBe("k-2");
    expect(headers.has("If-Match")).toBe(false);
  });

  it("maps a write the API does not answer before the caller's signal fires to server_error", async () => {
    const fetchMock = stubSilentFetch();
    const signal = AbortSignal.timeout(20);
    const result = await toolResult(() => new CitadelApi("cc1").addComment("HX-1", { body: "b" }, { idempotencyKey: "k-4", signal }));

    expect(result.isError).toBe(true);
    expect(textOf(result).code).toBe("server_error");
    expect(textOf(result).message).toMatch(/did not answer POST \/api\/v1\/issues\/HX-1\/comments before the deadline/);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(signal);
  }, 2_000);

  it("maps a read the API does not answer before the caller's signal fires to server_error", async () => {
    stubSilentFetch();
    const result = await toolResult(() => new CitadelApi("cc1").getIssue("HX-1", AbortSignal.timeout(20)));

    expect(result.isError).toBe(true);
    expect(textOf(result).code).toBe("server_error");
    expect(textOf(result).message).toMatch(/did not answer GET \/api\/v1\/issues\/HX-1 before the deadline/);
  }, 2_000);

  it.each([
    ["an HTML page", "<html>proxy</html>"],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
  ])("refuses a 2xx answer with %s as server_error, saying the write's result is unconfirmed", async (_name, raw) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(raw, { status: 201 })));
    const result = await toolResult(() => new CitadelApi("cc1").createIssue({ teamKey: "HX", title: "T" }, { idempotencyKey: "k-3" }));

    expect(result.isError).toBe(true);
    expect(textOf(result).code).toBe("server_error");
    expect(textOf(result).message).toMatch(/unconfirmed/);
  });

  it("maps a REST {code, message} to a tool error with the same code and message", async () => {
    stubFetch(412, { code: "stale", message: "HX-1 changed; it is at version 5" });
    const result = await toolResult(() => new CitadelApi("cc1").getIssue("HX-1"));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ code: "stale", message: "HX-1 changed; it is at version 5" });
  });

  it("refuses with a clear error when the REST base URL is missing, without calling fetch", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "");
    const fetchMock = stubFetch(200, {});
    const result = await toolResult(() => new CitadelApi("cc1").getIssue("HX-1"));

    expect(result.isError).toBe(true);
    expect(textOf(result).code).toBe("server_error");
    expect(textOf(result).message).toMatch(/NEXT_PUBLIC_CONVEX_SITE_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a base URL given to the constructor instead of the environment", async () => {
    const fetchMock = stubFetch(200, { issues: [], nextCursor: null });
    await new CitadelApi("cc1", "http://cli.test:3211").listIssues({ team: "HX" });

    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("http://cli.test:3211/api/v1/issues?team=HX");
  });

  it.each([
    ["each write's method and path", "HX-1.2"],
    ["a key with a reserved character, encoded", "HX 1/2"],
  ])("sends %s", async (_name, key) => {
    const fetchMock = stubFetch(201, { issue: { key: "HX-1.2", version: 1 }, comment: {} });
    const api = new CitadelApi("cc1");
    const write = { idempotencyKey: "k-5" };
    await api.setProof(key, { proofUrl: "https://example.test/run/1" }, write);
    await api.addComment(key, { body: "b" }, write);
    await api.addSubtask(key, { title: "T" }, write);
    await api.updateIssue(key, { status: "todo" }, write);

    const sent = fetchMock.mock.calls.map((entry) => {
      const [url, init] = entry as unknown as [string, RequestInit];
      return `${init.method} ${url.slice(SITE.length)}`;
    });
    const path = `/api/v1/issues/${encodeURIComponent(key)}`;
    expect(sent).toEqual([`POST ${path}/proof`, `POST ${path}/comments`, `POST ${path}/subtasks`, `PATCH ${path}`]);
  });

  it.each([
    ["a write's issue without a version", () => new CitadelApi("cc1").createIssue({ teamKey: "HX", title: "T" }, { idempotencyKey: "k-6" }), { issue: { key: "HX-1" } }],
    ["a read without subtasks", () => new CitadelApi("cc1").getIssue("HX-1"), { issue: { key: "HX-1", version: 2 } }],
    ["a sub-task without a version", () => new CitadelApi("cc1").getIssue("HX-1"), { issue: { key: "HX-1", version: 2 }, subtasks: [{ key: "HX-1.1" }] }],
  ])("refuses %s as server_error, saying the result is unconfirmed", async (_name, call, body) => {
    stubFetch(200, body);
    const result = await toolResult(call);

    expect(result.isError).toBe(true);
    expect(textOf(result).code).toBe("server_error");
    expect(textOf(result).message).toMatch(/unconfirmed/);
  });
});
