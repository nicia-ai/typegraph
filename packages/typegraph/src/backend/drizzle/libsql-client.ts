/**
 * Structural identity checks for @libsql/client.
 *
 * This module intentionally has no @libsql/client import: the Drizzle
 * adapter is bundled for runtimes where that optional peer is not installed.
 */

export type LibsqlClient = Readonly<{
  protocol: string;
  execute: (...args: readonly unknown[]) => Promise<unknown>;
  batch: (...args: readonly unknown[]) => Promise<readonly unknown[]>;
  executeMultiple: (...args: readonly unknown[]) => Promise<unknown>;
}>;

/** The one owner of the positive libSQL client-shape decision. */
export function isLibsqlClient(client: unknown): client is LibsqlClient {
  if (typeof client !== "object" || client === null) return false;
  const candidate = client as Readonly<Record<string, unknown>>;
  return (
    typeof candidate["protocol"] === "string" &&
    typeof candidate["execute"] === "function" &&
    typeof candidate["batch"] === "function" &&
    typeof candidate["executeMultiple"] === "function"
  );
}

/** Whether a positively identified libSQL client is backed by one local file. */
export function isLocalLibsqlClient(client: unknown): client is LibsqlClient {
  return isLibsqlClient(client) && client.protocol === "file";
}

/**
 * Whether successive `execute()` calls on a local client run on one session,
 * so a raw BEGIN in one call is still open in the next.
 *
 * `@libsql/client` before 0.18 keeps one stable connection per local client.
 * 0.18 pools local connections instead: every `execute()` borrows one and
 * rolls back whatever transaction it leaves open when returning it, so raw
 * BEGIN/COMMIT framing cannot span calls. The fact is observed on the client
 * rather than inferred from a package version. Only a ROLLBACK that succeeds
 * proves the session carried over; any failure means it did not, because on a
 * session-preserving client the ROLLBACK directly follows its own BEGIN.
 */
async function localExecuteSharesSession(
  client: LibsqlClient,
): Promise<boolean> {
  await client.execute("BEGIN");
  try {
    await client.execute("ROLLBACK");
    return true;
  } catch {
    return false;
  }
}

/**
 * How a libSQL client frames transactions: raw BEGIN/COMMIT on a local client
 * whose `execute()` calls share one session, otherwise the client's own
 * `transaction()` through Drizzle's `db.transaction()`.
 */
export async function detectLibsqlTransactionMode(
  client: unknown,
): Promise<"drizzle" | "sql"> {
  if (!isLocalLibsqlClient(client)) return "drizzle";
  return (await localExecuteSharesSession(client)) ? "sql" : "drizzle";
}
