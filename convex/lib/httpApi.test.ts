import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ERROR_STATUS, type ErrorCode } from "../../lib/api-contract";
import { HttpError, parseIssuePath, readAgentId, toHttpError } from "./httpApi";
import { invalid, notFound, refusal, refuse } from "./refusals";

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

/** The statuses `docs/AGENT-API.md` promises agents, one row per code. */
const WIRE_STATUS: [ErrorCode, number][] = [
  ["actor_required", 400],
  ["idempotency_key_required", 400],
  ["validation", 400],
  ["not_found", 404],
  ["rule_refused", 409],
  ["idempotency_key_reused", 409],
  ["stale", 412],
  ["server_error", 500],
];

describe("toHttpError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("the contract table has exactly the codes agents are promised", () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual(WIRE_STATUS.map(([code]) => code).sort());
  });

  test.each(WIRE_STATUS)("an HttpError %s is %i with its own words", (code, status) => {
    expect(toHttpError(new HttpError(code, `refused as ${code}`))).toEqual({ status, body: { code, message: `refused as ${code}` } });
  });

  test.each(WIRE_STATUS)("a typed refusal %s from a Convex function is %i with its own words", (code, status) => {
    expect(toHttpError(captured(() => refusal(code, `refused as ${code}`)))).toEqual({ status, body: { code, message: `refused as ${code}` } });
  });

  test.each([
    ["the deployed backend's text (live, p3-2a 10:17Z)", "ArgumentValidationError: Value does not match validator.", "ArgumentValidationError: Value does not match validator."],
    ["convex-test's text", "Validator error: Expected `string`, got `1`", "Validator error: Expected `string`, got `1`"],
    ["a validator error with detail lines, its first line", "Validator error: Missing required field `title` in object\n    at validateValidator", "Validator error: Missing required field `title` in object"],
  ])("a Convex argument validator error, %s, is 400 validation", (_label, message, expected) => {
    expect(toHttpError(new Error(message))).toEqual({ status: 400, body: { code: "validation", message: expected } });
  });

  test("a rule refusal is 409 rule_refused with the rule's own words", () => {
    const refusal = captured(() => refuse('live-check already has "LCK-7" In Progress; move it to In Review or Done first'));
    expect(toHttpError(refusal)).toEqual({
      status: 409,
      body: { code: "rule_refused", message: 'live-check already has "LCK-7" In Progress; move it to In Review or Done first' },
    });
  });

  test.each([
    ["notFound", () => notFound("Issue ENG-9 not found"), 404, "not_found", "Issue ENG-9 not found"],
    ["invalid", () => invalid("invalid agent name"), 400, "validation", "invalid agent name"],
  ])("a typed %s is %i %s with its own words", (_label, raise, status, code, message) => {
    expect(toHttpError(captured(raise))).toEqual({ status, body: { code, message } });
  });

  test("a misconfiguration refused as server_error is 500 with its words", () => {
    expect(toHttpError(captured(() => refusal("server_error", "HX_WORKSPACE_ORG_ID is not configured")))).toEqual({
      status: 500,
      body: { code: "server_error", message: "HX_WORKSPACE_ORG_ID is not configured" },
    });
  });

  test.each([
    ["a plain Error", new Error("Uncaught Error: Member already has ENG-1 In Progress; move it to In Review or Done first")],
    ["a TypeError", new TypeError("Cannot read properties of null (reading 'teamId')")],
    ["a plain Error whose words say not found", new Error("Database index not found")],
    ["a plain Error whose words say invalid", new Error("invalid agent name")],
    ["a plain Error that names the workspace setting", new Error("HX_WORKSPACE_ORG_ID is not configured")],
    ["a ConvexError with a code the contract lacks", new ConvexError({ code: "TEAM_KEY_TAKEN", message: "Team key ENG is taken" })],
    ["a ConvexError whose code is an Object method", new ConvexError({ code: "toString", message: "not a code" })],
    ["a ConvexError with string data", new ConvexError("Team key ENG is taken")],
    ["a non-error", "boom"],
  ])("%s nobody expected is a logged 500 server_error that keeps its words out of the body", (_label, error) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(toHttpError(error)).toEqual({ status: 500, body: { code: "server_error", message: "Internal error" } });
    expect(logged).toHaveBeenCalledWith(expect.any(String), error);
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
