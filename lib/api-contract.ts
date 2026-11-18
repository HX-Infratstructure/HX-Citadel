/** The agent REST API's wire contract. The Convex HTTP layer and its clients both import it, so it imports nothing. */

export const AGENT_HEADER = "X-Agent-Id";
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IF_MATCH_HEADER = "If-Match";
export const ETAG_HEADER = "ETag";

export const ACTOR_REQUIRED = "actor_required";
export const IDEMPOTENCY_KEY_REQUIRED = "idempotency_key_required";
export const VALIDATION = "validation";
export const NOT_FOUND = "not_found";
/** A business rule (WIP, the Done gate, levels) refused the write. */
export const RULE_REFUSED = "rule_refused";
export const IDEMPOTENCY_KEY_REUSED = "idempotency_key_reused";
/** `If-Match` names an older issue version. */
export const STALE = "stale";
export const SERVER_ERROR = "server_error";

/** Every error code the API sends, and its HTTP status. */
export const ERROR_STATUS = {
  [ACTOR_REQUIRED]: 400,
  [IDEMPOTENCY_KEY_REQUIRED]: 400,
  [VALIDATION]: 400,
  [NOT_FOUND]: 404,
  [RULE_REFUSED]: 409,
  [IDEMPOTENCY_KEY_REUSED]: 409,
  [STALE]: 412,
  [SERVER_ERROR]: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** An error the server sends: a code from `ERROR_STATUS` and the server's own words. */
export type Refusal = { code: ErrorCode; message: string };

/** An error body as a client reads it; `code` is a string, since a newer server can send a code the client does not know. */
export type ErrorBody = { code: string; message: string };

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && Object.hasOwn(ERROR_STATUS, code);
}

const MAX_ATTACHMENT_MB = 25;
/** The server refuses a larger attachment; the upload panel checks first so a too-large file is never uploaded. */
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;
export const ATTACHMENT_TOO_LARGE = `Attachments are limited to ${MAX_ATTACHMENT_MB} MB`;
