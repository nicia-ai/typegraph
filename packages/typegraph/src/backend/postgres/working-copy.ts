/** PostgreSQL table-backed working-copy allocation and recovery. */
export type { MakeBackend } from "../../graph-merge/working-copy";
export type {
  PostgresUnsealedAllocation,
  PostgresWorkingCopyLocator,
  PostgresWorkingCopyManager,
  PostgresWorkingCopyOptions,
  PostgresWorkingCopyReopenOptions,
} from "../drizzle/postgres-working-copy";
export { createPostgresWorkingCopyManager } from "../drizzle/postgres-working-copy";
export type { PostgresTableNames } from "../drizzle/schema/postgres";
