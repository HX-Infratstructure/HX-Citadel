import { describe, expect, it } from "vitest";
import { proofToSend } from "./proof-to-send";

const A = "https://ci.example/run/1";
const B = "https://ci.example/run/2";

describe("proofToSend", () => {
  it("sends the trimmed draft when it differs from the saved proof", () => {
    expect(proofToSend(`  ${B} `, A, null)).toEqual({ kind: "send", proofUrl: B });
  });

  it("clears a draft equal to the saved proof when no save is in flight", () => {
    expect(proofToSend(` ${A}`, A, null)).toEqual({ kind: "saved" });
  });

  it("sends a revert to the saved proof while a different save is still in flight", () => {
    expect(proofToSend(A, A, B)).toEqual({ kind: "send", proofUrl: A });
  });

  it("keeps a draft equal to the save in flight, so a failed save leaves it to retry", () => {
    expect(proofToSend(B, A, B)).toEqual({ kind: "pending" });
  });

  it("keeps a cleared draft while the cleared proof is in flight", () => {
    expect(proofToSend("  ", A, "")).toEqual({ kind: "pending" });
  });

  it("sends a cleared proof while a save is in flight", () => {
    expect(proofToSend("  ", A, B)).toEqual({ kind: "send", proofUrl: "" });
  });
});
