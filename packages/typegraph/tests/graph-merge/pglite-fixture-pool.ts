import { type PGlite } from "@electric-sql/pglite";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import {
  createLocalPgliteBackend,
  type LocalPgliteBackendResult,
} from "@nicia-ai/typegraph/adapters/drizzle/postgres/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { generatePostgresMigrationSQL } from "../../src/backend/drizzle/ddl";
import { tables as defaultTables } from "../../src/backend/drizzle/postgres";

export type PgliteFixturePool = Readonly<{
  makeFixture: () => Promise<
    Readonly<{
      backend: ReturnType<typeof createPostgresBackend>;
      cleanup: () => Promise<void>;
    }>
  >;
  dispose: () => Promise<void>;
}>;

type LeaseClient = Readonly<{
  client: PGlite;
  /** Refuses every later call, then resolves once the calls already made settle. */
  release: () => Promise<void>;
}>;

/**
 * The engine's client as one lease sees it. PGlite serializes statements, so a
 * statement already issued is ordered before the cleanup that follows it; a
 * statement issued AFTER release is not, and would run against whatever the
 * engine holds next: the reset search path (a missing relation) or the next
 * lease's schema (a silent write into another fixture). The guard refuses it
 * with an error that names the cause.
 */
function createLeaseClient(engineClient: PGlite): LeaseClient {
  const inFlight = new Set<Promise<unknown>>();
  let released = false;
  const client = new Proxy(engineClient, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== "function") return member;
      return (...args: unknown[]): unknown => {
        if (released) {
          throw new Error(
            `PGlite fixture lease was released before ${String(property)}() was called`,
          );
        }
        const result: unknown = Reflect.apply(member, target, args);
        if (result instanceof Promise) {
          const settled = Promise.allSettled([result]);
          inFlight.add(settled);
          void settled.then(() => inFlight.delete(settled));
        }
        return result;
      };
    },
  });
  return {
    client,
    release: async () => {
      released = true;
      await Promise.all(inFlight);
    },
  };
}

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
        const lease = createLeaseClient(engine.client);
        const backend = createPostgresBackend(drizzle(lease.client));
        let released = false;

        return {
          backend,
          cleanup: async () => {
            if (released) return;
            released = true;
            try {
              await lease.release();
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
