import type { TransactionLimits } from "convex/server";

/** Past any of these, Convex fails a query or mutation whole (https://docs.convex.dev/production/state/limits). */
export const TRANSACTION_LIMITS = {
  bytesRead: 16 * 1024 * 1024,
  bytesWritten: 16 * 1024 * 1024,
  documentsRead: 32_000,
  documentsWritten: 16_000,
  databaseQueries: 4_096,
} as const satisfies TransactionLimits;
