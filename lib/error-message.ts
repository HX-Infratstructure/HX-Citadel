import { ConvexError, type Value } from "convex/values";

/**
 * The fallback for an untyped server error, which has no `ConvexError.data` to read: the browser client's
 * `[CONVEX M(path)] ` header (convex/src/browser/logging.ts:165; the HTTP client sends none), the backend's
 * `[Request ID: id] Server Error`, then the thrown line when the deployment sends one. error-message.test.ts pins it.
 */
const CONVEX_ERROR = /^(?:\[CONVEX [^\]]+\] )?\[Request ID: [^\]]+\] Server Error(?:\nUncaught \w*Error:(.*))?/;

function readableLine(message: string): string {
  const match = CONVEX_ERROR.exec(message);
  if (match === null) {
    return message.split("\n")[0];
  }
  return match[1] ?? "";
}

/** The words a `ConvexError` carries: its data's `message`, or the data itself when it is a string. */
function dataWords(error: ConvexError<Value>): string | undefined {
  const data: unknown = error.data;
  if (typeof data === "string") {
    return data;
  }
  if (typeof data === "object" && data !== null && "message" in data && typeof data.message === "string") {
    return data.message;
  }
  return undefined;
}

/** A mutation error as one readable line: a `ConvexError`'s own words, else the thrown message without Convex's request prefix or stack. */
export function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const words = error instanceof ConvexError ? dataWords(error) : undefined;
  return (words ?? readableLine(error.message)).trim() || fallback;
}
