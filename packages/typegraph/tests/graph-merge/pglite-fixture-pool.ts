import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import {
  createLocalPgliteBackend,
  type LocalPgliteBackendResult,
} from "@nicia-ai/typegraph/adapters/drizzle/postgres/pglite";

import { generatePostgresMigrationSQL } from "../../src/backend/drizzle/ddl";
import { tables as defaultTables } from "../../src/backend/drizzle/postgres";
import type { MergeBackendFixture } from "./test-utils";

export type PgliteFixturePool = Readonly<{
  makeFixture: () => Promise<MergeBackendFixture>;
  dispose: () => Promise<void>;
}>;

/**
 * Reuse idle WASM engines, never connections belonging to a live fixture.
 * Each lease has a fresh backend and schema, including strategy-owned tables.
 * This preserves independent transactions and the default table names used by
 * fault-injection SQL. Dispose after the suite's fixture cleanups have run.
 */
export function createPgliteFixturePool(): PgliteFixturePool {
  const engines = new Set<LocalPgliteBackendResult>();
  const idle: LocalPgliteBackendResult[] = [];
  let sequence = 0;
  let disposed = false;

  async function closeEngine(engine: LocalPgliteBackendResult): Promise<void> {
    engines.delete(engine);
    await engine.client.close();
  }

  return {
    makeFixture: async () => {
      if (disposed) throw new Error("PGlite fixture pool is disposed");
      const engine = idle.pop() ?? (await createLocalPgliteBackend());
      engines.add(engine);
      sequence += 1;
      const schema = `merge_lease_${sequence}`;

      try {
        // Bootstrap explicitly: public contains the factory's empty tables,
        // which would otherwise satisfy the backend's schema-existence probe.
        // Keep public on the path for the pgvector extension's types/functions.
        await engine.client.exec(
          `CREATE SCHEMA "${schema}";
           SET search_path TO "${schema}", public;
           ${generatePostgresMigrationSQL(defaultTables)}`,
        );
        const backend = createPostgresBackend(engine.db);
        let released = false;

        return {
          backend,
          cleanup: async () => {
            if (released) return;
            released = true;
            try {
              await backend.close();
              // Drop the entire schema, not just core tables: fulltext,
              // vector and declared indexes must not survive into another test.
              await engine.client.exec(
                `RESET ALL; DROP SCHEMA "${schema}" CASCADE;`,
              );
              idle.push(engine);
            } catch (error) {
              await closeEngine(engine);
              throw error;
            }
          },
        };
      } catch (error) {
        await closeEngine(engine);
        throw error;
      }
    },
    dispose: async () => {
      disposed = true;
      idle.length = 0;
      const outcomes = await Promise.allSettled(
        [...engines].map((engine) => closeEngine(engine)),
      );
      const errors = outcomes
        .filter((outcome) => outcome.status === "rejected")
        .map((outcome) => outcome.reason as unknown);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to close PGlite fixture pool");
      }
    },
  };
}
