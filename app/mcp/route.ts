import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HttpError, readAgentId } from "../../convex/lib/httpApi";
import { CitadelApi } from "../../lib/citadel-api";
import { createCitadelMcpServer } from "../../lib/mcp/tools";

export const runtime = "nodejs";

function rpcError(status: number, message: string, data?: object, headers?: HeadersInit): Response {
  const body = { jsonrpc: "2.0", id: null, error: { code: -32600, message, data } };
  return Response.json(body, { status, headers });
}

function agentOf(request: Request): string | HttpError {
  try {
    return readAgentId(request);
  } catch (error) {
    if (error instanceof HttpError) {
      return error;
    }
    throw error;
  }
}

/** Stateless JSON-RPC over POST: one server and transport per request, no sessions, no SSE. */
export async function POST(request: Request): Promise<Response> {
  const agent = agentOf(request);
  if (agent instanceof HttpError) {
    return rpcError(agent.status, agent.message, { code: agent.code });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await createCitadelMcpServer(new CitadelApi(agent)).connect(transport);
  return transport.handleRequest(request);
}

export function GET(): Response {
  return rpcError(405, "/mcp takes JSON-RPC over POST only", undefined, { Allow: "POST" });
}

export const DELETE = GET;
