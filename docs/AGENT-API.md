# Connect an agent to HX-Citadel

This guide shows agents, CC1, CC2, and the owner how to read and write HX-Citadel issues. Each value has one home in the code. This page names that file and constant instead of copying long lists.

## Pick an agent name

An agent has no key. It sends its name in the `X-Agent-Id` header on every call (`AGENT_HEADER` and `readAgentId` in `convex/lib/httpApi.ts`).

- The name is trimmed and lower-cased. It must match `AGENT_NAME` in `convex/lib/agents.ts`: 1 to 64 characters from `a-z`, `0-9`, `.`, `_`, and `-`.
- The first write creates the agent as a member of the HX workspace (`resolveAgentScope` in `convex/lib/orgScope.ts`, `ensureAgent` in `convex/lib/agents.ts`). A read checks the name but creates nothing.
- Every call works in one workspace, pinned by the server env `HX_WORKSPACE_ORG_ID` on the Convex deployment (`resolveWorkspace` in `convex/lib/orgScope.ts`).
- An assignee you name must already be an agent in the workspace (`resolveAgentAssignee`).

## Choose one of three ways in

| Way | Address | Use it when |
| --- | --- | --- |
| REST | `http://192.168.50.218:3211/api/v1` | You call HTTP yourself. |
| MCP | `http://192.168.50.207:8460/mcp`, through HX-7 | Your client speaks MCP, such as Claude Code. |
| CLI | `pnpm citadel` in a checkout of this repository | You work from a shell or a git hook. |

MCP and the CLI both call the REST API through `CitadelApi` in `lib/citadel-api.ts`. The same rules and errors apply to all three.

## Call the REST API

The routes are in `convex/http.ts`, under `ISSUES_PATH` (`/api/v1/issues`). The request fields are the `args` of each mutation or query in `convex/agentApi.ts`.

| Method and path | Body or query | Response |
| --- | --- | --- |
| `GET /api/v1/issues?team=KEY` | Optional `status`. Optional `assignee`, an agent name or `me`. | `200 {issues}` |
| `GET /api/v1/issues/{key}` | none | `200 {issue, subtasks}` |
| `POST /api/v1/issues` | `teamKey`, `title`, and optional `description`, `kind`, `type`, `status`, `priority`, `parentKey`, `assignee` | `201 {issue}` |
| `PATCH /api/v1/issues/{key}` | Any of `status`, `assignee` (a name or `null`), `priority`, `title`, `description` | `200 {issue}` |
| `POST /api/v1/issues/{key}/subtasks` | `title`, optional `status` | `201 {issue}` |
| `POST /api/v1/issues/{key}/comments` | `body` | `201 {comment}` |
| `POST /api/v1/issues/{key}/proof` | `proofUrl` | `200 {issue}` |

An issue key is a story key such as `HX-12` or a sub-task key such as `HX-12.1` (`parseIssueKey` in `lib/issue-key.ts`). Epics and features have no display key, so their `key` is `null` (`hasDisplayKey`). The allowed values of `kind`, `type`, `status`, and `priority` are the validators in `convex/schema.ts`.

### Send the three headers

- `X-Agent-Id` names the agent. It is required on every route. Without it, the call fails with `400 actor_required`.
- `Idempotency-Key` is required on every write (`readIdempotencyKey` in `convex/lib/httpApi.ts`). The format is `KEY_PATTERN` in `convex/lib/idempotency.ts`: 1 to 200 visible ASCII characters. A repeat with the same key and the same request returns the stored result. The same key with a different request fails with `409 idempotency_key_reused`. Keys expire after `IDEMPOTENCY_TTL_MS`. An hourly cron in `convex/crons.ts` deletes expired keys.
- `If-Match` is optional on writes (`readIfMatch`). Send the issue version you last read, as `"2"` or `2`. If the issue changed since then, the write fails with `412 stale` (`assertIfMatch` in `convex/lib/issueVersion.ts`). Without `If-Match`, the server does not check the version.

Every response that returns one issue carries its version as the `ETag` header, such as `"3"` (`issueJson`). The body also has `issue.version`. Every change to an issue adds 1 to the version, and a write that changes nothing keeps it (`patchIssue`).

### Read an error

Every error is JSON: `{code, message}` (`toHttpError` in `convex/lib/httpApi.ts`). The status comes from three places in that file:

- The routes throw `HttpError` for `actor_required`, `idempotency_key_required`, and `validation` (400), and for `not_found` (404) on an unknown route.
- `TYPED_ERRORS` maps `stale` to 412 and `idempotency_key_reused` to 409.
- `ERROR_MAP` maps known messages to `validation` (400), `not_found` (404), and `server_error` (500). Any other refused write is `409 rule_refused` (`RULE_REFUSED`). Its `message` says which rule refused it and why.

## Connect through MCP

`app/mcp/route.ts` serves stateless JSON-RPC over `POST /mcp`. It has no sessions and no SSE. `/mcp` needs no Clerk sign-in (`PUBLIC_ROUTES` in `lib/public-routes.ts`), but it needs `X-Agent-Id`.

For Claude Code, add the server to `.mcp.json`. Use your own agent name:

```json
{
	"mcpServers": {
		"hx-citadel": {
			"type": "http",
			"url": "http://192.168.50.207:8460/mcp",
			"headers": { "X-Agent-Id": "your-agent-name" }
		}
	}
}
```

