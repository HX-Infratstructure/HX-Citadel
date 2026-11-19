import { text as readText } from "node:stream/consumers";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { HOOK_USAGE, runHook } from "./hook";
import { type Args, type CommandName, commands, connect, type Env, errorLine, EXIT_CODES, exitCodeFor, type Io, UsageError } from "./commands";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Spec = { usage: string; positionals: string[]; options: Options };

const text = { type: "string" } as const;
const flag = { type: "boolean" } as const;

const COMMON: Options = { agent: text, "idempotency-key": text, "no-if-match": flag, json: flag, help: flag };

const SPECS: Record<CommandName, Spec> = {
  list: {
    usage: "list --team KEY [--status S] [--assignee NAME|me] [--cursor NEXT_CURSOR]",
    positionals: [],
    options: { team: text, status: text, assignee: text, cursor: text },
  },
  get: { usage: "get KEY", positionals: ["key"], options: {} },
  create: {
    usage: "create --team KEY|--parent KEY --title T [--kind K] [--type T] [--status S] [--priority P] [--assignee NAME]",
    positionals: [],
    options: { team: text, title: text, kind: text, type: text, status: text, priority: text, parent: text, assignee: text },
  },
  update: {
    usage: "update KEY [--status S] [--assignee NAME|none] [--priority P] [--title T] [--description D]",
    positionals: ["key"],
    options: { status: text, assignee: text, priority: text, title: text, description: text },
  },
  proof: { usage: "proof KEY URL", positionals: ["key", "url"], options: {} },
  comment: { usage: "comment KEY BODY", positionals: ["key", "body"], options: {} },
  subtask: { usage: "subtask KEY --title T [--status S]", positionals: ["key"], options: { title: text, status: text } },
};

const USAGE = [
  "Usage: hx-citadel <command> [--agent NAME] [--idempotency-key K] [--no-if-match]",
  ...Object.values(SPECS).map((spec) => `  ${spec.usage}`),
  ...HOOK_USAGE.map((line) => `  ${line}`),
  "Config: HX_CITADEL_API (or NEXT_PUBLIC_CONVEX_SITE_URL) and --agent or HX_CITADEL_AGENT.",
  "Exit codes:",
  ...Object.values(EXIT_CODES).map(({ code, meaning }) => `  ${code}  ${meaning}`),
].join("\n");

const stringValue = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function isCommand(name: string | undefined): name is CommandName {
  return name !== undefined && Object.hasOwn(SPECS, name);
}

function parse(spec: Spec, argv: string[]) {
  try {
    return parseArgs({ args: argv, options: { ...COMMON, ...spec.options }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Positional values by the names the spec gives them; a missing or extra one is a usage error. */
function namedPositionals(spec: Spec, positionals: string[]): Args {
  if (positionals.length > spec.positionals.length) {
    throw new UsageError(`Unexpected argument ${positionals[spec.positionals.length]}; usage: ${spec.usage}`);
  }
  const missing = spec.positionals[positionals.length];
  if (missing !== undefined) {
    throw new UsageError(`Missing ${missing.toUpperCase()}; usage: ${spec.usage}`);
  }
  return Object.fromEntries(spec.positionals.map((name, index) => [name, positionals[index]]));
}

async function dispatch(argv: string[], env: Env, io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "--help" || name === "-h") {
    io.out(USAGE);
    return EXIT_CODES.ok.code;
  }
  if (name === "hook") {
    return runHook(rest, env, io);
  }
  if (!isCommand(name)) {
    throw new UsageError(name === undefined ? USAGE : `Unknown command ${name}\n${USAGE}`);
  }
  const spec = SPECS[name];
  const { values, positionals } = parse(spec, rest);
  if (values.help) {
    io.out(`Usage: hx-citadel ${spec.usage}`);
    return EXIT_CODES.ok.code;
  }
  const options = Object.keys(spec.options).map((option) => [option, stringValue(values[option])]);
  const args: Args = { ...namedPositionals(spec, positionals), ...Object.fromEntries(options) };
  const write = { idempotencyKey: stringValue(values["idempotency-key"]), ifMatch: !values["no-if-match"] };
  const api = connect(stringValue(values.agent), env);
  io.out(JSON.stringify(await commands[name]({ api, io, write }, args), null, 2));
  return EXIT_CODES.ok.code;
}

/** Runs one command; refusals and usage errors go to stderr, and the exit code comes from `EXIT_CODES`. */
export async function run(argv: string[], env: Env, io: Io): Promise<number> {
  try {
    return await dispatch(argv, env, io);
  } catch (error) {
    io.err(errorLine(error));
    return exitCodeFor(error);
  }
}

// Runs only as the `pnpm citadel` entry, not when a test imports `run`.
if (process.argv[1]?.endsWith("hx-citadel.ts")) {
  const input = () => readText(process.stdin);
  void run(process.argv.slice(2), process.env, { out: console.log, err: console.error, input }).then((code) => {
    process.exitCode = code;
  });
}
