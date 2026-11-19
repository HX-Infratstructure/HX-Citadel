import { describe, expect, it } from "vitest";
import { RULE_REFUSED, STALE } from "../lib/api-contract";
import { CitadelApiError } from "../lib/citadel-api";
import { EXIT_CODES, UsageError, exitCodeFor } from "./commands";

describe("exitCodeFor", () => {
  // Catches: a reordered or widened branch, such as any CitadelApiError read as stale or a UsageError read as refused.
  it("maps a usage error to 2, a stale refusal to 3, and anything else to 1", () => {
    expect(exitCodeFor(new UsageError("Missing key"))).toBe(EXIT_CODES.usage.code);
    expect(exitCodeFor(new CitadelApiError(STALE, "HX-1 is at version 8"))).toBe(EXIT_CODES.stale.code);
    expect(exitCodeFor(new CitadelApiError(RULE_REFUSED, "cc1 already has HX-2 in progress"))).toBe(EXIT_CODES.refused.code);
    expect(exitCodeFor(new Error("socket hang up"))).toBe(EXIT_CODES.refused.code);
    expect([EXIT_CODES.usage.code, EXIT_CODES.stale.code, EXIT_CODES.refused.code]).toEqual([2, 3, 1]);
  });
});
