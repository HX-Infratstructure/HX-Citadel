import { randomUUID } from "node:crypto";
import { IDEMPOTENCY_HEADER, STALE } from "../lib/api-contract";
import { CitadelApi, CitadelApiError, SITE_URL_ENV, type WriteOptions } from "../lib/citadel-api";

/** Output lines, and stdin for the commands that read it (the pre-push hook). */
export type Io = { out: (line: string) => void; err: (line: string) => void; input?: () => Promise<string> };
export type Env = Record<string, string | undefined>;
export type Args = Record<string, string | undefined>;

/** Bad arguments or missing configuration; nothing was sent. */
export class UsageError extends Error {}

/** Every exit code with its meaning; the help text renders from this table. */
export const EXIT_CODES = {
  ok: { code: 0, meaning: "ok" },
  refused: { code: 1, meaning: "refused: the REST {code, message} is on stderr" },
  usage: { code: 2, meaning: "usage or config error; nothing was sent" },
  stale: { code: 3, meaning: "stale: the issue changed since it was read; re-run" },
} as const;

const API_ENV = "HX_CITADEL_API";
const AGENT_ENV = "HX_CITADEL_AGENT";
const NO_ASSIGNEE = "none";

/** The exit code for an error from parsing or a REST call. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError) {
    return EXIT_CODES.usage.code;
  }
  if (error instanceof CitadelApiError && error.code === STALE) {
    return EXIT_CODES.stale.code;
  }
  return EXIT_CODES.refused.code;
}

/** One stderr line: a REST refusal keeps its `{code, message}`. */
export function errorLine(error: unknown): string {
  if (error instanceof CitadelApiError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The client for the named agent at `HX_CITADEL_API`, falling back to `NEXT_PUBLIC_CONVEX_SITE_URL`. */
export function connect(agentFlag: string | undefined, env: Env): CitadelApi {
  const agent = agentFlag || env[AGENT_ENV];
  if (!agent) {
    throw new UsageError(`Name the agent with --agent or ${AGENT_ENV}`);
  }
  const baseUrl = env[API_ENV] || env[SITE_URL_ENV];
  if (!baseUrl) {
    throw new UsageError(`Set ${API_ENV} (or ${SITE_URL_ENV}) to the REST base URL, such as http://host:3211`);
  }
  return new CitadelApi(agent, baseUrl);
}

/** How a write identifies itself: a caller's Idempotency-Key, and whether to read the version for If-Match first. */
export type WriteFlags = { idempotencyKey?: string; ifMatch: boolean };
export type Context = { api: CitadelApi; io: Io; write: WriteFlags };
export type Command = (context: Context, args: Args) => Promise<unknown>;

export function required(args: Args, name: string, label: string): string {
  const value = args[name];
  if (!value) {
    throw new UsageError(`Missing ${label}`);
  }
  return value;
}

function idempotencyKey({ io, write }: Context): string {
  const key = write.idempotencyKey ?? randomUUID();
  io.err(`${IDEMPOTENCY_HEADER}: ${key}`);
  return key;
}

/** Read-modify-write: the issue's current `issue.version` goes out as If-Match, unless `--no-if-match`. */
async function editOptions(context: Context, key: string): Promise<WriteOptions> {
  const options: WriteOptions = { idempotencyKey: idempotencyKey(context) };
  if (!context.write.ifMatch) {
    return options;
  }
  const { issue } = await context.api.getIssue(key);
  return { ...options, ifMatch: issue.version };
}

function assigneeValue(assignee: string | undefined): string | null | undefined {
  return assignee === NO_ASSIGNEE ? null : assignee;
}

export const commands = {
  list: ({ api }, args) =>
    api.listIssues({ team: required(args, "team", "--team KEY"), status: args.status, assignee: args.assignee, cursor: args.cursor }),

  get: ({ api }, args) => api.getIssue(required(args, "key", "KEY")),

  create: async (context, args) => {
    const body = {
      teamKey: required(args, "team", "--team KEY"),
      title: required(args, "title", "--title T"),
      kind: args.kind,
      type: args.type,
      status: args.status,
      priority: args.priority,
      parentKey: args.parent,
      assignee: args.assignee,
    };
    const options = args.parent ? await editOptions(context, args.parent) : { idempotencyKey: idempotencyKey(context) };
    return context.api.createIssue(body, options);
  },

  update: async (context, args) => {
    const key = required(args, "key", "KEY");
    const body = { status: args.status, assignee: assigneeValue(args.assignee), priority: args.priority, title: args.title, description: args.description };
    return context.api.updateIssue(key, body, await editOptions(context, key));
  },

  proof: async (context, args) => {
    const key = required(args, "key", "KEY");
    const body = { proofUrl: required(args, "url", "URL") };
    return context.api.setProof(key, body, await editOptions(context, key));
  },

  comment: async (context, args) => {
    const key = required(args, "key", "KEY");
    const body = { body: required(args, "body", "BODY") };
    return context.api.addComment(key, body, await editOptions(context, key));
  },

  subtask: async (context, args) => {
    const key = required(args, "key", "KEY");
    const body = { title: required(args, "title", "--title T"), status: args.status };
    return context.api.addSubtask(key, body, await editOptions(context, key));
  },
} satisfies Record<string, Command>;

export type CommandName = keyof typeof commands;
