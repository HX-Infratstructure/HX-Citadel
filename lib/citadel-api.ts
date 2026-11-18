import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_HEADER, type ErrorBody, IDEMPOTENCY_HEADER, IF_MATCH_HEADER, SERVER_ERROR } from "./api-contract";
import { errorMessage } from "./error-message";

export const SITE_URL_ENV = "NEXT_PUBLIC_CONVEX_SITE_URL";
const ISSUES_PATH = "/api/v1/issues";

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
/** An issue as the REST API sends it: the fields a client relies on, and the rest as sent. */
export type IssueJson = ApiBody & { key: string | null; version: number };
/** The answer of every write that returns one issue. */
export type IssueAnswer = { issue: IssueJson };
/** `GET /api/v1/issues/{key}`: the issue, and a story's sub-tasks. */
export type IssueRecord = IssueAnswer & { subtasks: IssueJson[] };
/** `signal` is the caller's deadline; once it fires, the call refuses with `server_error`. */
export type WriteOptions = { idempotencyKey: string; ifMatch?: number; signal?: AbortSignal };
type Query = Record<string, string | undefined>;
type IssueAction = "proof" | "comments" | "subtasks";
type Call = { method: "GET" | "POST" | "PATCH"; path: string; query?: Query; body?: ApiBody; write?: WriteOptions; signal?: AbortSignal };

function issuePath(key?: string, action?: IssueAction): string {
  const segments = [key, action].filter((segment) => segment !== undefined).map(encodeURIComponent);
  return [ISSUES_PATH, ...segments].join("/");
}

function isApiBody(payload: unknown): payload is ApiBody {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function isIssueJson(value: unknown): value is IssueJson {
  if (!isApiBody(value)) {
    return false;
  }
  const { key, version } = value;
  return (typeof key === "string" || key === null) && typeof version === "number" && Number.isInteger(version) && version > 0;
}

function isIssueAnswer(payload: ApiBody): payload is IssueAnswer {
  return isIssueJson(payload.issue);
}

function isIssueRecord(payload: ApiBody): payload is IssueRecord {
  const { subtasks } = payload;
  return Array.isArray(subtasks) && subtasks.every(isIssueJson) && isIssueAnswer(payload);
}

/** The HX-Citadel REST API (`/api/v1`) as one agent, over HTTP; the base URL defaults to `NEXT_PUBLIC_CONVEX_SITE_URL`. */
export class CitadelApi {
  constructor(
    private readonly agentId: string,
    private readonly baseUrl?: string
  ) {}

  /** One page of a team's issues; `signal` is the caller's deadline, as on a write. */
  listIssues(query: Query, signal?: AbortSignal): Promise<ApiBody> {
    return this.send({ method: "GET", path: issuePath(), query, signal }, isApiBody);
  }

  getIssue(key: string, signal?: AbortSignal): Promise<IssueRecord> {
    return this.send({ method: "GET", path: issuePath(key), signal }, isIssueRecord);
  }

  createIssue(body: ApiBody, write: WriteOptions): Promise<IssueAnswer> {
    return this.send({ method: "POST", path: issuePath(), body, write }, isIssueAnswer);
  }

  updateIssue(key: string, body: ApiBody, write: WriteOptions): Promise<IssueAnswer> {
    return this.send({ method: "PATCH", path: issuePath(key), body, write }, isIssueAnswer);
  }

  setProof(key: string, body: ApiBody, write: WriteOptions): Promise<IssueAnswer> {
    return this.send({ method: "POST", path: issuePath(key, "proof"), body, write }, isIssueAnswer);
  }

  addComment(key: string, body: ApiBody, write: WriteOptions): Promise<ApiBody> {
    return this.send({ method: "POST", path: issuePath(key, "comments"), body, write }, isApiBody);
  }

  addSubtask(key: string, body: ApiBody, write: WriteOptions): Promise<IssueAnswer> {
    return this.send({ method: "POST", path: issuePath(key, "subtasks"), body, write }, isIssueAnswer);
  }

  private async send<T extends ApiBody>(call: Call, isAnswer: (payload: ApiBody) => payload is T): Promise<T> {
    const signal = call.write?.signal ?? call.signal;
    try {
      return await this.exchange(call, signal, isAnswer);
    } catch (error) {
      if (signal?.aborted) {
        throw new CitadelApiError(SERVER_ERROR, `The REST API did not answer ${call.method} ${call.path} before the deadline (${errorMessage(signal.reason, "aborted")})`);
      }
      throw error;
    }
  }

  private async exchange<T extends ApiBody>(call: Call, signal: AbortSignal | undefined, isAnswer: (payload: ApiBody) => payload is T): Promise<T> {
    const url = new URL(call.path, this.baseUrl ?? siteUrl());
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, value);
      }
    }
    const headers = { ...writeHeaders(call.write), [AGENT_HEADER]: this.agentId };
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);
    const response = await fetch(url.toString(), { method: call.method, headers, body, signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw apiError(response.status, payload);
    }
    if (!isApiBody(payload) || !isAnswer(payload)) {
      throw new CitadelApiError(SERVER_ERROR, `The REST API answered ${response.status} without the expected JSON object, so the ${call.method} ${call.path} result is unconfirmed`);
    }
    return payload;
  }
}

function writeHeaders(write: WriteOptions | undefined): Record<string, string> {
  if (write === undefined) {
    return {};
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", [IDEMPOTENCY_HEADER]: write.idempotencyKey };
  if (write.ifMatch !== undefined) {
    headers[IF_MATCH_HEADER] = `"${write.ifMatch}"`;
  }
  return headers;
}

function siteUrl(): string {
  const url = process.env[SITE_URL_ENV];
  if (!url) {
    throw new CitadelApiError(SERVER_ERROR, `${SITE_URL_ENV} is not set; /mcp needs the Convex HTTP actions URL`);
  }
  return url;
}

function apiError(status: number, payload: unknown): CitadelApiError {
  const body = payload as Partial<ErrorBody> | null;
  if (typeof body?.code === "string" && typeof body.message === "string") {
    return new CitadelApiError(body.code, body.message);
  }
  return new CitadelApiError(SERVER_ERROR, `The REST API answered ${status} without a {code, message} body`);
}

function errorBody(error: unknown): ErrorBody {
  if (error instanceof CitadelApiError) {
    return { code: error.code, message: error.message };
  }
  return { code: SERVER_ERROR, message: errorMessage(error, "The REST call failed") };
}

const text = (value: unknown): CallToolResult["content"] => [{ type: "text", text: JSON.stringify(value) }];

/** A REST call as an MCP tool result; a refusal becomes a tool error with the same `{code, message}`. */
export async function toolResult(call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: text(await call()) };
  } catch (error) {
    return { isError: true, content: text(errorBody(error)) };
  }
}
