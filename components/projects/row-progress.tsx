import { cn } from "@/lib/utils";
import { EMPTY_PROGRESS, IssueProgress } from "./project-meta";
import { IssueProgressBar } from "./progress-bar";

export function activeIssueLabel(progress: IssueProgress | undefined): string {
  if (progress === undefined) {
    return "—";
  }
  const active = progress.total - progress.canceled;
  return active === 1 ? "1 issue" : `${active} issues`;
}

export function RowProgress({
  progress,
  countClassName,
}: {
  progress: IssueProgress | undefined;
  countClassName: string;
}) {
  return (
    <>
      <span className={cn("hidden w-16 shrink-0 text-right text-xs text-muted-foreground", countClassName)}>
        {activeIssueLabel(progress)}
      </span>
      <IssueProgressBar
        progress={progress ?? EMPTY_PROGRESS}
        showPercent={progress !== undefined}
        className="hidden w-44 shrink-0 md:flex"
      />
    </>
  );
}
