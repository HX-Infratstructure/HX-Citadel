import { errorMessage } from "../../lib/error-message";
import { ActionCtx, httpAction } from "../_generated/server";

export type ErrorBody = { code: string; message: string };
export type HttpFailure = { status: number; body: ErrorBody };

/** A refusal the HTTP layer raises itself, before any Convex function runs. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export const AGENT_HEADER = "X-Agent-Id";

/** The acting agent's name; agents carry no key, only this header. */
export function readAgentId(request: Request): string {
  const agentId = request.headers.get(AGENT_HEADER)?.trim();
  if (!agentId) {
    throw new HttpError(400, "actor_required", `The ${AGENT_HEADER} header names the acting agent and is required`);
  }
  return agentId;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "validation", "The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

const ERROR_MAP: { pattern: RegExp; status: number; code: string }[] = [
  { pattern: /HX_WORKSPACE_ORG_ID/, status: 500, code: "server_error" },
  { pattern: /ArgumentValidationError|Validator error/, status: 400, code: "validation" },
  { pattern: /invalid (agent name|issue key)/i, status: 400, code: "validation" },
  { pattern: /not found/i, status: 404, code: "not_found" },
];

/** Any thrown error as a status and a JSON `{code, message}`; an unmapped rule `Error` is a 409 refusal. */
export function toHttpError(error: unknown): HttpFailure {
  if (error instanceof HttpError) {
    return { status: error.status, body: { code: error.code, message: error.message } };
  }
  const message = errorMessage(error, "Request failed");
  if (!(error instanceof Error)) {
    return { status: 500, body: { code: "server_error", message } };
  }
  const mapped = ERROR_MAP.find((entry) => entry.pattern.test(error.message));
  if (mapped === undefined) {
    return { status: 409, body: { code: "rule_refused", message } };
  }
  return { status: mapped.status, body: { code: mapped.code, message } };
}

/** An agent route: the header is required, and every error leaves as JSON. */
export function agentRoute(
  handle: (ctx: ActionCtx, request: Request, agentName: string) => Promise<Response>
) {
  return httpAction(async (ctx, request) => {
    try {
      return await handle(ctx, request, readAgentId(request));
    } catch (error) {
      const failure = toHttpError(error);
      return json(failure.status, failure.body);
    }
  });
}
