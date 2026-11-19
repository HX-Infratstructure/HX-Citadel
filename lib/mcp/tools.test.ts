// @vitest-environment node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_HEADER, IF_MATCH_HEADER, STALE } from "../api-contract";
import { CitadelApi } from "../citadel-api";
import { MCP_TOOL, MCP_TOOL_NAMES, createCitadelMcpServer } from "./tools";

const SITE = "http://convex.test:3211";

/** A client connected in memory to the server for `agent`. */
async function connect(agent: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createCitadelMcpServer(new CitadelApi(agent, SITE)).connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCitadelMcpServer", () => {
  // Catches: a tool registered under a literal that is not in MCP_TOOL, or an MCP_TOOL entry never registered;
  // the live checker trusts MCP_TOOL_NAMES to be what tools/list returns.
  it("registers exactly the tools named in MCP_TOOL", async () => {
    const client = await connect("cc2");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  // Catches: a handler that drops the server's agent id, or that turns a stale REST refusal into a success
  // or a generic server_error, so an agent would not know to re-read and retry.
  it("sends the server's agent id and returns a stale refusal as the tool's error", async () => {
    const message = "HX-1 is at version 8";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: STALE, message }), { status: 412 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect("cc2");

    const result = await client.callTool({
      name: MCP_TOOL.updateIssue,
      arguments: { key: "HX-1", status: "done", ifMatch: 7, idempotencyKey: "k-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ code: STALE, message }) }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SITE}/api/v1/issues/HX-1`);
    const headers = new Headers(init.headers);
    expect(headers.get(AGENT_HEADER)).toBe("cc2");
    expect(headers.get(IF_MATCH_HEADER)).toBe('"7"');
  });

  // Catches: a create_issue schema stricter than REST, where parentKey alone is enough and the team is the parent's.
  it("create_issue with only parentKey posts it without a teamKey", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issue: { key: "HX-1.2", version: 1 } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect("cc2");

    const result = await client.callTool({
      name: MCP_TOOL.createIssue,
      arguments: { parentKey: "HX-1", title: "Wire it", idempotencyKey: "k-2" },
    });

    expect(result.isError).toBeFalsy();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SITE}/api/v1/issues`);
    expect(JSON.parse(init.body as string)).toEqual({ parentKey: "HX-1", title: "Wire it" });
  });

  // Catches: a create_issue that sends neither teamKey nor parentKey, which REST can only refuse.
  it("create_issue with neither teamKey nor parentKey refuses before any REST call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect("cc2");

    const result = await client.callTool({ name: MCP_TOOL.createIssue, arguments: { title: "Orphan", idempotencyKey: "k-3" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/teamKey or parentKey/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
