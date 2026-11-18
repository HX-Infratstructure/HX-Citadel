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
import { validParents } from "@/lib/issue-key";

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
      {value.kind === "epic" && <ProjectPicker value={value} onChange={onChange} />}
      {value.kind !== "epic" && teamId && (
        <ParentPicker teamId={teamId} value={value} onChange={onChange} />
      )}
    </>
  );
}

function ProjectPicker({
  value,
  onChange,
}: {
  value: LevelChoice;
  onChange: (value: LevelChoice) => void;
}) {
  const projects = useQuery(api.projects.list);
  return (
    <Select
      value={value.projectId ?? ""}
      onValueChange={(projectId) =>
        onChange({ ...value, projectId: projectId as Id<"projects"> })
      }
    >
      <SelectTrigger size="sm" className="w-auto gap-1.5" aria-label="Project">
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
  value,
  onChange,
}: {
  teamId: Id<"teams">;
  value: LevelChoice;
  onChange: (value: LevelChoice) => void;
}) {
  const issues = useQuery(api.issues.listByTeam, { teamId });
  const parents = validParents(issues ?? [], value.kind);
  const parentLabel = value.kind === "feature" ? "Epic" : "Feature";
  const selectParent = (parentId: string) =>
    onChange({
      ...value,
      parentIssueId: parentId === NO_PARENT ? undefined : (parentId as Id<"issues">),
    });

  return (
    <Select value={value.parentIssueId ?? ""} onValueChange={selectParent}>
      <SelectTrigger size="sm" className="w-auto gap-1.5" aria-label={parentLabel}>
        <SelectValue placeholder={parentLabel} />
      </SelectTrigger>
      <SelectContent>
        {value.kind === "story" && (
          <SelectItem value={NO_PARENT}>No feature</SelectItem>
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
