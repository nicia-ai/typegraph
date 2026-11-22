/**
 * A PGlite client wrapped so that it exposes only `query` and `transaction`
 * (an application's own instrumentation, say) hides the protocol stream the
 * `COMMIT` of `PGlite.transaction()` goes through, so the `COMMIT`'s reply
 * cannot be read. The backend then plants its marker before the callback
 * runs and reads it back before `COMMIT`: a clean transaction commits, and an
 * aborted one refuses the read and is reported as the rollback it is, never
 * as a success and never as an unknown outcome.
 */
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { vector as pgvectorExtension } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStore,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  TransactionRolledBackError,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { type NodeRow } from "../../../src/backend/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";

const WrappedNote = defineNode("WrappedNote", {
  schema: z.object({ body: z.string() }),
});
const wrappedGraph = defineGraph({
  id: "commit_outcome_wrapped_pglite",
  nodes: { WrappedNote: { type: WrappedNote } },
  edges: {},
});

const PLANT_PREFIX = "set local typegraph.transaction_marker";
const READ_PREFIX = "select current_setting('typegraph.transaction_marker'";

function normalized(text: string): string {
  return text.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/** Forwards only `query` and `transaction`, recording every query's text. */
function wrapClient(client: PGlite, sent: string[]): PGlite {
  function wrapTransaction(transaction: Transaction): Transaction {
    return new Proxy(transaction, {
      get(target, property): unknown {
        if (property !== "query") return undefined;
        return (text: string, params?: unknown[]) => {
          sent.push(normalized(text));
          return target.query(text, params);
        };
      },
    });
  }
  return new Proxy(client, {
    get(target, property): unknown {
      if (property === "query") {
        return (text: string, params?: unknown[]) => {
          sent.push(normalized(text));
          return target.query(text, params);
        };
      }
      if (property === "constructor") return target.constructor;
      if (property === "transaction") {
        return <T>(run: (transaction: Transaction) => Promise<T>): Promise<T> =>
          target.transaction((transaction) =>
            run(wrapTransaction(transaction)),
          );
      }
      return undefined;
    },
  });
}

describe("commit outcome on a wrapped PGlite client that hides its protocol stream", () => {
  let client: PGlite | undefined;
  const sent: string[] = [];

  beforeEach(async () => {
    client = new PGlite({ extensions: { vector: pgvectorExtension } });
    await client.exec(generatePostgresMigrationSQL());
    // Provisioned unwrapped; the cases run their transactions through the
    // wrapper.
    await createAdapterStoreWithSchema(
      wrappedGraph,
      createPostgresBackend(drizzle(client)),
    );
    sent.length = 0;
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  function openBackend() {
    if (client === undefined) throw new Error("PGlite is not open.");
    return createPostgresBackend(drizzle(wrapClient(client, sent)), {
      prepareStatements: false,
      vector: false,
    });
  }

  it("commits a clean transaction with its marker planted and read back", async () => {
    const store = createAdapterStore(wrappedGraph, openBackend());
    sent.length = 0;

    await store.transaction(async (tx) => {
      await tx.nodes.WrappedNote.create({ body: "kept" }, { id: "clean" });
    });

    expect(sent.filter((text) => text.startsWith(PLANT_PREFIX))).toHaveLength(
      1,
    );
    expect(sent.filter((text) => text.startsWith(READ_PREFIX))).toHaveLength(1);
    expect(
      await store.nodes.WrappedNote.getById("clean" as never),
    ).toMatchObject({ body: "kept" });
  });

  it("rejects as rolled back a transaction whose caught failure aborted it", async () => {
    const backend = openBackend();
    const store = createAdapterStore(wrappedGraph, backend);
    const failingStore = createAdapterStore(
      wrappedGraph,
      deriveBackend(backend, {
        transactionWithNative: (run, options) =>
          backend.transactionWithNative(
            (target, native) =>
              run(
                deriveBackend(target, {
                  getNode: async (): Promise<NodeRow | undefined> => {
                    await target.execute(
                      asCompiledRowsSql(
                        sql.raw("SELECT * FROM wrapped_missing_relation"),
                      ),
                    );
                    return undefined;
                  },
                }),
                native,
              ),
            options,
          ),
      }),
    );

    const outcome = await failingStore
      .transaction(async (tx) => {
        await tx.nodes.WrappedNote.create(
          { body: "before the failure" },
          { id: "aborted" },
        );
        await tx.nodes.WrappedNote.getById("missing" as never).catch(
          () => "caught",
        );
        return "callback returned";
      })
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(TransactionRolledBackError);
    expect((outcome as TransactionRolledBackError).details).toEqual({
      conflict: false,
      detectedBy: "refused-statement",
      causeObserved: true,
    });
    expect(
      await store.nodes.WrappedNote.getById("aborted" as never),
    ).toBeUndefined();
  });
});
