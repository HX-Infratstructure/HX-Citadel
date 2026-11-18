import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ACTOR_REQUIRED, AGENT_HEADER, ERROR_STATUS } from "../../lib/api-contract";
import { CitadelApi } from "../../lib/citadel-api";
import { createCitadelMcpServer } from "../../lib/mcp/tools";

export const runtime = "nodejs";

function rpcError(status: number, message: string, data?: object, headers?: HeadersInit): Response {
  const body = { jsonrpc: "2.0", id: null, error: { code: -32600, message, data } };
  return Response.json(body, { status, headers });
}

/** Stateless JSON-RPC over POST: one server and transport per request, no sessions, no SSE. */
export async function POST(request: Request): Promise<Response> {
  const agent = request.headers.get(AGENT_HEADER)?.trim();
  if (!agent) {
    return rpcError(ERROR_STATUS[ACTOR_REQUIRED], `The ${AGENT_HEADER} header names the acting agent and is required`, { code: ACTOR_REQUIRED });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await createCitadelMcpServer(new CitadelApi(agent)).connect(transport);
  return transport.handleRequest(request);
}

export function GET(): Response {
  return rpcError(405, "/mcp takes JSON-RPC over POST only", undefined, { Allow: "POST" });
}

export const DELETE = GET;
