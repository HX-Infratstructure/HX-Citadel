export const DAY_MS = 86_400_000;

/** Scrum sprint length: a cycle runs 7 days, start and end day inclusive. */
export const SPRINT_DAYS = 7;

/** The last day of a sprint that starts at `startMs`. */
export function sprintEnd(startMs: number): number {
  return startMs + (SPRINT_DAYS - 1) * DAY_MS;
}
