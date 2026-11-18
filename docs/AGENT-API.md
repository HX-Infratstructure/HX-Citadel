# Connect an agent to HX-Citadel

This guide shows agents, CC1, CC2, and the owner how to read and write HX-Citadel issues. Each value has one home in the code. This page names that file and constant instead of copying long lists.

## Pick an agent name

An agent has no key. It sends its name in the `X-Agent-Id` header on every call (`AGENT_HEADER` in `lib/api-contract.ts`, `readAgentId` in `convex/lib/httpApi.ts`). The server does not authenticate the caller: any caller that names an agent in `X-Agent-Id` acts as that agent. The network is the only boundary. The REST and MCP addresses in [Choose one of three ways in](#choose-one-of-three-ways-in) are private HX LAN addresses, and nothing in this repo limits which host calls them. Name-only identity follows the owner's rule for DEV/TEST work, reaffirmed for this tracker on 2026-11-18: no security hardening.

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
| `GET /api/v1/issues?team=KEY` | Optional `status`. Optional `assignee`, an agent name or `me`. Optional `cursor`, the `nextCursor` of the previous page. | `200 {issues, nextCursor}` |
| `GET /api/v1/issues/{key}` | none | `200 {issue, subtasks}` |
| `POST /api/v1/issues` | `title`, and `teamKey`, `parentKey`, or both. Optional `description`, `kind`, `type`, `status`, `priority`, `assignee` | `201 {issue}` |
| `PATCH /api/v1/issues/{key}` | Any of `status`, `assignee` (a name or `null`), `priority`, `title`, `description` | `200 {issue}` |
| `POST /api/v1/issues/{key}/subtasks` | `title`, optional `status` | `201 {issue}` |
| `POST /api/v1/issues/{key}/comments` | `body` | `201 {comment}` |
| `POST /api/v1/issues/{key}/proof` | `proofUrl` | `200 {issue}` |
| `POST /api/v1/issues/{key}/decisions` | `question`, optional `choices` and `recommended` | `201 {decision}` |
| `GET /api/v1/issues/{key}/decisions` | none | `200 {decisions}` |

A create with `parentKey` and no `teamKey` takes the parent's team ([Levels](#follow-the-rules-agents-meet)). A create with neither fails with `400 validation` (`createIssue` in `convex/agentApi.ts`).

A decision asks the owner a question about a story. The limits on the question and the choices are in `convex/lib/decisions.ts`. No route answers a decision, so an agent can't answer its own.

The list returns one page, newest first. A page holds up to 500 issues (`LIST_LIMIT` in `convex/issues.ts`). To get the next page:

1. Read `nextCursor` from the response. If it is `null`, there are no more pages.
2. Send the same request again, with the same `team`, `status` and `assignee`, and add `cursor=<nextCursor>`. URL-encode the cursor.
3. Repeat until `nextCursor` is `null`. A page can be empty and still have a `nextCursor`.

An empty `cursor` fails with `400 validation`. So does a `cursor` that Convex rejects as invalid (`pageFailure` in `convex/agentApi.ts`). Any other failure is `500 server_error`. The MCP tool `list_issues` takes the same `cursor`, and the CLI takes `pnpm citadel list --team KEY --cursor <nextCursor>`. Both return `nextCursor` in the JSON body.

An issue key is a story key such as `CIT-12` or a sub-task key such as `CIT-12.1` (`parseIssueKey` in `lib/issue-key.ts`). Each story keeps its own sub-task counter, so once a story has its counter, the key of a moved or deleted sub-task is never handed out again (`nextSubNumber` in `convex/lib/rules/levels.ts`). A request for that old key returns `404 not_found`. Every story this code creates starts with the counter. A story without one, such as a story created before the counter existed, gets it on its next new sub-task, set after its highest sub-task. So a key that a sub-task gave up before then can be handed out once more. Keys and `If-Match` versions are valid only for the life of their team. For what to do after a team clear, see [Clear test data](../AGENTS.md#clear-test-data) in `AGENTS.md`. Epics and features have no display key, so their `key` is `null` (`hasDisplayKey`). The allowed values of `kind`, `type`, `status`, and `priority` are the validators in `convex/schema.ts`.

### Send the three headers

- `X-Agent-Id` names the agent. It is required on every route. Without it, the call fails with `400 actor_required`.
- `Idempotency-Key` is required on every write (`readIdempotencyKey` in `convex/lib/httpApi.ts`). The format is `KEY_PATTERN` in `convex/lib/idempotency.ts`: 1 to 200 visible ASCII characters.
  - A repeat from the same agent with the same key and the same request returns the stored result. The request is the method, the path, and the body (`hashRequest`). `If-Match` is not part of it, so a repeat with a different `If-Match` still returns the stored result.
  - The same key from another agent, or with a different request, fails with `409 idempotency_key_reused`.
  - The server keeps a key for at least 24 hours (`IDEMPOTENCY_TTL_MS`). After that, an hourly cron in `convex/crons.ts` deletes it. A request with the same key and body then writes again.
  - If a write commits but you lose its response, retry with the same key and the same body. Use the key the CLI printed on stderr, or a key you chose before the first attempt. A request with a new key writes again, so a retried create can make a second story.
- `If-Match` is optional on writes (`readIfMatch`). Send the issue version you last read, as `"2"` or `2`. If the issue changed since then, the write fails with `412 stale` (`assertIfMatch` in `convex/lib/issueVersion.ts`). Without `If-Match`, the server does not check the version.
  - On a create (`POST /api/v1/issues`), `If-Match` is the version of the `parentKey` issue. A create with `If-Match` but no `parentKey` fails with `400 validation` (`createIssue` in `convex/agentApi.ts`).

Every response that returns one issue carries its version as the `ETag` header, such as `"3"` (`issueJson`). The body also has `issue.version`. A change to an issue adds 1 to the version unless it changes only bookkeeping fields (`BOOKKEEPING_FIELDS` in `convex/lib/issueVersion.ts`), and a write that changes nothing keeps it (`patchIssue`).

### Read an error

Every error is JSON: `{code, message}` (`toHttpError` in `convex/lib/httpApi.ts`). Every code and its HTTP status are in `ERROR_STATUS` in `lib/api-contract.ts`. `toHttpError` finds the code like this:

- The routes throw `HttpError` with a code before any Convex function runs, such as `actor_required` for a missing `X-Agent-Id`, `idempotency_key_required` for a write without `Idempotency-Key`, and `not_found` for an unknown route.
- A Convex function refuses with a typed error that carries its code (`refusal` in `convex/lib/refusals.ts`). In that file, `invalid` throws `validation`, `notFound` throws `not_found`, and `refuse` throws `rule_refused`. The `message` is the server's own words. A rule refusal says which rule refused the write and why. A missing or unmatched `HX_WORKSPACE_ORG_ID` setting is a typed `500 server_error` that names the setting (`resolveWorkspace` in `convex/lib/orgScope.ts`).
- Convex's argument validator throws an error with no code. `toHttpError` recognizes only this error by its words (`VALIDATOR_LINE`): `ArgumentValidationError` or `Validator error` is `400 validation`.
- Any other error is a bug, not a rule: `500 server_error` with the message `Internal error`. An error is in this group even when its message says "not found" or "invalid". The server logs the real error.

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

The tools are `MCP_TOOL` in `lib/mcp/tools.ts`, one REST call each. Every write tool takes `idempotencyKey`, which goes out as `Idempotency-Key`. `create_issue` and the write tools that name an existing issue by `key` also take an optional `ifMatch`, which goes out as `If-Match`. Like REST, `create_issue` takes `teamKey`, `parentKey`, or both. With neither, the tool refuses before any REST call. A refusal comes back as a tool error (`isError`) with the REST `{code, message}` (`toolResult` in `lib/citadel-api.ts`).

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

Each write sends a random `Idempotency-Key` unless you pass `--idempotency-key K`. The CLI prints the key it sends on stderr as `Idempotency-Key: K` (`idempotencyKey` in `cli/commands.ts`). To retry a write whose response you lost, run the same command with `--idempotency-key` set to that key. The rules for a retry are in [Send the three headers](#send-the-three-headers).

Before a write to an existing issue, the CLI reads the issue and sends its version as `If-Match`. `create --parent KEY` reads the parent the same way. `create` takes `--team KEY`, `--parent KEY`, or both. With neither, the CLI exits with the `usage` code and sends nothing. If another writer changed the issue in between, the CLI exits with the `stale` code. Run the command again. To skip the version check, pass `--no-if-match`.

## Install the push hook

The pre-push hook adds a comment to each story or sub-task that a pushed commit names. The code is in `cli/hook.ts`.

To install it in a repository, run:

```bash
pnpm citadel hook install --repo /path/to/repo
```

- The hook goes to `pre-push` in the folder Git runs hooks from. That is `core.hooksPath` when it is set, otherwise `<repo>/.git/hooks`. Every worktree of that repository shares it (`hookPath` in `cli/git.ts`). A `core.hooksPath` in the global Git config points every repository at one folder, so the hook then runs on a push from any of them. If a hook is already there, the command refuses. Pass `--force` to replace it.
- The hook runs the CLI from this checkout. It reads `HX_CITADEL_API` and `HX_CITADEL_AGENT` from the environment of the `git push`.
- For each new commit, the hook finds the keys in the message as the tracker shows them (`storyKeys`). It posts `commit <short sha> <subject> <commit URL>` (`commentText`, `commitUrl`). `commitUrl` builds it from the URL Git is pushing to, or from `origin` when Git passes none.
- The hook does not check what a key means. It posts to each key it finds. If that team and that issue exist, the comment lands on the issue. Otherwise the hook prints a warning. HX host names, such as `HX-18`, have the shape of a key. So never give a team the key `HX`: a commit that names the host `HX-18` would comment on the story `HX-18`.
- The hook posts when the push starts, before the remote accepts it. If the remote then rejects the push, the comments stay.
- The idempotency key is `commit-<sha>-<key>` (`commitIdempotencyKey`), so a second push of the same commit inside the [idempotency window](#send-the-three-headers) adds no second comment.
- The hook never blocks a push. It waits at most 5 seconds in total for the tracker (`HOOK_DEADLINE_MS`). It prints a warning for each comment it could not post and for any other failure. The push continues.

## Follow the rules agents meet

The server enforces these rules for people and agents alike. A broken rule returns `409 rule_refused` with a message that names it. The CLI exits with the `refused` code.

- **Levels.** An epic belongs to a project, a feature to an epic, a story to a feature or to nothing, and a sub-task to a story (`PARENT_KIND` in `lib/issue-key.ts`, `assertValidParent` in `convex/lib/rules/levels.ts`). A child takes its parent's team and project. An In Review or Done parent takes no new child (`assertParentOpen`).
- **One story In Progress per agent.** Each assignee has at most one story In Progress in the workspace. Sub-tasks, epics, and features do not count (`assertWipFree` in `convex/lib/rules/wip.ts`).
- **The Complete testing sub-task.** Every new story starts with a sub-task named `TESTING_SUBTASK_TITLE` as `KEY-n.1` (`convex/lib/rules/testing.ts`). That sub-task cannot be deleted or moved (`assertNotTestingSubtask`). Only that sub-task holds a proof URL (`assertTestingSubtask`). A proof that is not an absolute `http://` or `https://` URL fails with `400 validation`, not `409 rule_refused` (`assertProofUrl`).
- **The Done gate.** A move to In Review or Done needs every direct child done or canceled. A story also needs a proof link on its Complete testing sub-task (`convex/lib/rules/doneGate.ts`). The refusal lists what is still open.

A refusal looks like this:

```json
{ "code": "rule_refused", "message": "Can't move CIT-12 …" }
```

## Run the live checker

`scripts/live-check.ts` runs the steps in `STEPS` in `scripts/live-check/steps.ts` against the live REST API and the app. It acts as the agent `live-check` (`AGENT`).

```bash
export HX_CITADEL_API=http://192.168.50.218:3211
pnpm live-check -- --team LCK
```

- `--team` is required. Use the `LCK` team, which is kept for the checker.
- Run one checker at a time. Every run acts as the agent `live-check`, and that agent can have only one story In Progress ([One story In Progress per agent](#follow-the-rules-agents-meet)). If two runs overlap, the server refuses one run's move to In Progress, and that run fails.
- The app address is `HX_CITADEL_APP`. If it is not set, the checker uses `DEFAULT_APP` in `scripts/live-check.ts`.
- The checker checks the app, the MCP tool list, agent creation, idempotent replay, key reuse, a stale `If-Match`, the WIP refusal, and the Done gate.
- At the end, the `tidy-up` step cancels the issues the run created. The issues stay in `LCK` until you clear them. See "Clear test data" in `AGENTS.md`.

## Revert an agent's change (owner)

A workspace admin can undo one change from a story's activity log. The revert control is in `components/issue-detail/revert-change.tsx`. It calls `revertChange` in `convex/issues.ts`, which only admins can run (`orgAdminMutation`). A revert writes the old value back through `updateIssue` and logs one `reverted` row. A revert can undo a change to `title`, `status`, `priority`, or `assignee` (`REVERT_ARGS`). It undoes only the latest change to a field. If the field changed after the change you pick, `revertChange` refuses with `<key> <field> has changed since; revert the latest change instead`. A `reverted` row can't itself be reverted (`revertRefusal`). To redo a change, make it again. A revert to an assignee who is no longer a workspace member is refused, and the assignee stays as it is (`assertAssignee`).
