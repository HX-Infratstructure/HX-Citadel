import { BaseConvexClient, ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError, type JSONValue } from "convex/values";
import { describe, expect, test } from "vitest";
import { errorMessage } from "./error-message";

const FALLBACK = "Failed to move issue";

/** What the backend sends for a failed call: `[Request ID: id] Server Error`, then the thrown line and its stack when the deployment sends them. */
function serverMessage(thrown?: string): string {
  const header = "[Request ID: fc75885dfd89a611] Server Error";
  return thrown === undefined ? header : `${header}\n${thrown}\n    at handler (../convex/issues.ts:12:11)`;
}

type Failure = { errorMessage: string; errorData?: JSONValue };

/** A WebSocket standing in for the backend: it answers every mutation with `failure` as a `MutationResponse`. */
function backendFailing(failure: Failure) {
  return class {
    onopen: (() => void) | null = null;
    onmessage: ((message: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor() {
      setTimeout(() => this.onopen?.());
    }

    send(data: string) {
      const message = JSON.parse(data) as { type: string; requestId?: number };
      if (message.type !== "Mutation") {
        return;
      }
      const response = {
        type: "MutationResponse",
        requestId: message.requestId,
        success: false,
        result: failure.errorMessage,
        errorData: failure.errorData,
        logLines: [],
      };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(response) }));
    }

    close() {
      this.onclose?.();
    }
  };
}

/** What Convex's browser client, the one `useMutation` calls, throws when the backend refuses a mutation. */
async function thrownByBrowserClient(failure: Failure): Promise<unknown> {
  const client = new BaseConvexClient("http://127.0.0.1:3210", () => {}, {
    webSocketConstructor: backendFailing(failure) as unknown as typeof WebSocket,
    logger: false,
    skipConvexDeploymentUrlCheck: true,
  });
  const thrown = await client.mutation("issues:update", {}).catch((error: unknown) => error);
  await client.close();
  return thrown;
}

/** What Convex's HTTP client throws when the backend refuses a mutation. */
async function thrownByHttpClient(failure: Failure): Promise<unknown> {
  const backend = async () => Response.json({ status: "error", ...failure, logLines: [] });
  const client = new ConvexHttpClient("http://127.0.0.1:3210", { fetch: backend, logger: false, skipConvexDeploymentUrlCheck: true });
  return client.mutation(makeFunctionReference<"mutation">("issues:update"), {}).catch((error: unknown) => error);
}

describe("the Convex client wording errorMessage relies on", () => {
  test("the browser client wraps the backend's message in its header and suffix (convex/src/browser/logging.ts:165)", async () => {
    const thrown = await thrownByBrowserClient({ errorMessage: serverMessage("Uncaught Error: Team not found") });
    expect(thrown).not.toBeInstanceOf(ConvexError);
    expect((thrown as Error).message).toBe(`[CONVEX M(issues:update)] ${serverMessage("Uncaught Error: Team not found")}\n  Called by client`);
  });

  test("the browser client forwards a ConvexError's data to the browser (convex/src/browser/sync/client.ts:865-872)", async () => {
    const data = { code: "rule_refused", message: "Team key ENG is taken" };
    const thrown = await thrownByBrowserClient({ errorMessage: serverMessage(`Uncaught ConvexError: ${JSON.stringify(data)}`), errorData: data });
    expect(thrown).toBeInstanceOf(ConvexError);
    expect((thrown as ConvexError<JSONValue>).data).toEqual(data);
  });

  test("the HTTP client throws the backend's message bare (convex/src/browser/http_client.ts:387)", async () => {
    const thrown = await thrownByHttpClient({ errorMessage: serverMessage("Uncaught Error: Team not found") });
    expect((thrown as Error).message).toBe(serverMessage("Uncaught Error: Team not found"));
  });
});

describe("errorMessage", () => {
  test.each<[string, Failure, string]>([
    [
      "a typed refusal, its own words",
      {
        errorMessage: serverMessage('Uncaught ConvexError: {"code":"rule_refused","message":"Can\'t move ENG-1 to Done"}'),
        errorData: { code: "rule_refused", message: "Can't move ENG-1 to Done: open — ENG-1.2 Write API" },
      },
      "Can't move ENG-1 to Done: open — ENG-1.2 Write API",
    ],
    ["a typed refusal whose data is a string, as is", { errorMessage: serverMessage("Uncaught ConvexError: Team key ENG is taken"), errorData: "Team key ENG is taken" }, "Team key ENG is taken"],
    ["a typed refusal with a blank message, the fallback", { errorMessage: serverMessage("Uncaught ConvexError: x"), errorData: { code: "rule_refused", message: "  " } }, FALLBACK],
    ["a ConvexError whose data has no words, the thrown line", { errorMessage: serverMessage("Uncaught ConvexError: Team key ENG is taken"), errorData: { code: "TEAM_KEY_TAKEN" } }, "Team key ENG is taken"],
    ["an untyped server error, the generic fallback", { errorMessage: serverMessage() }, FALLBACK],
    ["an untyped server error with its thrown line, that line", { errorMessage: serverMessage("Uncaught Error: Only the author can edit a comment") }, "Only the author can edit a comment"],
    ["an untyped server error with an empty thrown line, the fallback", { errorMessage: serverMessage("Uncaught Error: ") }, FALLBACK],
    ["an untyped server error with a blank thrown line, the fallback", { errorMessage: serverMessage("Uncaught Error:    ") }, FALLBACK],
    [
      'a thrown line with "Uncaught Error:" in the middle, kept whole',
      { errorMessage: serverMessage("Uncaught Error: Report says Uncaught Error: draft.txt") },
      "Report says Uncaught Error: draft.txt",
    ],
  ])("from the browser client, %s", async (_label, failure, expected) => {
    expect(errorMessage(await thrownByBrowserClient(failure), FALLBACK)).toBe(expected);
  });

  test("from the HTTP client, the thrown line", async () => {
    const thrown = await thrownByHttpClient({ errorMessage: serverMessage("Uncaught Error: Team not found") });
    expect(errorMessage(thrown, FALLBACK)).toBe("Team not found");
  });

  test.each<[string, unknown, string]>([
    ["a plain error, as is", new Error("Team not found"), "Team not found"],
    ['a plain error with "Uncaught Error:" in the middle, as is', new Error("Failed to upload report Uncaught Error: draft.txt"), "Failed to upload report Uncaught Error: draft.txt"],
    ["a multi-line plain error, its first line", new Error("First line\n    at x"), "First line"],
    ["an empty error, the fallback", new Error(""), FALLBACK],
    ["a non-error, the fallback", "boom", FALLBACK],
  ])("%s", (_label, error, expected) => {
    expect(errorMessage(error, FALLBACK)).toBe(expected);
  });
});
