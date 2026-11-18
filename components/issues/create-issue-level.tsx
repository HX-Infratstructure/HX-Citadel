"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KIND_LABELS, STORY_TYPE_LABELS } from "@/components/issues/issue-key";
import { IssueKind, PARENT_KIND, parentChoices, PROJECT_REQUIRED } from "@/lib/issue-key";
import { missingPlacement } from "@/lib/level-placement";

type StoryType = NonNullable<Doc<"issues">["type"]>;
type CreatableKind = "epic" | "feature" | "story";

export type LevelChoice = {
  kind: CreatableKind;
  type: StoryType;
  parentIssueId?: Id<"issues">;
  projectId?: Id<"projects">;
};

export const DEFAULT_LEVEL: LevelChoice = { kind: "story", type: "story" };

const LEVELS: CreatableKind[] = ["epic", "feature", "story"];
const STORY_TYPES = Object.keys(STORY_TYPE_LABELS) as StoryType[];

const NO_PARENT = "none";

/** The create fields a level adds: the story type for stories. */
export function levelFields(choice: LevelChoice) {
  return {
    kind: choice.kind,
    type: choice.kind === "story" ? choice.type : undefined,
    parentIssueId: choice.parentIssueId,
    projectId: choice.projectId,
  };
}

/** Level, story type and placement pickers; parents are limited to the level one up. */
export function LevelPickers({
  teamId,
  value,
  onChange,
}: {
  teamId: Id<"teams"> | undefined;
  value: LevelChoice;
  onChange: (value: LevelChoice) => void;
}) {
  const missing = missingPlacement(value);
  const parentKind = PARENT_KIND[value.kind];
  return (
    <>
      <Select
        value={value.kind}
        onValueChange={(kind) => onChange({ kind: kind as CreatableKind, type: value.type })}
      >
        <SelectTrigger size="sm" className="w-auto gap-1.5" aria-label="Level">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LEVELS.map((level) => (
            <SelectItem key={level} value={level}>
              {KIND_LABELS[level]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value.kind === "story" && (
        <Select
          value={value.type}
          onValueChange={(type) => onChange({ ...value, type: type as StoryType })}
        >
          <SelectTrigger size="sm" className="w-auto gap-1.5" aria-label="Type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STORY_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {STORY_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {PROJECT_REQUIRED[value.kind] && (
        <ProjectPicker value={value} onChange={onChange} invalid={missing === "project"} />
      )}
      {parentKind && teamId && (
        <ParentPicker
          teamId={teamId}
          parentKind={parentKind}
          value={value}
          onChange={onChange}
          invalid={missing === "parent"}
        />
      )}
    </>
  );
}

function ProjectPicker({
  value,
  onChange,
  invalid,
}: {
  value: LevelChoice;
  onChange: (value: LevelChoice) => void;
  invalid: boolean;
}) {
  const projects = useQuery(api.projects.list);
  return (
    <Select
      value={value.projectId ?? ""}
      onValueChange={(projectId) =>
        onChange({ ...value, projectId: projectId as Id<"projects"> })
      }
    >
      <SelectTrigger
        size="sm"
        className="w-auto gap-1.5"
        aria-label="Project"
        aria-invalid={invalid}
      >
        <SelectValue placeholder="Project" />
      </SelectTrigger>
      <SelectContent>
        {projects?.map((project) => (
          <SelectItem key={project._id} value={project._id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ParentPicker({
  teamId,
  parentKind,
  value,
  onChange,
  invalid,
}: {
  teamId: Id<"teams">;
  parentKind: IssueKind;
  value: LevelChoice;
  onChange: (value: LevelChoice) => void;
  invalid: boolean;
}) {
  const candidates = useQuery(api.issues.listParentCandidates, { teamId, kind: value.kind });
  const choices = parentChoices(candidates ?? [], value.kind);
  const parents = choices?.parents ?? [];
  const parentLabel = KIND_LABELS[parentKind];
  const selectParent = (parentId: string) =>
    onChange({
      ...value,
      parentIssueId: parentId === NO_PARENT ? undefined : (parentId as Id<"issues">),
    });

  return (
    <Select value={value.parentIssueId ?? ""} onValueChange={selectParent}>
      <SelectTrigger
        size="sm"
        className="w-auto gap-1.5"
        aria-label={parentLabel}
        aria-invalid={invalid}
      >
        <SelectValue placeholder={parentLabel} />
      </SelectTrigger>
      <SelectContent>
        {choices?.allowsNone && (
          <SelectItem value={NO_PARENT}>No {parentLabel.toLowerCase()}</SelectItem>
        )}
        {parents.map((parent) => (
          <SelectItem key={parent._id} value={parent._id}>
            {parent.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
