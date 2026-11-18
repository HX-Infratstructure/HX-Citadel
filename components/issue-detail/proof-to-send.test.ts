import { describe, expect, it } from "vitest";
import { proofToSend } from "./proof-to-send";

const A = "https://ci.example/run/1";
const B = "https://ci.example/run/2";

describe("proofToSend", () => {
  it("sends the trimmed draft when it differs from the saved proof", () => {
    expect(proofToSend(`  ${B} `, A, null)).toBe(B);
  });

  it("skips a draft equal to the saved proof when no save is in flight", () => {
    expect(proofToSend(` ${A}`, A, null)).toBeNull();
  });

  it("sends a revert to the saved proof while a different save is still in flight", () => {
    expect(proofToSend(A, A, B)).toBe(A);
  });

  it("skips a draft equal to the save already in flight", () => {
    expect(proofToSend(B, A, B)).toBeNull();
  });

  it("sends a cleared proof while a save is in flight", () => {
    expect(proofToSend("  ", A, B)).toBe("");
  });
});
