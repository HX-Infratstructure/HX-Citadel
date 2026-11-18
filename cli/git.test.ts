// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitRepo, isZeroSha } from "./git";

const ZERO = "0".repeat(40);
const repos: string[] = [];

/**
 * A repository whose `origin/main` is at `base` and whose `origin/side` is at `side`, with `tip` on top of `side`
 * known to no remote. A real repository, because `GitRepo` runs git itself and takes no injected runner.
 */
function pushedRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "hx-citadel-git-"));
  repos.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  const commit = (message: string) => {
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const base = commit("base");
  git("update-ref", "refs/remotes/origin/main", base);
  const side = commit("side");
  git("update-ref", "refs/remotes/origin/side", side);
  const tip = commit("tip");
  return { repo: new GitRepo(dir), base, side, tip };
}

afterEach(() => {
  repos.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("isZeroSha", () => {
  // Catches: a deleted or new ref read as a real sha, or a real sha that merely starts with zeros read as missing.
  it("is true only for an all-zeros sha", () => {
    expect(isZeroSha(ZERO)).toBe(true);
    expect(isZeroSha("0123456789abcdef0123456789abcdef01234567")).toBe(false);
    expect(isZeroSha(`${"0".repeat(39)}1`)).toBe(false);
  });
});

describe("GitRepo.newCommits", () => {
  // Catches: a new remote branch ranged as `0000..tip`, which git refuses, or as plain `tip`, which re-posts pushed history.
  it("for a new remote branch, returns only the commits no remote branch has", () => {
    const { repo, tip } = pushedRepo();
    expect(repo.newCommits(tip, ZERO)).toEqual([tip]);
  });

  // Catches: an existing remote branch ranged with `--not --remotes`, which drops `side` because another remote branch has it.
  it("for an existing remote branch, returns remote..local, oldest first", () => {
    const { repo, base, side, tip } = pushedRepo();
    expect(repo.newCommits(tip, base)).toEqual([side, tip]);
  });
});
