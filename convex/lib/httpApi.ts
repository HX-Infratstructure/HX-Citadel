import { ConvexError } from "convex/values";
import { errorMessage } from "../../lib/error-message";
import { ActionCtx, httpAction } from "../_generated/server";
import { hashRequest, Idempotency, IDEMPOTENCY_HEADER, isValidKey } from "./idempotency";

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

/** A JSON body for one issue, with its version as the ETag. */
export function issueJson(status: number, body: { issue: { version: number } }): Response {
  const response = json(status, body);
  response.headers.set("ETag", `"${body.issue.version}"`);
  return response;
}

/** `If-Match: "N"` (or `N`) as the version number the client last read; absent means no check. */
export function readIfMatch(request: Request): number | undefined {
  const header = request.headers.get("If-Match");
  if (header === null) {
    return undefined;
  }
  const version = Number(header.trim().replace(/^"(.*)"$/, "$1"));
  if (!Number.isInteger(version) || version < 1) {
    throw new HttpError(400, "validation", `If-Match must be an issue version such as "2", not ${header}`);
  }
  return version;
}

/** Every write carries `Idempotency-Key`; absent or empty is 400 idempotency_key_required. */
export function readIdempotencyKey(request: Request): string {
  const key = request.headers.get(IDEMPOTENCY_HEADER) ?? "";
  if (key === "") {
    throw new HttpError(400, "idempotency_key_required", `The ${IDEMPOTENCY_HEADER} header is required on every write`);
  }
  if (!isValidKey(key)) {
    throw new HttpError(400, "validation", `${IDEMPOTENCY_HEADER} must be 1 to 200 visible ASCII characters`);
  }
  return key;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "validation", "The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export const ISSUES_PATH = "/api/v1/issues";

const ISSUE_ACTIONS = ["proof", "comments", "subtasks"] as const;
export type IssueAction = (typeof ISSUE_ACTIONS)[number];
export type IssuePath = { key: string; action: IssueAction | null };

/** `/api/v1/issues/{key}` or `/api/v1/issues/{key}/{action}`; any other shape is 404. */
export function parseIssuePath(pathname: string): IssuePath {
  const [key, action, ...rest] = pathname.slice(ISSUES_PATH.length + 1).split("/").map(decodeURIComponent);
  const known = ISSUE_ACTIONS.find((candidate) => candidate === action);
  if (!key || rest.length > 0 || (action !== undefined && known === undefined)) {
    throw new HttpError(404, "not_found", `No route for ${pathname}`);
  }
  return { key, action: known ?? null };
}

const ERROR_MAP: { pattern: RegExp; status: number; code: string }[] = [
  { pattern: /HX_WORKSPACE_ORG_ID/, status: 500, code: "server_error" },
  { pattern: /ArgumentValidationError|Validator error/, status: 400, code: "validation" },
  { pattern: /invalid (agent name|issue key)/i, status: 400, code: "validation" },
  { pattern: /must be an absolute http|cannot be empty/i, status: 400, code: "validation" },
  { pattern: /not found/i, status: 404, code: "not_found" },
];

/** Typed `ConvexError` codes the shared write logic throws, by HTTP status. */
const TYPED_ERRORS: Record<string, number> = { stale: 412, idempotency_key_reused: 409 };

function typedFailure(error: unknown): HttpFailure | null {
  if (!(error instanceof ConvexError)) {
    return null;
  }
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("code" in data) || !("message" in data)) {
    return null;
  }
  const { code, message } = data as ErrorBody;
  const status = TYPED_ERRORS[code];
  return status === undefined ? null : { status, body: { code, message } };
}

/** Any thrown error as a status and a JSON `{code, message}`; an unmapped rule `Error` is a 409 refusal. */
export function toHttpError(error: unknown): HttpFailure {
  if (error instanceof HttpError) {
    return { status: error.status, body: { code: error.code, message: error.message } };
  }
  const typed = typedFailure(error);
  if (typed !== null) {
    return typed;
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

/** What every write route receives: the parsed body and the fields each internal write mutation takes. */
export type WriteRequest = {
  body: Record<string, unknown>;
  fields: { agentName: string; ifMatch: number | undefined; idempotency: Idempotency };
};

/** An agent write route: `Idempotency-Key` is required, and the request is hashed once, here. */
export function writeRoute(handle: (ctx: ActionCtx, request: Request, write: WriteRequest) => Promise<Response>) {
  return agentRoute(async (ctx, request, agentName) => {
    const key = readIdempotencyKey(request);
    const body = await readJsonObject(request);
    const ifMatch = readIfMatch(request);
    const requestHash = await hashRequest(`${request.method} ${new URL(request.url).pathname}`, body, ifMatch);
    return await handle(ctx, request, { body, fields: { agentName, ifMatch, idempotency: { key, requestHash } } });
  });
}
