import { ConvexError } from "convex/values";

/** The code for a refusal by a business rule (WIP, the Done gate, levels); the HTTP API sends it as 409. */
export const RULE_REFUSED = "rule_refused";

/** Refuse a write that breaks a business rule. Typed, so callers map it by its code and never by its words. */
export function refuse(message: string): never {
  throw new ConvexError({ code: RULE_REFUSED, message });
}
