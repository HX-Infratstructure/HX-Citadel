import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { connect, EXIT_CODES, type Env, errorLine, type Io, UsageError } from "../cli/commands";
import { AGENT, type LiveCheck, runSteps, STEPS } from "./live-check/steps";

const APP_ENV = "HX_CITADEL_APP";
const DEFAULT_APP = "http://192.168.50.207:8460";

const HELP = [
  "Usage: pnpm live-check -- --team KEY",
  "",
  `Runs the live gate as agent ${AGENT}: ${STEPS.map((step) => step.name).join(", ")}.`,
  `REST at HX_CITADEL_API (or NEXT_PUBLIC_CONVEX_SITE_URL); the app at ${APP_ENV} (default ${DEFAULT_APP}).`,
  "",
  "Exit codes:",
  `  ${EXIT_CODES.ok.code}  every step passed`,
  `  ${EXIT_CODES.refused.code}  a step failed; its FAIL line says why`,
  `  ${EXIT_CODES.usage.code}  ${EXIT_CODES.usage.meaning}`,
];

function setup(argv: string[], env: Env): LiveCheck | "help" {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values } = parseArgs({ args, options: { team: { type: "string" }, help: { type: "boolean" } }, strict: true });
  if (values.help) {
    return "help";
  }
  if (!values.team) {
    throw new UsageError("Name the checks team with --team KEY");
  }
  const api = connect(AGENT, env);
  return { api, appUrl: env[APP_ENV] || DEFAULT_APP, team: values.team, runId: randomUUID(), created: [] };
}

export async function main(argv: string[], env: Env, io: Io): Promise<number> {
  let check: LiveCheck | "help";
  try {
    check = setup(argv, env);
  } catch (error) {
    io.err(errorLine(error));
    return EXIT_CODES.usage.code;
  }
  if (check === "help") {
    HELP.forEach((line) => io.out(line));
    return EXIT_CODES.ok.code;
  }
  const passed = await runSteps(STEPS, check, io.out);
  return passed ? EXIT_CODES.ok.code : EXIT_CODES.refused.code;
}

if (process.argv[1]?.endsWith("live-check.ts")) {
  void main(process.argv.slice(2), process.env, { out: console.log, err: console.error }).then((code) => {
    process.exitCode = code;
  });
}
