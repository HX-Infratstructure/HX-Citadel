import { ConvexError } from "convex/values";

/** The code for a refusal by a business rule (WIP, the Done gate, levels); the HTTP API sends it as 409. */
export const RULE_REFUSED = "rule_refused";
/** The code for a missing record; the HTTP API sends it as 404. */
export const NOT_FOUND = "not_found";
/** The code for input the write cannot take; the HTTP API sends it as 400. */
export const VALIDATION = "validation";

/** Refuse a write that breaks a business rule. Typed, so callers map it by its code and never by its words. */
export function refuse(message: string): never {
  throw new ConvexError({ code: RULE_REFUSED, message });
}

/** Report a record that does not exist, or that the caller's workspace cannot see. */
export function notFound(message: string): never {
  throw new ConvexError({ code: NOT_FOUND, message });
}

/** Refuse input the write cannot take, such as a malformed key or an empty comment. */
export function invalid(message: string): never {
  throw new ConvexError({ code: VALIDATION, message });
}
