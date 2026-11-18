import { execFileSync } from "node:child_process";
import path from "node:path";

const ZERO_SHA = /^0+$/;

/** Git writes an all-zeros sha for a ref that does not exist on that side of a push. */
export function isZeroSha(sha: string): boolean {
  return ZERO_SHA.test(sha);
}

/** Read-only git queries against one repository. */
export class GitRepo {
  constructor(private readonly dir: string) {}

  private git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  /** The commits a push of `localSha` adds, oldest first; for a new remote branch, those no remote branch has. */
  newCommits(localSha: string, remoteSha: string): string[] {
    const range = isZeroSha(remoteSha) ? [localSha, "--not", "--remotes"] : [`${remoteSha}..${localSha}`];
    return this.git("rev-list", "--reverse", ...range).split("\n").filter(Boolean);
  }

  message(sha: string): string {
    return this.git("log", "-1", "--format=%B", sha);
  }

  originUrl(): string {
    return this.git("remote", "get-url", "origin");
  }

  /** The path git runs a hook from: `core.hooksPath` when set, else `<repo>/.git/hooks/<name>`, shared by every worktree. */
  hookPath(name: string): string {
    return path.resolve(this.dir, this.git("rev-parse", "--git-path", `hooks/${name}`));
  }
}
