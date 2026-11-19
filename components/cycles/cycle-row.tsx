"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { formatDateRange } from "@/components/projects/dates";
import { RowProgress } from "@/components/projects/row-progress";
import { cycleDisplayName, cycleStatus } from "./cycle-meta";
import { CycleStatusBadge } from "./cycle-status-badge";

export function CycleRow({ cycle }: { cycle: Doc<"cycles"> }) {
  const params = useParams<{ orgSlug: string }>();
  const progress = useQuery(api.cycles.progress, { cycleId: cycle._id });
  const status = cycleStatus(cycle);

  return (
    <Link
      href={`/${params.orgSlug}/cycles/${cycle._id}`}
      className="group flex h-11 items-center gap-3 border-b px-4 text-sm transition-colors hover:bg-accent/50"
    >
      <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">
        C{cycle.number}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">
        {cycleDisplayName(cycle)}
      </span>
      <CycleStatusBadge status={status} className="shrink-0" />
      <span className="hidden w-32 shrink-0 text-right text-xs text-muted-foreground sm:block">
        {formatDateRange(cycle.startDate, cycle.endDate)}
      </span>
      <RowProgress progress={progress} countClassName="lg:block" />
    </Link>
  );
}
