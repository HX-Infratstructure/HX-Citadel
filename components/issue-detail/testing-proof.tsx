"use client";

import { useMutation } from "convex/react";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

/** The Complete testing sub-task's badge and proof link, which the Done gate reads. */
export function TestingProof({ issue }: { issue: Doc<"issues"> }) {
  const setProof = useMutation(api.issues.setProof);
  const [proofUrl, setProofUrl] = useState(issue.proofUrl ?? "");

  const saveProof = () => {
    const trimmed = proofUrl.trim();
    if (trimmed === (issue.proofUrl ?? "")) {
      return;
    }
    setProof({ issueId: issue._id, proofUrl: trimmed }).catch((error: unknown) => {
      setProofUrl(issue.proofUrl ?? "");
      toast.error(error instanceof Error ? error.message : "Failed to save proof");
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
        value={proofUrl}
        placeholder="https://… (Enter to save)"
        onChange={(e) => setProofUrl(e.target.value)}
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
