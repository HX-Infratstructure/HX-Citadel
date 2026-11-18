/** The trimmed draft to send, or null when it already equals what the server holds once the save in flight settles. */
export function proofToSend(draft: string, savedUrl: string, inFlightUrl: string | null): string | null {
  const trimmed = draft.trim();
  return trimmed === (inFlightUrl ?? savedUrl) ? null : trimmed;
}
