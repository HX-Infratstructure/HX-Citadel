import { describe, expect, test } from "vitest";
import crons from "./crons";

describe("crons", () => {
  // Catches: a cron dropped, renamed, moved to another minute, or pointed at another function.
  test("schedules the mirror reconcile at :07 and the idempotency key expiry at :37, hourly", () => {
    expect(crons.crons).toEqual({
      "mirror reconcile": { name: "mirror:reconcileAll", args: [{}], schedule: { type: "hourly", minuteUTC: 7 } },
      "idempotency key expiry": {
        name: "agentApi:expireIdempotencyKeys",
        args: [{}],
        schedule: { type: "hourly", minuteUTC: 37 },
      },
    });
  });
});
