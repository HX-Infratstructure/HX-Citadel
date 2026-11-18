/** The Convex client's header on a server error, then the thrown line when the server sends one. */
const CONVEX_ERROR = /^\[CONVEX [^\]]+\] \[Request ID: [^\]]+\] Server Error(?:\nUncaught \w*Error:(.*))?/;

function readableLine(message: string): string {
  const convex = CONVEX_ERROR.exec(message);
  if (convex === null) {
    return message.split("\n")[0];
  }
  return convex[1] ?? "";
}

/** A mutation error as one readable line: the thrown message, without Convex's request prefix or stack. */
export function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  return readableLine(error.message).trim() || fallback;
}
