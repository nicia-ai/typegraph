/**
 * Shared helpers for examples
 *
 * Provides an easy way to create an in-memory SQLite database
 * for running examples with full query support.
 */
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";

/**
 * Creates an in-memory SQLite backend for examples.
 * This supports the full query API, unlike the memory adapter.
 */
export function createExampleBackend() {
  const { backend } = createLocalSqliteBackend();
  return backend;
}

type RecordedClock<Instant extends string> = Readonly<{
  recordedNow: () => Promise<Instant | undefined>;
}>;

export async function requireRecordedNow<Instant extends string>(
  store: RecordedClock<Instant>,
  message = "expected recorded history",
): Promise<Instant> {
  const recordedNow = await store.recordedNow();
  if (recordedNow === undefined) throw new Error(message);
  return recordedNow;
}
