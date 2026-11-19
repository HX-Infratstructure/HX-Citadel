export const DAY_MS = 86_400_000;

/** Scrum sprint length: a cycle runs 7 days, start and end day inclusive. */
export const SPRINT_DAYS = 7;

/** The last day of a sprint that starts at `startMs`. */
export function sprintEnd(startMs: number): number {
  return startMs + (SPRINT_DAYS - 1) * DAY_MS;
}

/** A cycle's display name; unnamed cycles are "Cycle <n>". */
export function cycleName(cycle: { name?: string; number: number }): string {
  return cycle.name ?? `Cycle ${cycle.number}`;
}

/** The last day ("yyyy-mm-dd") of a sprint that starts on `start`, counted in calendar days so a clock change can't move it. */
export function sprintEndDate(start: string): string {
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + SPRINT_DAYS - 1);
  return date.toISOString().slice(0, 10);
}
