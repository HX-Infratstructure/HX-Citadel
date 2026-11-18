"use client";

import { errorMessage } from "@/lib/error-message";
import { useMutation } from "convex/react";
import { ExternalLink } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { proofToSend } from "./proof-to-send";

/** The Complete testing sub-task's badge and proof link, which the Done gate reads. */
export function TestingProof({ issue }: { issue: Doc<"issues"> }) {
  const setProof = useMutation(api.issues.setProof);
  const savedUrl = issue.proofUrl ?? "";
  // null until the user edits, so the input follows the saved proof, including a save from another tab.
  const [draft, setDraft] = useState<string | null>(null);
  const inFlightUrl = useRef<string | null>(null);

  const saveProof = () => {
    if (draft === null) {
      return;
    }
    const blur = proofToSend(draft, savedUrl, inFlightUrl.current);
    if (blur.kind === "saved") {
      setDraft(null);
    }
    if (blur.kind !== "send") {
      return;
    }
    const { proofUrl } = blur;
    inFlightUrl.current = proofUrl;
    setProof({ issueId: issue._id, proofUrl })
      .then(() => setDraft((current) => (current === draft ? null : current)))
      .catch((error: unknown) => {
        toast.error(errorMessage(error, "Failed to save proof"));
      })
      .finally(() => {
        if (inFlightUrl.current === proofUrl) {
          inFlightUrl.current = null;
        }
      });
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">Testing</Badge>
        <h3 className="text-xs font-medium text-muted-foreground">Proof</h3>
        {issue.proofUrl && (
          <a
            href={issue.proofUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open proof"
            className="text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      <Input
        type="url"
        value={draft ?? savedUrl}
        placeholder="https://… (Enter to save)"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={saveProof}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className="h-8 text-sm"
      />
    </section>
  );
}
