"use client";

import { errorMessage } from "@/lib/error-message";
import { statusesFor } from "@/lib/issue-status";
import { missingPlacement } from "@/lib/level-placement";
import { useMutation, useQuery } from "convex/react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  IssuePriority,
  IssueStatus,
  PRIORITIES,
  STATUSES,
} from "@/components/shared/issue-meta";
import { PriorityIcon } from "@/components/shared/priority-icon";
import { StatusIcon } from "@/components/shared/status-icon";
import {
  DEFAULT_LEVEL,
  LevelChoice,
  LevelPickers,
  levelFields,
} from "@/components/issues/create-issue-level";
import {
  createIssueOutcome,
  IssueDraft,
} from "@/components/issues/create-issue-outcome";

export function CreateIssueDialog({
  open,
  onOpenChange,
  defaultTeamId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTeamId?: Id<"teams">;
}) {
  const params = useParams<{ orgSlug?: string }>();
  const router = useRouter();
  const teams = useQuery(api.teams.list, open ? {} : "skip");
  const createIssue = useMutation(api.issues.create);

  const [selectedTeamId, setSelectedTeamId] = useState<
    Id<"teams"> | undefined
  >(undefined);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<IssueStatus>("todo");
  const [priority, setPriority] = useState<IssuePriority>("none");
  const [level, setLevel] = useState<LevelChoice>(DEFAULT_LEVEL);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const session = useRef(0);
  const draft: IssueDraft = {
    title,
    description,
    status,
    priority,
    level: levelFields(level),
  };
  // handleSubmit closes over the draft it submitted; the resolved create compares
  // it with this latest committed draft to tell whether the user changed the form.
  const currentDraft = useRef(draft);

  useEffect(() => {
    session.current += 1;
  }, [open]);

  // A layout effect runs during commit, so the ref never lags a rendered edit
  // when the create resolves before passive effects flush.
  useLayoutEffect(() => {
    currentDraft.current = draft;
  });

  // Fall back to the default/first team without needing an effect.
  const teamId = selectedTeamId ?? defaultTeamId ?? teams?.[0]?._id;
  const offeredStatuses = statusesFor(STATUSES, level.kind);
  const canSubmit =
    Boolean(teamId) && title.trim() !== "" && missingPlacement(level) === null;

  const changeLevel = (next: LevelChoice) => {
    setLevel(next);
    if (!statusesFor(STATUSES, next.kind).some((s) => s.value === status)) {
      setStatus("todo");
    }
  };

  const handleSubmit = async () => {
    if (!teamId || !canSubmit || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    const submittedIn = session.current;
    const { level: submittedLevel, ...fields } = draft;
    try {
      const issueId = await createIssue({
        teamId,
        ...fields,
        description: fields.description.trim() || undefined,
        ...submittedLevel,
      });
      toast.success("Issue created");
      const outcome = createIssueOutcome(
        submittedIn === session.current,
        draft,
        currentDraft.current
      );
      if (outcome === "keep") {
        return;
      }
      setTitle("");
      setDescription("");
      setStatus("todo");
      setPriority("none");
      setLevel(DEFAULT_LEVEL);
      if (outcome === "clear") {
        return;
      }
      onOpenChange(false);
      if (params.orgSlug) {
        router.push(`/${params.orgSlug}/issue/${issueId}`);
      }
    } catch (error) {
      toast.error(
        errorMessage(error, "Failed to create issue")
      );
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium text-muted-foreground">
            New issue
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            placeholder="Issue title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                void handleSubmit();
              }
            }}
            className="border-none px-0 text-lg font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <Textarea
            placeholder="Add description…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-20 resize-none border-none px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={teamId ?? ""}
              onValueChange={(value) => {
                setSelectedTeamId(value as Id<"teams">);
                setLevel({ ...level, parentIssueId: undefined });
              }}
            >
              <SelectTrigger size="sm" className="w-auto gap-1.5">
                <SelectValue placeholder="Team" />
              </SelectTrigger>
              <SelectContent>
                {teams?.map((team) => (
                  <SelectItem key={team._id} value={team._id}>
                    {team.key} · {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <LevelPickers teamId={teamId} value={level} onChange={changeLevel} />
            <Select
              value={status}
              onValueChange={(value) => setStatus(value as IssueStatus)}
            >
              <SelectTrigger size="sm" className="w-auto gap-1.5">
                <StatusIcon status={status} />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {offeredStatuses.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={priority}
              onValueChange={(value) => setPriority(value as IssuePriority)}
            >
              <SelectTrigger size="sm" className="w-auto gap-1.5">
                <PriorityIcon priority={priority} />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit || submitting}
            onClick={() => void handleSubmit()}
          >
            {submitting ? "Creating…" : "Create issue"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
