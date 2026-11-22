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

/** The adapter from one copy of the package, the Store from another. */
async function openAcrossInstances() {
  const adapterInstance = await import("../../../src/backend/postgres");
  const adapterErrors = await import("../../../src/errors");
  const { generatePostgresMigrationSQL } =
    await import("../../../src/backend/drizzle/ddl");
  vi.resetModules();
  const storeInstance = await import("../../../src");

  const client = new PGlite({ extensions: { vector: pgvectorExtension } });
  await client.exec(generatePostgresMigrationSQL());
  const backend = adapterInstance.createPostgresBackend(drizzle(client));

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
});
