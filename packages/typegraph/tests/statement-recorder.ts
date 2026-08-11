/**
 * A PostgreSQL-speaking store whose every statement is recorded.
 *
 * Statements are captured with drizzle's `logger` rather than a backend-method
 * Proxy: the logger sees every statement the engine is actually asked to run,
 * including the ones a Proxy over the port would miss (advisory locks, probes
 * issued inside a backend method, statements a nested overlay forwards).
 *
 * The engine is PGlite — in-process, no Docker, real PostgreSQL semantics. It
 * is single-connection and serial, so a genuine two-writer race is NOT
 * constructible here; what these stores certify is which statements a write
 * emits and in what ORDER. Outcome-under-contention belongs in
 * `tests/backends/postgres/**`, which needs a server for the same reason.
 *
 * Every client is closed after the test that created it, so a suite only has
 * to import this module to inherit the cleanup.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach } from "vitest";

import { type GraphDef } from "../src";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { type GraphBackend } from "../src/backend/types";
import { createStore, type Store } from "../src/store";

/** One statement as drizzle's logger reports it. */
export type LoggedStatement = Readonly<{
  query: string;
  params: readonly unknown[];
}>;

export type RecordedPostgresStore<TGraph extends GraphDef> = Readonly<{
  store: Store<TGraph>;
  backend: GraphBackend;
  /** Every statement recorded since the last `reset()`, in issue order. */
  statements: readonly LoggedStatement[];
  /** Drops the recording so the next assertion sees one write's statements. */
  reset: () => void;
}>;

const clients: PGlite[] = [];

afterEach(async () => {
  const pending = clients.splice(0);
  for (const client of pending.toReversed()) await client.close();
});

/**
 * Creates a fresh PGlite database with TypeGraph's schema, a Postgres backend
 * over it, and a live store for `graph` — recording every statement issued.
 */
export async function createRecordedPostgresStore<TGraph extends GraphDef>(
  graph: TGraph,
): Promise<RecordedPostgresStore<TGraph>> {
  const client = await PGlite.create();
  clients.push(client);
  await client.exec(generatePostgresDDL().join("\n\n"));

  const statements: LoggedStatement[] = [];
  const backend = createPostgresBackend(
    drizzle(client, {
      logger: {
        logQuery(query: string, params: unknown[]): void {
          statements.push({ query, params });
        },
      },
    }),
    { vector: false },
  );

  return {
    store: createStore(graph, backend),
    backend,
    statements,
    reset: () => {
      statements.splice(0);
    },
  };
}
