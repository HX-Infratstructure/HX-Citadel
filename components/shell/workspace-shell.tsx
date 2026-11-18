"use client";

import { useAuth, useOrganizationList } from "@clerk/nextjs";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { CommandProvider } from "@/components/commands/command-provider";
import { findHxMembership, HX_WORKSPACE_ORG_ID } from "@/lib/workspace";
import { AppSidebar } from "./app-sidebar";
import { FailedWithRetry } from "./failed-with-retry";
import {
  ACTIVATION_FAILED_MESSAGE,
  MEMBERSHIP_FAILED_MESSAGE,
  toHxWorkspace,
  type HxWorkspace,
} from "./hx-workspace";

export function FullScreenLoader({ label }: { label: string }) {
  return (
    <div className="flex h-dvh items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

const SYNC_VISIBLE_TIMEOUT_MS = 5_000;
const SYNC_FAILED_MESSAGE = "Couldn't sync your workspace from Clerk.";
const SYNC_NOT_VISIBLE_MESSAGE =
  "Your workspace is still not visible after syncing from Clerk.";
const SESSION_REJECTED_MESSAGE =
  "You're signed in, but the workspace server didn't accept the session.";

type SyncIssue = { key: string; message: string };

/** Loads every Clerk membership page and resolves the HX workspace. */
export function useHxWorkspace() {
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const {
    data,
    isLoading,
    isFetching,
    isError,
    hasNextPage,
    fetchNext,
    revalidate,
  } = userMemberships;

  useEffect(() => {
    if (hasNextPage && !isFetching) {
      fetchNext();
    }
  }, [hasNextPage, isFetching, fetchNext]);

  const membership = findHxMembership(data ?? [], HX_WORKSPACE_ORG_ID);
  const workspace = toHxWorkspace({
    membership,
    clerkLoaded: isLoaded,
    isLoading,
    isError,
    hasNextPage,
  });
  const retry = () => void revalidate?.();
  return { workspace, setActive, retry };
}

type ShellStep =
  | { kind: "wait"; target: null }
  | { kind: "activate"; target: string }
  | { kind: "redirect"; target: string };

/** The URL slug must be the HX slug; anything else goes back to the workspace. */
function shellStep(workspace: HxWorkspace, orgSlug: string): ShellStep {
  if (workspace.status === "loading" || workspace.status === "error") {
    return { kind: "wait", target: null };
  }
  if (workspace.status === "non-member") {
    return { kind: "redirect", target: "/onboarding" };
  }
  if (workspace.membership.slug === orgSlug) {
    return { kind: "activate", target: workspace.membership.orgId };
  }
  return { kind: "redirect", target: `/${workspace.membership.slug}` };
}

/**
 * Authenticated workspace shell.
 *
 * 1. Keeps the URL on the HX workspace slug and makes it the active Clerk org.
 * 2. Pulls the user + org docs from Clerk (mirror.syncCurrent) when they are
 *    missing, and waits for them before rendering, so org-scoped queries
 *    never throw during onboarding.
 */
export function WorkspaceShell({
  orgSlug,
  children,
}: {
  orgSlug: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const { workspace, setActive, retry } = useHxWorkspace();
  const { kind, target } = shellStep(workspace, orgSlug);
  const isLoaded = kind !== "wait";
  const [activateAttempt, setActivateAttempt] = useState(0);
  const [failedActivation, setFailedActivation] = useState<string | null>(
    null
  );
  const activationKey = `${target}:${activateAttempt}`;
  const retryActivation = () => setActivateAttempt((n) => n + 1);

  useEffect(() => {
    if (kind === "activate" && setActive) {
      void setActive({ organization: target }).catch(() =>
        setFailedActivation(activationKey)
      );
    }
    if (kind === "redirect") {
      router.replace(target);
    }
  }, [kind, target, setActive, router, activationKey]);

  const currentUser = useQuery(api.users.current);
  const currentOrg = useQuery(api.organizations.current);

  const { orgId } = useAuth();
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const syncCurrent = useAction(api.mirror.syncCurrent);
  const [syncAttempt, setSyncAttempt] = useState(0);
  const [syncIssue, setSyncIssue] = useState<SyncIssue | null>(null);
  const needsSync = currentUser === null || currentOrg === null;
  const syncKey = `${isAuthenticated}:${orgId ?? ""}:${syncAttempt}`;
  const retrySync = () => setSyncAttempt((n) => n + 1);
  // A rejected session needs a fresh Clerk token, which only a reload fetches.
  const reloadPage = () => window.location.reload();

  useEffect(() => {
    if (!isLoaded || !isAuthenticated || !needsSync) {
      return;
    }
    let cancelled = false;
    let notVisibleTimer: ReturnType<typeof setTimeout> | undefined;
    syncCurrent({}).then(
      () => {
        if (cancelled) {
          return;
        }
        notVisibleTimer = setTimeout(
          () => setSyncIssue({ key: syncKey, message: SYNC_NOT_VISIBLE_MESSAGE }),
          SYNC_VISIBLE_TIMEOUT_MS
        );
      },
      () => setSyncIssue({ key: syncKey, message: SYNC_FAILED_MESSAGE })
    );
    return () => {
      cancelled = true;
      clearTimeout(notVisibleTimer);
    };
  }, [isLoaded, isAuthenticated, needsSync, syncKey, syncCurrent]);

  if (workspace.status === "error") {
    return (
      <FailedWithRetry message={MEMBERSHIP_FAILED_MESSAGE} onRetry={retry} />
    );
  }

  if (kind === "activate" && failedActivation === activationKey) {
    return (
      <FailedWithRetry
        message={ACTIVATION_FAILED_MESSAGE}
        onRetry={retryActivation}
      />
    );
  }

  if (
    !isLoaded ||
    isAuthLoading ||
    (kind === "activate" && currentOrg === undefined)
  ) {
    return <FullScreenLoader label="Loading workspace…" />;
  }

  if (kind === "redirect") {
    return <FullScreenLoader label="Opening the HX workspace…" />;
  }

  if (needsSync && !isAuthLoading && !isAuthenticated) {
    return (
      <FailedWithRetry
        message={SESSION_REJECTED_MESSAGE}
        onRetry={reloadPage}
      />
    );
  }

  if (needsSync && syncIssue?.key === syncKey) {
    return <FailedWithRetry message={syncIssue.message} onRetry={retrySync} />;
  }

  // Clerk sync in flight. Convex queries are reactive, so this resolves by
  // itself once mirror.syncCurrent has written the user and org docs.
  if (needsSync) {
    return <FullScreenLoader label="Setting up your workspace…" />;
  }

  if (currentUser === undefined || currentOrg === undefined) {
    return <FullScreenLoader label="Loading workspace…" />;
  }

  if (currentOrg.slug !== orgSlug) {
    return <FullScreenLoader label="Switching organization…" />;
  }

  return (
    <CommandProvider>
      <div className="flex h-dvh overflow-hidden">
        <AppSidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </CommandProvider>
  );
}
