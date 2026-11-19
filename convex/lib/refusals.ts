import { ConvexError } from "convex/values";
import { type ErrorCode, NOT_FOUND, type Refusal, RULE_REFUSED, VALIDATION } from "../../lib/api-contract";

/** Refuse with a code from the wire contract. Typed, so callers map it by its code and never by its words. */
export function refusal(code: ErrorCode, message: string): never {
  throw new ConvexError<Refusal>({ code, message });
}

/** Refuse a write that breaks a business rule (WIP, the Done gate, levels). */
export function refuse(message: string): never {
  return refusal(RULE_REFUSED, message);
}

/** Report a record that does not exist, or that the caller's workspace cannot see. */
export function notFound(message: string): never {
  return refusal(NOT_FOUND, message);
}

/** Refuse input the write cannot take, such as a malformed key or an empty comment. */
export function invalid(message: string): never {
  return refusal(VALIDATION, message);
}
