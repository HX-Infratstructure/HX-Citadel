// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commentText, commitIdempotencyKey, commitUrl, storyKeys } from "./hook";
import { run } from "./hx-citadel";

const API = "http://convex.test:3211";
const ENV = { HX_CITADEL_API: API, HX_CITADEL_AGENT: "cc1" };
const HTTPS_ORIGIN = "https://github.com/HX-Infratstructure/HX-Citadel.git";
const SSH_ORIGIN = "git@github.com:HX-Infratstructure/HX-Citadel.git";
const WEB = "https://github.com/HX-Infratstructure/HX-Citadel";
const ZERO = "0".repeat(40);

function stubFetch(status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(status === 200 ? {} : { code: "not_found", message: "No such story" }), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.map((entry) => {
    const [url, init] = entry as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    return {
      url,
      method: init.method,
      key: headers.get("Idempotency-Key"),
      ifMatch: headers.get("If-Match"),
      agent: headers.get("X-Agent-Id"),
      body: JSON.parse(String(init.body)).body,
    };
  });
}

const repos: string[] = [];

function tempRepo(origin = HTTPS_ORIGIN) {
  const dir = mkdtempSync(path.join(tmpdir(), "hx-citadel-hook-"));
  repos.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", path.join(dir, ".git", "hooks"));
  git("remote", "add", "origin", origin);
  const commit = (message: string) => {
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit };
}

async function hook(argv: string[], input = "", env: Record<string, string | undefined> = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line), input: async () => input };
  const code = await run(["hook", ...argv], env, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("storyKeys", () => {
  it("finds story and subtask keys once each, in order", () => {
    expect(storyKeys("HX-12: fix the board (HX-12.3, ENG2-4).\n\nAlso HX-12 again; closes HX-7.")).toEqual(["HX-12", "HX-12.3", "ENG2-4", "HX-7"]);
  });

  it("ignores lowercase, multi-hyphen and padded look-alikes", () => {
    expect(storyKeys("decode utf-8 and ISO-8859-1 on 2026-11-18, x86-64, HX-012, HX-1.2.3")).toEqual([]);
  });

  it("ignores dates, whose first part is not a team key", () => {
    expect(storyKeys("shipped 2026-11-18 for the 2026-11 release (A1-3)")).toEqual(["A1-3"]);
  });
});

describe("commit comment", () => {
  it("links the commit on GitHub from an https or ssh origin", () => {
    expect(commitUrl(HTTPS_ORIGIN, "abc123")).toBe(`${WEB}/commit/abc123`);
    expect(commitUrl(SSH_ORIGIN, "abc123")).toBe(`${WEB}/commit/abc123`);
  });

  it("reads `commit <short-sha> <subject> <url>`", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(commentText(sha, "HX-1: add the hook", `${WEB}/commit/${sha}`)).toBe(`commit 0123456 HX-1: add the hook ${WEB}/commit/${sha}`);
  });

  it("keys each comment by commit and story", () => {
    expect(commitIdempotencyKey("abc123", "HX-1.2")).toBe("commit-abc123-HX-1.2");
  });
});

