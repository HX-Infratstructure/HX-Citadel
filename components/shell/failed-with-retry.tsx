import { Button } from "@/components/ui/button";

export function FailedWithRetry({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center gap-3 px-6 text-sm text-muted-foreground">
      {message}
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </main>
  );
}
