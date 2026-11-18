// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "./route";

const SITE = "http://convex.test:3211";
let fetchMock: ReturnType<typeof vi.fn>;

function rpc(method: string, params: unknown, headers: Record<string, string> = { "X-Agent-Id": "cc1" }) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

const INITIALIZE = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };
const toolText = (body: { result: { content: { text: string }[] } }) => body.result.content[0].text;

describe("/mcp", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", SITE);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ issue: { key: "HX-7" } }), { status: 201, headers: { ETag: '"1"' } }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("answers initialize with JSON", async () => {
    const response = await POST(rpc("initialize", INITIALIZE));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/application\/json/);
    expect((await response.json()).result.serverInfo.name).toBe("hx-citadel");
  });

  it("lists the seven tools that mirror REST", async () => {
    const body = await (await POST(rpc("tools/list", {}))).json();
    const names = body.result.tools.map((tool: { name: string }) => tool.name).sort();
    expect(names).toEqual(["add_comment", "add_subtask", "create_issue", "get_issue", "list_issues", "set_proof", "update_issue"]);
  });

  it("refuses a write tool call without idempotencyKey before any REST call", async () => {
    const body = await (await POST(rpc("tools/call", { name: "create_issue", arguments: { teamKey: "HX", title: "T" } }))).json();
    expect(body.result.isError).toBe(true);
    expect(toolText(body)).toMatch(/idempotencyKey/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a write tool call to REST with the agent and the idempotency key", async () => {
    const args = { teamKey: "HX", title: "T", idempotencyKey: "k-1" };
    const body = await (await POST(rpc("tools/call", { name: "create_issue", arguments: args }))).json();

    expect(JSON.parse(toolText(body))).toEqual({ issue: { key: "HX-7" }, version: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SITE}/api/v1/issues`);
    const headers = new Headers(init.headers);
    expect(headers.get("X-Agent-Id")).toBe("cc1");
    expect(headers.get("Idempotency-Key")).toBe("k-1");
    expect(JSON.parse(init.body as string)).toEqual({ teamKey: "HX", title: "T" });
  });

  it("forwards list_issues's cursor as a query parameter and returns the page's nextCursor", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ issues: [], nextCursor: "c2" }), { status: 200 }));
    const body = await (await POST(rpc("tools/call", { name: "list_issues", arguments: { team: "HX", cursor: "c1" } }))).json();

    expect(JSON.parse(toolText(body))).toEqual({ issues: [], nextCursor: "c2" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${SITE}/api/v1/issues?team=HX&cursor=c1`);
  });

  it("forwards create_issue's ifMatch as If-Match, the parent's version check", async () => {
    const args = { teamKey: "HX", title: "T", parentKey: "HX-3", ifMatch: 4, idempotencyKey: "k-2" };
    await POST(rpc("tools/call", { name: "create_issue", arguments: args }));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("If-Match")).toBe('"4"');
    expect(JSON.parse(init.body as string)).toEqual({ teamKey: "HX", title: "T", parentKey: "HX-3" });
  });

  it("rejects a request without X-Agent-Id with actor_required, and no tool runs", async () => {
    const response = await POST(rpc("tools/call", { name: "get_issue", arguments: { key: "HX-1" } }, {}));
    expect(response.status).toBe(400);
    expect((await response.json()).error.data.code).toBe("actor_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives 405 to GET and DELETE", () => {
    expect(GET().status).toBe(405);
    expect(DELETE().status).toBe(405);
  });
});
