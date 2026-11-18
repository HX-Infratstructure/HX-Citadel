import { ConvexError } from "convex/values";
import {
  ACTOR_REQUIRED,
  AGENT_HEADER,
  ERROR_STATUS,
  type ErrorCode,
  ETAG_HEADER,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_KEY_REQUIRED,
  IF_MATCH_HEADER,
  isErrorCode,
  NOT_FOUND,
  type Refusal,
  SERVER_ERROR,
  VALIDATION,
} from "../../lib/api-contract";
import { ActionCtx, httpAction } from "../_generated/server";
import { hashRequest, Idempotency, isValidKey } from "./idempotency";

export type HttpFailure = { status: number; body: Refusal };

/** A refusal the HTTP layer raises itself, before any Convex function runs; its status is its code's. */
export class HttpError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.status = ERROR_STATUS[code];
  }
}

/** The acting agent's name; agents carry no key, only this header. */
export function readAgentId(request: Request): string {
  const agentId = request.headers.get(AGENT_HEADER)?.trim();
  if (!agentId) {
    throw new HttpError(ACTOR_REQUIRED, `The ${AGENT_HEADER} header names the acting agent and is required`);
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
  response.headers.set(ETAG_HEADER, `"${body.issue.version}"`);
  return response;
}

/** `If-Match: "N"` (or `N`) as the version number the client last read; absent means no check. */
export function readIfMatch(request: Request): number | undefined {
  const header = request.headers.get(IF_MATCH_HEADER);
  if (header === null) {
    return undefined;
  }
  const version = Number(header.trim().replace(/^"(.*)"$/, "$1"));
  if (!Number.isInteger(version) || version < 1) {
    throw new HttpError(VALIDATION, `${IF_MATCH_HEADER} must be an issue version such as "2", not ${header}`);
  }
  return version;
}

/** Every write carries `Idempotency-Key`; absent or empty is 400 idempotency_key_required. */
export function readIdempotencyKey(request: Request): string {
  const key = request.headers.get(IDEMPOTENCY_HEADER) ?? "";
  if (key === "") {
    throw new HttpError(IDEMPOTENCY_KEY_REQUIRED, `The ${IDEMPOTENCY_HEADER} header is required on every write`);
  }
  if (!isValidKey(key)) {
    throw new HttpError(VALIDATION, `${IDEMPOTENCY_HEADER} must be 1 to 200 visible ASCII characters`);
  }
  return key;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(VALIDATION, "The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export const ISSUES_PATH = "/api/v1/issues";

const ISSUE_ACTIONS = ["proof", "comments", "subtasks", "decisions"] as const;
export type IssueAction = (typeof ISSUE_ACTIONS)[number];
export type IssuePath = { key: string; action: IssueAction | null };

/** The path segments after `/api/v1/issues/`, decoded; none when a percent escape is malformed. */
function decodeSegments(pathname: string): string[] {
  try {
    return pathname.slice(ISSUES_PATH.length + 1).split("/").map(decodeURIComponent);
  } catch {
    return [];
  }
}

/** `/api/v1/issues/{key}` or `/api/v1/issues/{key}/{action}`; any other shape, or a malformed escape, is 404. */
export function parseIssuePath(pathname: string): IssuePath {
  const [key, action, ...rest] = decodeSegments(pathname);
  const known = ISSUE_ACTIONS.find((candidate) => candidate === action);
  if (!key || rest.length > 0 || (action !== undefined && known === undefined)) {
    throw new HttpError(NOT_FOUND, `No route for ${pathname}`);
  }
  return { key, action: known ?? null };
}

/** The `{code, message}` of an `HttpError` or of a `ConvexError` from `refusal`; null for any other error. */
function typedBody(error: unknown): Refusal | null {
  if (error instanceof HttpError) {
    return { code: error.code, message: error.message };
  }
  if (!(error instanceof ConvexError)) {
    return null;
  }
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("code" in data) || !("message" in data)) {
    return null;
  }
  const { code, message } = data;
  return isErrorCode(code) && typeof message === "string" ? { code, message } : null;
}

/**
 * Convex's argument validator throws an untyped error, so it is the one error found by its words: the deployed
 * backend's `ArgumentValidationError` and convex-test's `Validator error`. The body is that line, from the name on.
 */
const VALIDATOR_LINE = /(?:ArgumentValidationError|Validator error)\b.*/;

function validatorRefusal(error: unknown): Refusal | null {
  const line = error instanceof Error ? VALIDATOR_LINE.exec(error.message) : null;
  return line === null ? null : { code: VALIDATION, message: line[0] };
}

/** Any thrown error as its code's status and a JSON `{code, message}`; an unexpected error is logged here and leaves as a bare 500. */
export function toHttpError(error: unknown): HttpFailure {
  const body = typedBody(error) ?? validatorRefusal(error);
  if (body === null) {
    console.error("Unexpected error in an agent route", error);
    return { status: ERROR_STATUS[SERVER_ERROR], body: { code: SERVER_ERROR, message: "Internal error" } };
  }
  return { status: ERROR_STATUS[body.code], body };
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
    const requestHash = await hashRequest(`${request.method} ${new URL(request.url).pathname}`, body);
    return await handle(ctx, request, { body, fields: { agentName, ifMatch, idempotency: { key, requestHash } } });
  });
}
