"use client";

import { useAuth, useOrganizationList } from "@clerk/nextjs";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { CommandProvider } from "@/components/commands/command-provider";
import { Button } from "@/components/ui/button";
import { AppSidebar } from "./app-sidebar";

function FullScreenLoader({ label }: { label: string }) {
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

function SyncFailed({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-dvh items-center justify-center gap-3 text-sm text-muted-foreground">
      {message}
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * Authenticated workspace shell.
 *
 * 1. Makes sure the Clerk active org matches the org slug in the URL.
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
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  const targetMembership = userMemberships.data?.find(
    (m) => m.organization.slug === orgSlug
  );
  const needsSwitch = isLoaded && targetMembership !== undefined;

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    if (targetMembership) {
      void setActive({ organization: targetMembership.organization.id });
    } else if (!userMemberships.isLoading && !userMemberships.hasNextPage) {
      // The user doesn't belong to an org with this slug.
      router.replace("/onboarding");
    }
  }, [
    isLoaded,
    targetMembership,
    userMemberships.isLoading,
    userMemberships.hasNextPage,
    setActive,
    router,
  ]);

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

  if (!isLoaded || isAuthLoading || (needsSwitch && currentOrg === undefined)) {
    return <FullScreenLoader label="Loading workspace…" />;
  }

  if (needsSync && !isAuthLoading && !isAuthenticated) {
    return <SyncFailed message={SESSION_REJECTED_MESSAGE} onRetry={reloadPage} />;
  }

  if (needsSync && syncIssue?.key === syncKey) {
    return <SyncFailed message={syncIssue.message} onRetry={retrySync} />;
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
