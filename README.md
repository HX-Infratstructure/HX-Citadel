# HX-Citadel

HX-Citadel is the HX team's work tracker for agentic and agile development.

It has one workspace, the HX team. People join by Clerk invitation from **Settings** > **Members**. There is no billing, no plans, no AI sidekick, and no public marketing site.

## What it does

The workspace routes live under `app/(app)/[orgSlug]/`:

- issues, with comments, labels, relations, and an activity log;
- team boards with drag and drop (`team/[teamId]/board`);
- projects and cycles;
- search;
- live presence on an open issue (`@convex-dev/presence`);
- settings and members.

## Stack

- Next.js 16 (App Router) and React 19
- Clerk for sign-in, the organization, and members
- Convex, self-hosted
- Tailwind 4 and shadcn/ui
- pnpm through corepack, pinned by `packageManager` in `package.json`
- Vitest with `convex-test`

`package.json` holds the exact versions.

## Where it runs

- Convex runs self-hosted as the `hx-convex` systemd service on HX-18. The client API is on port 3210. The HTTP actions, including the REST API, are on port 3211. The data is in PostgreSQL on HX-9.
- The `hx-citadel` systemd user service on HX-15 serves the app on `192.168.50.215:5460`.
- HX-7 routes `http://192.168.50.207:8460` to the app.
- Each release is checked live with a request to port 8460 and a request to port 3211.
- Nothing runs in Docker.

## Settings

Local settings live in `~/.config/hx-citadel/`. Every file is mode 600. Never print a value. Source a file with its output suppressed:

```bash
set -a; . ~/.config/hx-citadel/app-public.env >/dev/null 2>&1; set +a
```

The folder holds four files:

| File | Holds |
| --- | --- |
| `app-public.env` | Public build settings, including `NEXT_PUBLIC_HX_WORKSPACE_ORG_ID` |
| `clerk.env` | Clerk keys, including `CLERK_SECRET_KEY` |
| `convex-admin.env` | The URL and admin key for the self-hosted Convex deployment (`CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`) |
| `convex-db.env` | The PostgreSQL connection for `hx-convex` on HX-18 (`POSTGRES_URL`); used only to install that service |

The code reads these variables:

| Variable | Read by |
| --- | --- |
| `NEXT_PUBLIC_CONVEX_URL` | `components/providers.tsx` |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | `lib/citadel-api.ts` and `cli/commands.ts`. It is the Convex HTTP actions URL. `/mcp` reads it on each call as the REST base URL, so the running app needs it. If it is missing, every MCP tool call fails with an error that names it. For the CLI, see [Use the CLI](docs/AGENT-API.md#use-the-cli). |
| `NEXT_PUBLIC_HX_WORKSPACE_ORG_ID` | `lib/workspace.ts`. It pins the one workspace. If it is missing, the app fails with an error that names it. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `@clerk/nextjs` |
| `CLERK_SECRET_KEY` | `@clerk/nextjs` and `convex/mirror.ts` |
| `CLERK_WEBHOOK_SECRET` | `convex/http.ts` |
| `CLERK_FRONTEND_API_URL` | `convex/auth.config.ts` |
| `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` | The Convex CLI |
| `HX_WORKSPACE_ORG_ID` | `convex/lib/orgScope.ts`, on the Convex deployment. It pins the workspace for agent calls. |
| `HX_CITADEL_API` and `HX_CITADEL_AGENT` | The CLI (`cli/commands.ts`): the REST base URL and the agent name |
| `HX_CITADEL_APP` | The live checker (`scripts/live-check.ts`): the app URL |

Convex functions read their variables from the deployment's environment. Set them with `npx convex env set`.

## Clerk sync

Clerk is the source of truth for users, the organization, and members. Convex keeps a mirror of them.

Clerk can't reach the LAN, so its webhooks don't arrive. The route `/clerk-webhook` in `convex/http.ts` exists but gets no traffic. Two other paths keep the mirror current:

- On each workspace page, `components/shell/workspace-shell.tsx` checks that the mirror has three records: the signed-in person, the active organization, and the person's membership in it. The shell calls `mirror:syncCurrent` only when one of them is missing. `mirror:syncCurrent` pulls the person's Clerk records into the mirror. If all three records exist, sign-in does not refresh them.
- Every hour, at minute 7 UTC, a cron in `convex/crons.ts` runs `mirror:reconcileAll`. It reconciles everyone, so deletions and role changes made in Clerk reach the mirror.

## Commands

Install and check the code in this order. Run the build before `tsc`, because `pnpm exec tsc --noEmit` reads `.next/types` from the last build.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm build
pnpm exec tsc --noEmit
pnpm exec tsc -p convex --noEmit
```

`pnpm test` runs the Convex function tests. Each test sits next to its function as `convex/<module>.test.ts`.

`pnpm lint` fails on any warning as well as any error.

With ESLint 9.39.4, editors show the violations listed in `eslint-suppressions.json` as errors, because only the `eslint` command reads that file. `pnpm lint` is the check.

Run `pnpm exec eslint --prune-suppressions` from the repository root in two cases:

- after you fix a violation listed in `eslint-suppressions.json`;
- after you delete a file listed there.

A moved file loses its entries. In the same change, bring the moved file within the limits in `eslint.config.mjs`. Then prune to remove the old path's entry.

Prune only when `pnpm lint` shows no error except ESLint's advice to prune. A parse error stops ESLint from linting the file, so ESLint advises a prune that would delete the file's real entries. To undo a wrong prune, run `git checkout -- eslint-suppressions.json`.

With `-p convex`, `tsc` runs the same type check as `npx convex deploy`.

To generate types and deploy the Convex functions, first load `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` from `convex-admin.env`. Then run:

```bash
npx convex codegen
npx convex deploy
```

To start Next in development, bind it to `localhost` or the LAN address:

```bash
pnpm exec next dev -H localhost
```

Never start Next on the literal `127.0.0.1`. `AGENTS.md` sets this rule.

### Demo data

Demo data is for development only. `pnpm seed:demo` runs `seed:demoData` in `convex/seed.ts`. It takes the Clerk organization ID and the Clerk user ID, and both must already be synced to Convex:

```bash
pnpm seed:demo '{"clerkOrgId":"…","clerkUserId":"…"}'
```

Never seed from the UI, a build, or a deploy.

### Agent CLI and live checker

`pnpm citadel` runs the agent CLI in `cli/hx-citadel.ts`. `pnpm live-check -- --team LCK` runs the live checks in `scripts/live-check.ts`. `docs/AGENT-API.md` explains both.

## Key folders

| Folder | Contents |
| --- | --- |
| `app/` | Routes. Workspace pages are under `app/(app)/[orgSlug]/`. Sign-in, sign-up, and onboarding are in `app/sign-in`, `app/sign-up`, and `app/onboarding`. |
| `components/` | UI by feature. `components/ui/` holds the shadcn/ui components, `components/shared/` the shared primitives, and `components/shell/` the workspace shell. |
| `convex/` | Schema, functions, tests, the crons (an hourly Clerk mirror reconcile and an hourly idempotency-key expiry, in `convex/crons.ts`), the HTTP routes, and the Clerk mirror. `convex/lib/` holds the auth wrappers and helpers. |
| `app/mcp/` | The MCP endpoint `/mcp` for agents. |
| `cli/` | The agent CLI and the git pre-push hook. |
| `scripts/` | The live checker. |
| `lib/` | `workspace.ts` for the pinned workspace, `utils.ts`, and `citadel-api.ts`, the REST client the CLI and MCP share. |
| `lib/mcp/` | The MCP tools. |
| `docs/specs/` | The design doc. |

## For agents

Read `AGENTS.md` before you change code. It holds the architecture rules, the code standards, and the HX operations notes.

To read and write issues as an agent, through REST, MCP, or the CLI, read `docs/AGENT-API.md`.

## Credit and license

HX-Citadel started as a fork of [sonnysangha/linear-clone-clerk-nextjs-16](https://github.com/sonnysangha/linear-clone-clerk-nextjs-16). That project is shared under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). The owner uses HX-Citadel for personal, non-commercial use.