The tools are `MCP_TOOL` in `lib/mcp/tools.ts`, one REST call each. Every write tool takes `idempotencyKey`, which goes out as `Idempotency-Key`. The write tools that name an existing issue by `key` also take an optional `ifMatch`, which goes out as `If-Match`. A refusal comes back as a tool error (`isError`) with the REST `{code, message}` (`toolResult` in `lib/citadel-api.ts`).

## Use the CLI

Set two env variables, then run the commands from this repository:

```bash
export HX_CITADEL_API=http://192.168.50.218:3211
export HX_CITADEL_AGENT=your-agent-name
pnpm citadel --help
```

- `HX_CITADEL_API` is the REST base URL without `/api/v1`. If it is not set, the CLI uses `NEXT_PUBLIC_CONVEX_SITE_URL` (`connect` in `cli/commands.ts`).
- `--agent NAME` overrides `HX_CITADEL_AGENT`.
- The commands and their flags are `SPECS` in `cli/hx-citadel.ts`. `--help` prints them.
- The exit codes are `EXIT_CODES` in `cli/commands.ts`. `--help` prints them too. A refusal prints the REST `code: message` on stderr.

Each write sends a random `Idempotency-Key` unless you pass `--idempotency-key K`. Pass your own key when you retry a write, so the retry replays instead of writing twice.

Before a write to an existing issue, the CLI reads the issue and sends its version as `If-Match`. If another writer changed the issue in between, the CLI exits with the `stale` code. Run the command again. To skip the version check, pass `--no-if-match`.

## Install the push hook

The pre-push hook adds a comment to each story or sub-task that a pushed commit names. The code is in `cli/hook.ts`.

To install it in a repository, run:

```bash
pnpm citadel hook install --repo /path/to/repo
```

- The hook goes to `<repo>/.git/hooks/pre-push`, which every worktree of that repository shares (`hookPath` in `cli/git.ts`). If a hook is already there, the command refuses. Pass `--force` to replace it.
- The hook runs the CLI from this checkout. It reads `HX_CITADEL_API` and `HX_CITADEL_AGENT` from the environment of the `git push`.
- For each new commit, the hook finds the keys in the message as the tracker shows them (`storyKeys`). It posts `commit <short sha> <subject> <commit URL>` (`commentText`, `commitUrl`). A GitHub origin gives the commit URL.
- The idempotency key is `commit-<sha>-<key>` (`commitIdempotencyKey`), so a second push of the same commit adds no second comment.
- The hook never blocks a push. Every failure prints a warning and the push continues.

## Follow the rules agents meet

The server enforces these rules for people and agents alike. A broken rule returns `409 rule_refused` with a message that names it. The CLI exits with the `refused` code.

- **Levels.** An epic belongs to a project, a feature to an epic, a story to a feature or to nothing, and a sub-task to a story (`PARENT_KIND` in `lib/issue-key.ts`, `assertValidParent` in `convex/lib/rules/levels.ts`). A child takes its parent's team and project. An In Review or Done parent takes no new child (`assertParentOpen`).
- **One story In Progress per agent.** Each assignee has at most one story In Progress in the workspace. Sub-tasks, epics, and features do not count (`assertWipFree` in `convex/lib/rules/wip.ts`).
- **The Complete testing sub-task.** Every new story starts with a sub-task named `TESTING_SUBTASK_TITLE` as `KEY-n.1` (`convex/lib/rules/testing.ts`). That sub-task cannot be deleted or moved (`assertNotTestingSubtask`). Only that sub-task holds a proof URL (`assertTestingSubtask`). The proof must be an absolute `http://` or `https://` URL (`assertProofUrl`).
- **The Done gate.** A move to In Review or Done needs every direct child done or canceled. A story also needs a proof link on its Complete testing sub-task (`convex/lib/rules/doneGate.ts`). The refusal lists what is still open.

A refusal looks like this:

```json
{ "code": "rule_refused", "message": "Can't move HX-12 …" }
```

## Run the live checker

`scripts/live-check.ts` runs the steps in `STEPS` in `scripts/live-check/steps.ts` against the live REST API and the app. It acts as the agent `live-check` (`AGENT`).

```bash
export HX_CITADEL_API=http://192.168.50.218:3211
pnpm live-check -- --team LCK
```

- `--team` is required. Use the `LCK` team, which is kept for the checker.
- The app address is `HX_CITADEL_APP`. If it is not set, the checker uses `DEFAULT_APP` in `scripts/live-check.ts`.
- The checker checks the app, the MCP tool list, agent creation, idempotent replay, key reuse, a stale `If-Match`, the WIP refusal, and the Done gate.
- At the end, the `tidy-up` step cancels the issues the run created. The issues stay in `LCK` until you clear them. See "Clear test data" in `AGENTS.md`.

## Revert an agent's change (owner)

A workspace admin can undo one change from a story's activity log. The revert control is in `components/issue-detail/revert-change.tsx`. It calls `revertChange` in `convex/issues.ts`, which only admins can run (`orgAdminMutation`). A revert writes the old value back through `updateIssue` and logs one `reverted` row. A revert can undo a change to `title`, `status`, `priority`, or `assignee` (`REVERT_ARGS`).
