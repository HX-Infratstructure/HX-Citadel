import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.hourly("mirror reconcile", { minuteUTC: 7 }, internal.mirror.reconcileAll, {});
crons.hourly("idempotency key expiry", { minuteUTC: 37 }, internal.agentApi.expireIdempotencyKeys, {});

export default crons;
