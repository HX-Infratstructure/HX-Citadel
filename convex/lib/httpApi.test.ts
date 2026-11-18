import { afterEach, describe, expect, test, vi } from "vitest";
import { HttpError, parseIssuePath, readAgentId, toHttpError } from "./httpApi";
import { refuse } from "./refusals";

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
  ])("%s maps to %i %s", (message, status, code) => {
    expect(toHttpError(new Error(message))).toMatchObject({ status, body: { code } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a rule refusal is 409 rule_refused with the rule's own words", () => {
    const refusal = captured(() => refuse('live-check already has "LCK-7" In Progress; move it to In Review or Done first'));
    expect(toHttpError(refusal)).toEqual({
      status: 409,
      body: { code: "rule_refused", message: 'live-check already has "LCK-7" In Progress; move it to In Review or Done first' },
    });
  });

  test.each([
    ["a plain Error", new Error("Uncaught Error: Member already has ENG-1 In Progress; move it to In Review or Done first")],
    ["a TypeError", new TypeError("Cannot read properties of null (reading 'teamId')")],
    ["a non-error", "boom"],
  ])("%s nobody expected is a logged 500 server_error that keeps its words out of the body", (_label, error) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(toHttpError(error)).toEqual({ status: 500, body: { code: "server_error", message: "Internal error" } });
    expect(logged).toHaveBeenCalledWith(expect.any(String), error);
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
    for (const path of ["/api/v1/issues/ENG-1/nope", "/api/v1/issues/ENG-1/proof/x", "/api/v1/issues/", "/api/v1/issues/ENG-%E0%A4%A"]) {
      expect(toHttpError(captured(() => parseIssuePath(path)))).toMatchObject({ status: 404, body: { code: "not_found" } });
    }
  });
});
