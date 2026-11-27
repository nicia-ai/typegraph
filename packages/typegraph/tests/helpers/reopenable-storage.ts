/**
 * Storage that a test can reach again through a NEW database session.
 *
 * Some engine state belongs to the session, not to the data: PostgreSQL
 * defines an extension's configuration parameters only once the extension's
 * library has loaded in that backend process, which a session that has not
 * used the extension yet has not done. A test of that state needs a session
 * that has executed nothing, over data an earlier session wrote. A lane's
 * suite backend cannot give one: its sessions already ran the provisioning
 * and the fixture writes.
 *
 * Every driver lane of the shared suite opens one with the helper here, so the
 * question "what does a brand-new session see" is asked the same way
 * everywhere.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createClient } from "@libsql/client";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import pg from "pg";
import postgres from "postgres";

import { createPostgresBackend } from "../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import { createLibsqlBackend } from "../../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import type { AdapterBackend } from "../../src/backend/types";

/**
 * One storage location plus the sessions a test opens on it, in turn.
 *
 * `backend` is the first session, for provisioning and seeding. `reopen()`
 * ends whichever session is open and returns a backend over a NEW session on
 * the same storage; that session has executed nothing when it is returned.
 * `close()` ends the open session and removes storage the helper created.
 */
export type ReopenableStorage = Readonly<{
  backend: AdapterBackend<unknown>;
  reopen: () => Promise<AdapterBackend<unknown>>;
  close: () => Promise<void>;
}>;

type Session<TNativeTransaction> = Readonly<{
  backend: AdapterBackend<TNativeTransaction>;
  end: () => Promise<void>;
}>;

/**
 * The shared state machine: one open session at a time, the next opened only
 * after the previous one ended, so an engine that allows one open handle per
 * storage (PGlite, a file database) never sees two.
 */
async function reopenableStorage<TNativeTransaction>(
  openSession: (first: boolean) => Promise<Session<TNativeTransaction>>,
  removeStorage: () => void,
): Promise<ReopenableStorage> {
  // The test reads the backend without its native-transaction type, as the
  // suite's own context does (`getBackend`).
  const widen = (backend: AdapterBackend<TNativeTransaction>) =>
    backend as AdapterBackend<unknown>;
  const first = await openSession(true);
  const current = {
    session: first as Session<TNativeTransaction> | undefined,
  };
  async function endCurrent(): Promise<void> {
    const session = current.session;
    current.session = undefined;
    await session?.end();
  }
  return {
    backend: widen(first.backend),
    reopen: async () => {
      await endCurrent();
      const next = await openSession(false);
      current.session = next;
      return widen(next.backend);
    },
    close: async () => {
      try {
        await endCurrent();
      } finally {
        removeStorage();
      }
    },
  };
}

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(path.join(process.env["TMPDIR"] ?? tmpdir(), prefix));
}

/** better-sqlite3 over a temporary database file. */
export function openReopenableSqliteStorage(): Promise<ReopenableStorage> {
  const directory = temporaryDirectory("typegraph-reopen-sqlite-");
  const databasePath = path.join(directory, "graph.db");
  return reopenableStorage(
    (first) => {
      const { backend } = createLocalSqliteBackend({
        path: databasePath,
        ...(first ? {} : { schemaProvisioning: "dml-only" }),
      });
      return Promise.resolve({ backend, end: () => backend.close() });
    },
    () => {
      rmSync(directory, { recursive: true, force: true });
    },
  );
}

/** A libSQL local-file client over a temporary database file. */
export function openReopenableLibsqlStorage(): Promise<ReopenableStorage> {
  const directory = temporaryDirectory("typegraph-reopen-libsql-");
  const databasePath = path.join(directory, "graph.db");
  return reopenableStorage(
    async (first) => {
      const client = createClient({ url: `file:${databasePath}` });
      const { backend } = await createLibsqlBackend(
        client,
        first ? {} : { schemaProvisioning: "dml-only" },
      );
      return {
        backend,
        end: async () => {
          await backend.close();
          client.close();
        },
      };
    },
    () => {
      rmSync(directory, { recursive: true, force: true });
    },
  );
}

/**
 * PGlite over a temporary data directory. The first session is the bundled
 * factory, which migrates and creates the vector extension. A reopened one is
 * a plain `PGlite.create` over the same directory, with the extension
 * available to the engine: a new session that has not loaded its library yet.
 */
export function openReopenablePgliteStorage(): Promise<ReopenableStorage> {
  const dataDir = temporaryDirectory("typegraph-reopen-pglite-");
  return reopenableStorage(
    async (first) => {
      if (first) {
        const { backend } = await createLocalPgliteBackend({ dataDir });
        return { backend, end: () => backend.close() };
      }
      const client = await PGlite.create({ dataDir, extensions: { vector } });
      return {
        backend: createPostgresBackend(drizzlePglite(client), {
          schemaProvisioning: "dml-only",
        }),
        end: () => client.close(),
      };
    },
    () => {
      rmSync(dataDir, { recursive: true, force: true });
    },
  );
}

/**
 * node-postgres over the lane's provisioned database. Each session is its own
 * `max: 1` pool, so a reopened backend runs on a new server connection and
 * therefore a new backend process. The lane owns the tables; nothing is
 * removed at close.
 */
export function openReopenableNodePostgresStorage(
  databaseUrl: string,
): Promise<ReopenableStorage> {
  return reopenableStorage(
    (first) => {
      const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      return Promise.resolve({
        backend: createPostgresBackend(
          drizzleNodePostgres(pool),
          first ? {} : { schemaProvisioning: "dml-only" },
        ),
        end: () => pool.end(),
      });
    },
    () => {
      // The lane's database outlives the test.
    },
  );
}

/** postgres-js over the lane's provisioned database; see the node-postgres form. */
export function openReopenablePostgresJsStorage(
  databaseUrl: string,
): Promise<ReopenableStorage> {
  return reopenableStorage(
    (first) => {
      const client = postgres(databaseUrl, { max: 1 });
      return Promise.resolve({
        backend: createPostgresBackend(
          drizzlePostgresJs(client),
          first ? {} : { schemaProvisioning: "dml-only" },
        ),
        end: () => client.end(),
      });
    },
    () => {
      // The lane's database outlives the test.
    },
  );
}
