# HX-Citadel agent guide

HX-Citadel is the HX team's work tracker for agentic and agile development, with one workspace for the HX team. It is built with Next.js 16 (App Router), Convex, Clerk, shadcn/ui, Tailwind 4 and pnpm.

## Architecture rules

- **Clerk is the source of truth** for users, organizations and memberships. Webhooks mirror them into the Convex `users`, `organizations` and `members` tables (`convex/http.ts` calls `convex/webhooks.ts`). Feature code never writes to those tables.
- **Every Convex function uses a wrapper** from `convex/lib/customFunctions.ts`:
  - `orgQuery` and `orgMutation` resolve `ctx.user`, `ctx.org` and `ctx.membership` through `getAuthContext` in `convex/lib/auth.ts`. The JWT `subject` selects the user by `clerkId`, the `org_id` claim selects the organization, and the caller must have a `members` row in it.
  - `orgAdminMutation` does the same and also requires `ctx.membership.role === "admin"`.
  - `authedQuery` and `authedMutation` require a signed-in user but no organization. Use them rarely.
  - A public `query` or `mutation` without a wrapper is forbidden, except the existing `users.current` and `organizations.current`.
- **Scope everything by `ctx.org._id`.** Filter every query by it, and check that any document you load by ID belongs to it. `getOrgIssue` in `convex/issues.ts` shows the pattern for issues.
- **Validators on args and returns** of every public function. Import the shared validators (`issueStatusValidator`, `issuePriorityValidator`, `memberRoleValidator` and the others) from `convex/schema.ts`. Reuse a shape that already exists, such as `issueShape` in `convex/issues.ts`.
- **Activity logging.** Every mutation that changes an issue calls `logActivity` from `convex/lib/activity.ts`.

## UI conventions

- Use the shadcn/ui components in `components/ui/` and lucide icons.
- Keep Linear-style density: small text and `h-7` or `h-9` rows.
- Dark theme is the default. `next-themes` provides light mode.
- Shared primitives live in `components/shared/`: `StatusIcon`, `PriorityIcon`, `UserAvatar`, `LabelChip` and the constants in `issue-meta.ts`.
- Register command-palette commands and single-key shortcuts in `components/commands/registry.ts`. Register issue detail panels in `components/issue-detail/slots.tsx`.

## Routes

- Workspace routes live under `app/(app)/[orgSlug]/`: the home page, `team/[teamId]` and its `board`, `issue/[issueId]`, `projects` and `projects/[projectId]`, `cycles` and `cycles/[cycleId]`, `search` and `settings` with `members`.
- Read the slug with `useParams<{ orgSlug: string }>()`.
- `components/shell/workspace-shell.tsx` makes sure the user and organization are synced before a workspace page renders.
- Sign-in, sign-up and onboarding live under `app/sign-in`, `app/sign-up` and `app/onboarding`.
- There is one workspace, pinned by `NEXT_PUBLIC_HX_WORKSPACE_ORG_ID` (read in `lib/workspace.ts`). Onboarding only routes members into it or explains how to get an invitation.

## Code standards

The owner set these rules on 2026-11-17.

1. **Reuse before you write.** Search for an existing validator, constant, helper or rule, and use it.
2. **One home per rule.** Define each rule or constant in one place. Docs link to it and do not restate it.
3. **Refuse bad input with a clear error, never a crash.** In Convex, validate with `v.*` validators.
4. **Follow a changed value to every consumer.**
5. **Keep code flat.** No nested ternaries. Do not change arguments in place.
6. **Prove it end to end before every push.**
7. **Report against this list.** Each hand-back says how the diff meets each rule.

## HX operations

- Convex is self-hosted on HX-18 as `hx-convex`. The API is `http://192.168.50.218:3210`, HTTP actions are on port `3211`, and the data is in HX-9 PostgreSQL.
- Clerk is the development instance `intent-anemone-3074`, with the JWT template `convex`. The template adds the `org_id`, `org_slug` and `org_role` claims.
- Keys live in `~/.config/hx-citadel/*.env`. Never print them. Always source them with output suppressed.
- Never start Next on the literal `127.0.0.1`. Use `localhost` or the LAN address.
- pnpm is pinned by `packageManager` in `package.json`. Add no pnpm release-age exclusions.
- Demo data is dev-only. Seed an empty development workspace with `pnpm seed:demo '{"clerkOrgId":"…","clerkUserId":"…"}'` (`convex/seed.ts`). Never seed from the UI or from a build or deploy.

## Verifying your work

```bash
pnpm test               # Convex function tests (vitest + convex-test)
pnpm lint
pnpm build              # before tsc: tsc reads .next/types from the last build
pnpm exec tsc --noEmit
```

Convex function tests live next to the function as `convex/<module>.test.ts`. `convex/issues.test.ts` shows the setup.

## Reference

- Design doc: `docs/specs/2026-06-12-linear-clone-design.md`.
