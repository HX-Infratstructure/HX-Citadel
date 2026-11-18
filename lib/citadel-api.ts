import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_HEADER, type ErrorBody, ISSUES_PATH, type IssueAction } from "../convex/lib/httpApi";
import { IDEMPOTENCY_HEADER } from "../convex/lib/idempotency";
import { errorMessage } from "./error-message";

export const SITE_URL_ENV = "NEXT_PUBLIC_CONVEX_SITE_URL";

/** A refusal with the REST API's `{code, message}`. */
export class CitadelApiError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export type ApiBody = Record<string, unknown>;
/** `signal` is the caller's deadline; once it fires, the call refuses with `server_error`. */
export type WriteOptions = { idempotencyKey: string; ifMatch?: number; signal?: AbortSignal };
type Query = Record<string, string | undefined>;

export function issuePath(key?: string, action?: IssueAction): string {
  const segments = [ISSUES_PATH, key, action].filter((segment) => segment !== undefined);
  return segments.map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment))).join("/");
}

/** The HX-Citadel REST API (`/api/v1`) as one agent, over HTTP; the base URL defaults to `NEXT_PUBLIC_CONVEX_SITE_URL`. */
export class CitadelApi {
  constructor(
    private readonly agentId: string,
    private readonly baseUrl?: string
  ) {}

  /** `signal` is the caller's deadline, as on `write`. */
  get(path: string, query: Query = {}, signal?: AbortSignal): Promise<ApiBody> {
    return this.send("GET", path, query, {}, undefined, signal);
  }

  write(method: "POST" | "PATCH", path: string, body: ApiBody, options: WriteOptions): Promise<ApiBody> {
    const headers: Record<string, string> = { "Content-Type": "application/json", [IDEMPOTENCY_HEADER]: options.idempotencyKey };
    if (options.ifMatch !== undefined) {
      headers["If-Match"] = `"${options.ifMatch}"`;
    }
    return this.send(method, path, {}, headers, JSON.stringify(body), options.signal);
  }

  private async send(method: string, path: string, query: Query, headers: Record<string, string>, body?: string, signal?: AbortSignal): Promise<ApiBody> {
    try {
      return await this.exchange(method, path, query, headers, body, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw new CitadelApiError("server_error", `The REST API did not answer ${method} ${path} before the deadline (${errorMessage(signal.reason, "aborted")})`);
      }
      throw error;
    }
  }

  private async exchange(method: string, path: string, query: Query, headers: Record<string, string>, body?: string, signal?: AbortSignal): Promise<ApiBody> {
    const url = new URL(path, this.baseUrl ?? siteUrl());
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(name, value);
      }
    }
    const response = await fetch(url.toString(), { method, headers: { ...headers, [AGENT_HEADER]: this.agentId }, body, signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw apiError(response.status, payload);
    }
    if (!isApiBody(payload)) {
      throw new CitadelApiError("server_error", `The REST API answered ${response.status} without a JSON object, so the ${method} ${path} result is unconfirmed`);
    }
    const version = Number(response.headers.get("ETag")?.replace(/^"(.*)"$/, "$1"));
    return Number.isInteger(version) && version > 0 ? { ...payload, version } : payload;
  }
}

function isApiBody(payload: unknown): payload is ApiBody {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function siteUrl(): string {
  const url = process.env[SITE_URL_ENV];
  if (!url) {
    throw new CitadelApiError("server_error", `${SITE_URL_ENV} is not set; /mcp needs the Convex HTTP actions URL`);
  }
  return url;
}

function apiError(status: number, payload: unknown): CitadelApiError {
  const body = payload as Partial<ErrorBody> | null;
  if (typeof body?.code === "string" && typeof body.message === "string") {
    return new CitadelApiError(body.code, body.message);
  }
  return new CitadelApiError("server_error", `The REST API answered ${status} without a {code, message} body`);
}

function errorBody(error: unknown): ErrorBody {
  if (error instanceof CitadelApiError) {
    return { code: error.code, message: error.message };
  }
  return { code: "server_error", message: errorMessage(error, "The REST call failed") };
}

const text = (value: unknown): CallToolResult["content"] => [{ type: "text", text: JSON.stringify(value) }];

/** A REST call as an MCP tool result; a refusal becomes a tool error with the same `{code, message}`. */
export async function toolResult(call: () => Promise<ApiBody>): Promise<CallToolResult> {
  try {
    return { content: text(await call()) };
  } catch (error) {
    return { isError: true, content: text(errorBody(error)) };
  }
}
