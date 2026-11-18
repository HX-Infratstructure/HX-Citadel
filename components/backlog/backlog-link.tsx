import { ListOrdered } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function BacklogLink({
  orgSlug,
  teamId,
}: {
  orgSlug: string;
  teamId: string;
}) {
  return (
    <Button asChild size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs">
      <Link href={`/${orgSlug}/team/${teamId}/backlog`}>
        <ListOrdered className="size-3.5" />
        Backlog
      </Link>
    </Button>
  );
}
