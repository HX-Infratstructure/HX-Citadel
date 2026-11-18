/**
 * What a blur does with the proof draft.
 * send: save the trimmed draft. pending: the save in flight already carries it, so keep the draft until that save
 * succeeds and keep it for a retry if it fails. saved: the server already holds it, so drop the draft.
 */
export type ProofBlur = { kind: "send"; proofUrl: string } | { kind: "pending" } | { kind: "saved" };

export function proofToSend(draft: string, savedUrl: string, inFlightUrl: string | null): ProofBlur {
  const trimmed = draft.trim();
  if (inFlightUrl !== null && trimmed === inFlightUrl) {
    return { kind: "pending" };
  }
  if (inFlightUrl === null && trimmed === savedUrl) {
    return { kind: "saved" };
  }
  return { kind: "send", proofUrl: trimmed };
}
