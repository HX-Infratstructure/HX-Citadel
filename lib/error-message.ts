const CONVEX_THROWN = /Uncaught \w*Error: (.+)/;

function firstLine(message: string): string {
  return message.split("\n")[0].trim();
}

/** A mutation error as one readable line: the thrown message, without Convex's request prefix or stack. */
export function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const thrown = CONVEX_THROWN.exec(error.message);
  if (thrown !== null) {
    return thrown[1].trim();
  }
  return firstLine(error.message) || fallback;
}
