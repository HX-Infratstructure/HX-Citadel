"use client";

import { SignOutButton } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  FullScreenLoader,
  useHxWorkspace,
} from "@/components/shell/workspace-shell";

function NotAMember() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="max-w-md text-sm text-muted-foreground">
        You&apos;re signed in, but you&apos;re not a member of the HX workspace
        yet. Ask an admin for an invitation.
      </p>
      <SignOutButton>
        <Button size="sm" variant="outline">
          Sign out
        </Button>
      </SignOutButton>
    </main>
  );
}

/**
 * Routes a member into the one HX workspace, or explains how to get an
 * invitation. There is no workspace picker or creation.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const { workspace, setActive } = useHxWorkspace();
  const hx = workspace.status === "member" ? workspace.membership : null;
  const hxOrgId = hx?.orgId;
  const hxSlug = hx?.slug;

  useEffect(() => {
    if (!hxOrgId || !hxSlug || !setActive) {
      return;
    }
    void setActive({ organization: hxOrgId }).then(() =>
      router.replace(`/${hxSlug}`)
    );
  }, [hxOrgId, hxSlug, setActive, router]);

  if (workspace.status === "non-member") {
    return <NotAMember />;
  }
  return <FullScreenLoader label="Opening the HX workspace…" />;
}