describe("hx-citadel hook pre-push", () => {
  beforeEach(() => stubFetch());
  afterEach(() => {
    vi.unstubAllGlobals();
    repos.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  function pushedRepo(origin = HTTPS_ORIGIN) {
    const repo = tempRepo(origin);
    const base = repo.commit("HX-9: already pushed");
    repo.git("update-ref", "refs/remotes/origin/main", base);
    const first = repo.commit("HX-1 and HX-2.1: add the hook\n\nBody names HX-1 again.");
    const second = repo.commit("HX-1 follow-up");
    return { ...repo, base, first, second };
  }

  it("posts one comment per key per new commit, as the agent, keyed by commit and story", async () => {
    const fetchMock = stubFetch();
    const { dir, base, first, second } = pushedRepo(SSH_ORIGIN);
    const result = await hook(["pre-push", "--repo", dir, "origin", SSH_ORIGIN], `refs/heads/main ${second} refs/heads/main ${base}\n`);

    expect(result.code).toBe(0);
    expect(calls(fetchMock)).toEqual([
      { url: `${API}/api/v1/issues/HX-1/comments`, method: "POST", key: `commit-${first}-HX-1`, ifMatch: null, agent: "cc1", body: `commit ${first.slice(0, 7)} HX-1 and HX-2.1: add the hook ${WEB}/commit/${first}` },
      { url: `${API}/api/v1/issues/HX-2.1/comments`, method: "POST", key: `commit-${first}-HX-2.1`, ifMatch: null, agent: "cc1", body: `commit ${first.slice(0, 7)} HX-1 and HX-2.1: add the hook ${WEB}/commit/${first}` },
      { url: `${API}/api/v1/issues/HX-1/comments`, method: "POST", key: `commit-${second}-HX-1`, ifMatch: null, agent: "cc1", body: `commit ${second.slice(0, 7)} HX-1 follow-up ${WEB}/commit/${second}` },
    ]);
  });

  it("links each commit under the push destination Git passes, not origin", async () => {
    const fetchMock = stubFetch();
    const { dir, base, second } = pushedRepo();
    const fork = "https://github.com/someone/HX-Citadel-fork.git";
    const result = await hook(["pre-push", "--repo", dir, "fork", fork], `refs/heads/main ${second} refs/heads/main ${base}\n`);

    expect(result.code).toBe(0);
    expect(calls(fetchMock).at(-1)?.body).toBe(`commit ${second.slice(0, 7)} HX-1 follow-up https://github.com/someone/HX-Citadel-fork/commit/${second}`);
  });

  it("warns about a ref whose remote tip is not local and still comments the other refs", async () => {
    const fetchMock = stubFetch();
    const { dir, base, first, second } = pushedRepo();
    const input = `refs/heads/main ${second} refs/heads/gone ${"b".repeat(40)}\nrefs/heads/main ${second} refs/heads/main ${base}\n`;
    const result = await hook(["pre-push", "--repo", dir], input);

    expect(result.code).toBe(0);
    expect(calls(fetchMock).map((entry) => entry.key)).toEqual([`commit-${first}-HX-1`, `commit-${first}-HX-2.1`, `commit-${second}-HX-1`]);
    expect(result.err).toContain("refs/heads/gone");
  });

  it("on a new branch posts only the commits no remote branch has", async () => {
    const fetchMock = stubFetch();
    const { dir, first, second } = pushedRepo();
    const result = await hook(["pre-push", "--repo", dir], `refs/heads/feat ${second} refs/heads/feat ${ZERO}\n`);

    expect(result.code).toBe(0);
    expect(calls(fetchMock).map((entry) => entry.key)).toEqual([`commit-${first}-HX-1`, `commit-${first}-HX-2.1`, `commit-${second}-HX-1`]);
  });

  it("skips a deleted ref", async () => {
    const fetchMock = stubFetch();
    const { dir, second } = pushedRepo();
    const result = await hook(["pre-push", "--repo", dir], `(delete) ${ZERO} refs/heads/old ${second}\n`);

    expect(result.code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns and exits 0 when a REST call fails, and still tries the other comments", async () => {
    const fetchMock = stubFetch(404);
    const { dir, base, second } = pushedRepo();
    const result = await hook(["pre-push", "--repo", dir], `refs/heads/main ${second} refs/heads/main ${base}\n`);

    expect(result.code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.err).toContain("not_found: No such story");
  });

  it("warns and exits 0 without an agent or base URL, sending nothing", async () => {
    const fetchMock = stubFetch();
    const { dir, base, second } = pushedRepo();
    const result = await hook(["pre-push", "--repo", dir], `refs/heads/main ${second} refs/heads/main ${base}\n`, {});

    expect(result.code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.err).toContain("HX_CITADEL_AGENT");
  });

  it("warns and exits 0 outside a git repository", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hx-citadel-nogit-"));
    repos.push(dir);
    const result = await hook(["pre-push", "--repo", dir], `refs/heads/main ${"a".repeat(40)} refs/heads/main ${ZERO}\n`);

    expect(result.code).toBe(0);
    expect(result.err).not.toBe("");
  });
});

describe("hx-citadel hook install", () => {
  afterEach(() => repos.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("writes an executable pre-push hook that runs this checkout's CLI", async () => {
    const { dir } = tempRepo();
    const result = await hook(["install", "--repo", dir]);
    const target = path.join(dir, ".git", "hooks", "pre-push");

    expect(result.code).toBe(0);
    expect(statSync(target).mode & 0o111).not.toBe(0);
    const script = readFileSync(target, "utf8");
    expect(script).toContain(path.resolve(__dirname, "hx-citadel.ts"));
    expect(script).toContain("hook pre-push");
  });

  it("writes into core.hooksPath when the repository sets one", async () => {
    const { dir, git } = tempRepo();
    const hooksDir = path.join(dir, "custom-hooks");
    git("config", "core.hooksPath", hooksDir);
    const result = await hook(["install", "--repo", dir]);

    expect(result.code).toBe(0);
    expect(result.out).toBe(`Installed ${path.join(hooksDir, "pre-push")}`);
    expect(readFileSync(path.join(hooksDir, "pre-push"), "utf8")).toContain("hook pre-push");
  });

  it("refuses to overwrite an existing hook without --force", async () => {
    const { dir } = tempRepo();
    const target = path.join(dir, ".git", "hooks", "pre-push");
    writeFileSync(target, "#!/bin/sh\nexit 0\n");

    const refused = await hook(["install", "--repo", dir]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("--force");
    expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\nexit 0\n");

    const forced = await hook(["install", "--repo", dir, "--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(target, "utf8")).toContain("hook pre-push");
  });
});
