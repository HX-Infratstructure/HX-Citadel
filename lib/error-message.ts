import { ConvexError, type Value } from "convex/values";

/** A server error, with the Convex client's header when it came through the client, then the thrown line when the server sends one. */
const CONVEX_ERROR = /^(?:\[CONVEX [^\]]+\] )?\[Request ID: [^\]]+\] Server Error(?:\nUncaught \w*Error:(.*))?/;
/** The thrown line alone, as an error raised inside an HTTP action through `ctx.runMutation` reaches its catch. */
const THROWN_LINE = /^Uncaught \w*Error:(.*)/;

function readableLine(message: string): string {
  const match = CONVEX_ERROR.exec(message) ?? THROWN_LINE.exec(message);
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
