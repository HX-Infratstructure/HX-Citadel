import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { type CitadelApi, issuePath } from "../lib/citadel-api";
import { formatIssueKey, parseIssueKey, type ParsedIssueKey } from "../lib/issue-key";
import { connect, type Env, errorLine, EXIT_CODES, type Io, UsageError } from "./commands";
import { GitRepo, isZeroSha } from "./git";

export const HOOK_USAGE = [
  "hook pre-push [--repo PATH] [--agent NAME]   git pre-push body: comments commit links on the stories each commit names; never blocks a push",
  "hook install [--repo PATH] [--force]          writes <repo>/.git/hooks/pre-push",
];

const SHORT_SHA_LENGTH = 7;
const NOT_KEY_CHARACTER = /[^A-Za-z0-9.-]+/;
const TRAILING_DOTS = /\.+$/;
const WARNING = "hx-citadel hook: warning:";
const HOOK_NAME = "pre-push";
const CLI_PATH = path.resolve(__dirname, "hx-citadel.ts");
const TSX_PATH = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

type PushedRef = { localSha: string; remoteSha: string };
type CommitComment = { key: string; sha: string; body: string };

function canonicalKey({ teamKey, number, subNumber }: ParsedIssueKey): string | null {
  if (subNumber === undefined) {
    return formatIssueKey(teamKey, { kind: "story", number });
  }
  return formatIssueKey(teamKey, { kind: "subtask", subNumber }, number);
}

function asStoryKey(word: string): string | null {
  const token = word.replace(TRAILING_DOTS, "");
  const parsed = parseIssueKey(token);
  if (parsed === null) {
    return null;
  }
  return canonicalKey(parsed) === token ? token : null;
}

/** Story and subtask keys a commit message names, written as the tracker shows them, each once. */
export function storyKeys(message: string): string[] {
  const keys = message.split(NOT_KEY_CHARACTER).map(asStoryKey);
  return [...new Set(keys.filter((key) => key !== null))];
}

/** A GitHub origin, `https://github.com/o/r(.git)` or `git@github.com:o/r(.git)`, as the commit's web link. */
export function commitUrl(origin: string, sha: string): string {
  const repo = origin.trim().replace(/\.git$/, "");
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(repo);
  if (scp !== null) {
    return `https://${scp[1]}/${scp[2]}/commit/${sha}`;
  }
  const url = new URL(repo);
  return `https://${url.host}${url.pathname}/commit/${sha}`;
}

export function commentText(sha: string, subject: string, url: string): string {
  return `commit ${sha.slice(0, SHORT_SHA_LENGTH)} ${subject} ${url}`;
}

/** A re-push of the same commit replays this comment instead of adding another. */
export function commitIdempotencyKey(sha: string, key: string): string {
  return `commit-${sha}-${key}`;
}

/** Git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
function pushedRefs(input: string): PushedRef[] {
  const lines = input.split("\n").map((line) => line.trim().split(/\s+/));
  return lines.filter((fields) => fields.length === 4).map(([, localSha, , remoteSha]) => ({ localSha, remoteSha }));
}

function commitComments(git: GitRepo, origin: string, sha: string): CommitComment[] {
  const message = git.message(sha);
  const body = commentText(sha, message.split("\n")[0], commitUrl(origin, sha));
  return storyKeys(message).map((key) => ({ key, sha, body }));
}

function pushedComments(git: GitRepo, refs: PushedRef[]): CommitComment[] {
  const origin = git.originUrl();
  const shas = refs.filter((ref) => !isZeroSha(ref.localSha)).flatMap((ref) => git.newCommits(ref.localSha, ref.remoteSha));
  return [...new Set(shas)].flatMap((sha) => commitComments(git, origin, sha));
}

async function post(api: CitadelApi, { key, sha, body }: CommitComment, io: Io): Promise<void> {
  try {
    await api.write("POST", issuePath(key, "comments"), { body }, { idempotencyKey: commitIdempotencyKey(sha, key) });
    io.err(`hx-citadel hook: ${key} <- commit ${sha.slice(0, SHORT_SHA_LENGTH)}`);
  } catch (error) {
    io.err(`${WARNING} ${key} commit ${sha.slice(0, SHORT_SHA_LENGTH)}: ${errorLine(error)}`);
  }
}

function hookOptions(argv: string[]) {
  const options = { repo: { type: "string" }, agent: { type: "string" }, force: { type: "boolean" } } as const;
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true }).values;
  } catch (error) {
    throw new UsageError(errorLine(error));
  }
}

/** Git passes `<remote name> <remote url>` as arguments, which this ignores; any failure is a warning, never a blocked push. */
async function prePush(argv: string[], env: Env, io: Io): Promise<number> {
  try {
    const input = io.input ? await io.input() : "";
    const options = hookOptions(argv);
    const api = connect(options.agent, env);
    const comments = pushedComments(new GitRepo(options.repo ?? process.cwd()), pushedRefs(input));
    for (const comment of comments) {
      await post(api, comment, io);
    }
  } catch (error) {
    io.err(`${WARNING} ${errorLine(error)}; the push continues`);
  }
  return EXIT_CODES.ok.code;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** The hook script: runs this checkout's CLI and exits 0 even when the CLI cannot start. */
function hookScript(): string {
  return [
    "#!/bin/sh",
    `${shellQuote(TSX_PATH)} ${shellQuote(CLI_PATH)} hook ${HOOK_NAME} "$@" || echo "hx-citadel hook: warning: the hook did not run; the push continues" >&2`,
    "exit 0",
    "",
  ].join("\n");
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function install(argv: string[], _env: Env, io: Io): Promise<number> {
  const options = hookOptions(argv);
  const target = new GitRepo(options.repo ?? process.cwd()).hookPath(HOOK_NAME);
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    writeFileSync(target, hookScript(), { mode: 0o755, flag: options.force ? "w" : "wx" });
  } catch (error) {
    if (isFileExists(error)) {
      throw new UsageError(`${target} already exists; pass --force to replace it`);
    }
    throw error;
  }
  chmodSync(target, 0o755);
  io.out(`Installed ${target}`);
  return EXIT_CODES.ok.code;
}

const HOOKS: Record<string, (argv: string[], env: Env, io: Io) => Promise<number>> = { [HOOK_NAME]: prePush, install };

/** `hx-citadel hook <pre-push|install>`. */
export function runHook(argv: string[], env: Env, io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || !Object.hasOwn(HOOKS, name)) {
    throw new UsageError(`Usage:\n${HOOK_USAGE.map((line) => `  hx-citadel ${line}`).join("\n")}`);
  }
  return HOOKS[name](rest, env, io);
}
