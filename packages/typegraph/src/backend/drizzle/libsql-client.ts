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
export function isLocalLibsqlClient(client: unknown): boolean {
  return isLibsqlClient(client) && client.protocol === "file";
}
