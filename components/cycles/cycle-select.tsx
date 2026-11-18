"use client";

import { Doc, Id } from "@/convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cycleDisplayName, isCurrentCycle } from "@/components/cycles/cycle-meta";

const NONE = "none";

/** Picks one of a team's cycles; the first item, `noneLabel`, clears it. */
export function CycleSelect({
  cycles,
  value,
  noneLabel,
  onChange,
}: {
  cycles: Doc<"cycles">[] | undefined;
  value: Id<"cycles"> | undefined;
  noneLabel: string;
  onChange: (cycleId: Id<"cycles"> | null) => void;
}) {
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(next) =>
        onChange(next === NONE ? null : (next as Id<"cycles">))
      }
    >
      <SelectTrigger size="sm" className="w-36 gap-1.5 border-none shadow-none">
        <SelectValue placeholder={noneLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          <span className="text-muted-foreground">{noneLabel}</span>
        </SelectItem>
        {cycles?.map((cycle) => (
          <SelectItem key={cycle._id} value={cycle._id}>
            {cycleDisplayName(cycle)}
            {isCurrentCycle(cycle) && (
              <span className="text-xs text-emerald-500">Current</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
