/**
 * The commit-outcome evidence holds when the Store and the PostgreSQL adapter
 * come from two copies of the package: an application whose dependency tree
 * resolves the library twice builds its Store with one copy and its backend
 * with the other. The Store releases the native handle (`tx.sql`) and
 * classifies the adapter's errors for its retry loop, so both must work
 * across the copies, the way the Store's runtime ports already do
 * (`tests/store-runtime-module-identity.test.ts`).
 */
import { PGlite } from "@electric-sql/pglite";
import { vector as pgvectorExtension } from "@electric-sql/pglite-pgvector";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const POSTGRES_CONFLICT_SQL =
  "DO $$ BEGIN RAISE EXCEPTION 'synthetic conflict' USING ERRCODE = 'serialization_failure'; END $$";

type NativeHandle = Readonly<{
  execute: (query: ReturnType<typeof drizzleSql.raw>) => Promise<unknown>;
}>;

function nativeHandleOf(transactionContext: object): NativeHandle {
  return Reflect.get(transactionContext, "sql") as NativeHandle;
}

/**
 * The adapter from one copy of the package, the Store from another.
 * `conflictingReads` makes the adapter's transactions answer that many
 * `getNode` calls with a serialization failure from the engine, then read
 * normally; `history` makes the Store a history store, which flushes its
 * capture on the transaction after the callback returned.
 */
async function openAcrossInstances(
  options: Readonly<{ conflictingReads?: number; history?: boolean }> = {},
) {
  const adapterInstance = await import("../../../src/backend/postgres");
  const { deriveBackend } = await import("../../../src/backend/derive-backend");
  const { asCompiledRowsSql } = await import("../../../src/query/sql-intent");
  const { sql } = await import("../../../src/query/sql-fragment");
  const adapterErrors = await import("../../../src/errors");
  const { generatePostgresMigrationSQL } =
    await import("../../../src/backend/drizzle/ddl");
  vi.resetModules();
  const storeInstance = await import("../../../src");

  const client = new PGlite({ extensions: { vector: pgvectorExtension } });
  await client.exec(generatePostgresMigrationSQL());
  const adapterBackend = adapterInstance.createPostgresBackend(drizzle(client));
  let conflictsLeft = options.conflictingReads ?? 0;
  const backend =
    conflictsLeft === 0 ? adapterBackend : (
      deriveBackend(adapterBackend, {
        transaction: (run, transactionOptions) =>
          adapterBackend.transaction(
            (target) =>
              run(
                deriveBackend(target, {
                  getNode: async (graphId, kind, id) => {
                    if (conflictsLeft === 0) {
                      return target.getNode(graphId, kind, id);
                    }
                    conflictsLeft -= 1;
                    await target.execute(
                      asCompiledRowsSql(sql.raw(POSTGRES_CONFLICT_SQL)),
                    );
                    return;
                  },
                }),
              ),
            transactionOptions,
          ),
      })
    );

  const Note = storeInstance.defineNode("InstanceNote", {
    schema: z.object({ body: z.string() }),
  });
  const graph = storeInstance.defineGraph({
    id: "commit_outcome_module_identity",
    nodes: { InstanceNote: { type: Note } },
    edges: {},
  });
  const [store] = await storeInstance.createAdapterStoreWithSchema(
    graph,
    backend,
    options.history === true ? { history: true } : {},
  );
  return { adapterErrors, storeInstance, store, client };
}

describe("commit-outcome evidence across package instances", () => {
  let close: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("loads the Store and the adapter as two package instances", async () => {
    const { adapterErrors, storeInstance, client } =
      await openAcrossInstances();
    close = () => client.close();

    expect(storeInstance.TransactionOutcomeUnknownError).not.toBe(
      adapterErrors.TransactionOutcomeUnknownError,
    );
  });

  it("never commits a transaction the callback opened through a handle a Store from another instance released", async () => {
    const { store, client } = await openAcrossInstances();
    close = () => client.close();

    const outcome = await store
      .transaction(async (tx) => {
        await tx.nodes.InstanceNote.create(
          { body: "written before the native rollback" },
          { id: "instance-before" },
        );
        const native = nativeHandleOf(tx);
        await native.execute(drizzleSql.raw("ROLLBACK"));
        await native.execute(drizzleSql.raw("BEGIN"));
        await tx.nodes.InstanceNote.create(
          { body: "written in the replacement" },
          { id: "instance-replacement" },
        );
        return "callback returned";
      })
      .catch((error: unknown) => error);

    expect(outcome).toMatchObject({
      name: "TransactionOutcomeUnknownError",
      code: "TRANSACTION_OUTCOME_UNKNOWN",
      details: { reason: "transaction-ended" },
    });
    expect(
      await store.nodes.InstanceNote.getById("instance-before" as never),
    ).toBeUndefined();
    expect(
      await store.nodes.InstanceNote.getById("instance-replacement" as never),
    ).toBeUndefined();
  });

  it("never retries a conflict after the handle was read, when the Store's retry loop is from another instance", async () => {
    const { store, client } = await openAcrossInstances();
    close = () => client.close();

    let attempts = 0;
    const outcome = await store
      .transaction(
        async (tx) => {
          attempts += 1;
          await nativeHandleOf(tx)
            .execute(drizzleSql.raw(POSTGRES_CONFLICT_SQL))
            .catch(() => "caught");
          return attempts;
        },
        { retry: { attempts: 2 } },
      )
      .catch((error: unknown) => error);

    expect(attempts).toBe(1);
    expect(outcome).toMatchObject({
      name: "TransactionOutcomeUnknownError",
      details: { reason: "native-handle-released" },
      cause: { code: "40001" },
    });
  });

  it("retries a caught conflict that Store work after the callback, on another instance, met as an aborted session", async () => {
    const { store, client } = await openAcrossInstances({
      conflictingReads: 1,
      history: true,
    });
    close = () => client.close();

    let attempts = 0;
    const result = await store.transaction(
      async (tx) => {
        attempts += 1;
        await tx.nodes.InstanceNote.create(
          { body: `attempt ${attempts}` },
          { id: "instance-history" },
        );
        // The first attempt's read is refused with a serialization failure,
        // which the callback catches; the transaction is now aborted, and the
        // Store's capture flush after the callback meets it first.
        await tx.nodes.InstanceNote.getById("instance-history" as never).catch(
          () => "caught",
        );
        return attempts;
      },
      { retry: { attempts: 2 } },
    );

    // The adapter reported the refused flush as the rolled-back conflict it
    // is, and the Store's retry loop, from the other instance, re-ran it.
    expect(result).toBe(2);
    expect(
      await store.nodes.InstanceNote.getById("instance-history" as never),
    ).toMatchObject({ body: "attempt 2" });
  });
});
