import { describe, expect, test } from "vitest";
import { HttpError, parseIssuePath, readAgentId, toHttpError } from "./httpApi";

const withAgent = (value?: string) =>
  new Request("http://x/api/v1/issues", value === undefined ? {} : { headers: { "X-Agent-Id": value } });

describe("readAgentId", () => {
  test("a missing header is refused as actor_required", () => {
    expect(() => readAgentId(withAgent())).toThrow(HttpError);
    expect(toHttpError(captured(() => readAgentId(withAgent())))).toMatchObject({
      status: 400,
      body: { code: "actor_required" },
    });
  });

  test("an empty header is refused as actor_required", () => {
    expect(toHttpError(captured(() => readAgentId(withAgent("   "))))).toMatchObject({
      status: 400,
      body: { code: "actor_required" },
    });
  });

  test("a valid header is returned trimmed", () => {
    expect(readAgentId(withAgent("  cc1 "))).toBe("cc1");
  });
});

function captured(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("toHttpError", () => {
  test.each([
    ["ArgumentValidationError: Value does not match validator.", 400, "validation"],
    ["Validator error: Expected `string`, got `1`", 400, "validation"],
    ["invalid agent name", 400, "validation"],
    ["Team not found", 404, "not_found"],
    ["Uncaught Error: Member already has ENG-1 In Progress; move it to In Review or Done first", 409, "rule_refused"],
  ])("%s maps to %i %s", (message, status, code) => {
    expect(toHttpError(new Error(message))).toMatchObject({ status, body: { code } });
  });

  test("a rule refusal carries the rule's message without the Convex wrapper", () => {
    const wrapped = new Error("[Request ID: 1] Server Error\nUncaught Error: Cannot close: tests pending");
    expect(toHttpError(wrapped).body).toEqual({ code: "rule_refused", message: "Cannot close: tests pending" });
  });

  test("a missing or unmatched workspace setting maps to 500 server_error", () => {
    expect(toHttpError(new Error("HX_WORKSPACE_ORG_ID is not configured"))).toMatchObject({
      status: 500,
      body: { code: "server_error" },
    });
  });
});

describe("parseIssuePath", () => {
  test.each([
    ["/api/v1/issues/ENG-1", { key: "ENG-1", action: null }],
    ["/api/v1/issues/ENG-1.2", { key: "ENG-1.2", action: null }],
    ["/api/v1/issues/ENG-1/proof", { key: "ENG-1", action: "proof" }],
    ["/api/v1/issues/ENG-1.1/comments", { key: "ENG-1.1", action: "comments" }],
    ["/api/v1/issues/ENG-1/subtasks", { key: "ENG-1", action: "subtasks" }],
  ])("%s", (path, expected) => {
    expect(parseIssuePath(path)).toEqual(expected);
  });

  test("an unknown sub-path or extra segment is 404 not_found", () => {
    for (const path of ["/api/v1/issues/ENG-1/nope", "/api/v1/issues/ENG-1/proof/x", "/api/v1/issues/"]) {
      expect(toHttpError(captured(() => parseIssuePath(path)))).toMatchObject({ status: 404, body: { code: "not_found" } });
    }
  });
});
