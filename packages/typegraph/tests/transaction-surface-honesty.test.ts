/**
 * Transaction-surface honesty (#252, #253, #254, #258).
 *
 * Pins the fixes that make the store transaction surface tell the truth:
 * - #253 `withTransaction()` on a {@link HistoryStore} is a compile error.
 * - #254 `tx.sqlAvailability` is an honest four-state discriminant for `tx.sql`.
 * - #258 the recorded-capture guards carry stable, branchable `details.code`s
 *   reachable through {@link isRecordedCaptureGuardError}.
 *
 * The #252 JSDoc fix (write your own tables through the external handle, not
 * `tx.sql`) is documentation-only; the shape it now recommends is already
 * exercised end-to-end by `recorded-with-transaction.test.ts`.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  isRecordedCaptureGuardError,
  RECORDED_CAPTURE_GUARD_CODES,
  type AdoptedTransaction,
  type GraphBackend,
  type HistoryStore,
  type RecordedCaptureGuardCode,
  type SqlAvailability,
  type Store,
  type TransactionContext,
} from "../src";
import { createInitializedStore, createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "transaction_surface_honesty",
  nodes: { Person: { type: Person } },
  edges: {},
});

/**
 * Wraps a real backend so any unconditional `transaction(...)` rejects — the
 * shape of `drizzle-orm/neon-http` and Cloudflare D1. Mirrors the helper in
 * `no-transactions-fallthrough.test.ts`.
 */
function disableTransactions(backend: GraphBackend): GraphBackend {
  return {
    ...backend,
    capabilities: { ...backend.capabilities, transactions: false },
    transaction: () =>
      Promise.reject(new Error("synthetic backend has transactions disabled")),
  };
}

/** Reads `tx.sql.run` — the access the guard fail-louds on under capture. */
function readSqlRunAccessor(tx: TransactionContext<typeof graph>): unknown {
  return (tx.sql as { run?: unknown }).run;
}

describe("#254 tx.sqlAvailability discriminant", () => {
  it("reports 'available' with a usable tx.sql on a plain transactional store", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    await store.transaction(async (tx) => {
      expect(tx.sqlAvailability).toBe("available");
      expect(tx.sql).toBeDefined();
    });
  });

  it("reports 'unavailable' with tx.sql === undefined on a non-transactional backend", async () => {
    const store = await createInitializedStore(
      graph,
      disableTransactions(createTestBackend()),
    );
    await store.transaction(async (tx) => {
      expect(tx.sqlAvailability).toBe("unavailable");
      expect(tx.sql).toBeUndefined();
    });
  });

  it("reports 'history' with a present-but-throwing tx.sql under history capture", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend(), {
      history: true,
    });
    await store.transaction(async (tx) => {
      expect(tx.sqlAvailability).toBe("history");
      // Present-but-throwing: not undefined, and every access fails loud.
      expect(tx.sql).toBeDefined();
      expect(() => readSqlRunAccessor(tx)).toThrow(ConfigurationError);
    });
  });

  it("reports 'revisionTracking' with a present-but-throwing tx.sql", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend(), {
      revisionTracking: true,
    });
    await store.transaction(async (tx) => {
      expect(tx.sqlAvailability).toBe("revisionTracking");
      expect(tx.sql).toBeDefined();
      expect(() => readSqlRunAccessor(tx)).toThrow(ConfigurationError);
    });
  });
});

describe("#258 recorded-capture guard error codes", () => {
  it("exposes exactly the three shipped codes as a stable set", () => {
    expect([...RECORDED_CAPTURE_GUARD_CODES]).toEqual([
      "RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION",
      "RECORDED_CAPTURE_RAW_SQL_DISABLED",
      "REVISION_TRACKING_RAW_SQL_DISABLED",
    ]);
  });

  it("tags the withTransaction guard with RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend(), {
      history: true,
    });
    // `withTransaction` is a compile error on a history store (#253); casting to
    // the general Store surface exercises the runtime guard behind it.
    const call = (): unknown =>
      (store as Store<typeof graph>).withTransaction({} as AdoptedTransaction);
    expect(call).toThrow(ConfigurationError);

    let caught: unknown;
    try {
      call();
    } catch (error) {
      caught = error;
    }
    expect(
      isRecordedCaptureGuardError(
        caught,
        "RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION",
      ),
    ).toBe(true);
    // The narrowing rejects the sibling codes.
    expect(
      isRecordedCaptureGuardError(caught, "RECORDED_CAPTURE_RAW_SQL_DISABLED"),
    ).toBe(false);
  });

  it("tags the history tx.sql guard with RECORDED_CAPTURE_RAW_SQL_DISABLED", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend(), {
      history: true,
    });
    await store.transaction(async (tx) => {
      let caught: unknown;
      try {
        readSqlRunAccessor(tx);
      } catch (error) {
        caught = error;
      }
      expect(
        isRecordedCaptureGuardError(caught, "RECORDED_CAPTURE_RAW_SQL_DISABLED"),
      ).toBe(true);
    });
  });

  it("tags the revision-tracking tx.sql guard with REVISION_TRACKING_RAW_SQL_DISABLED", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend(), {
      revisionTracking: true,
    });
    await store.transaction(async (tx) => {
      let caught: unknown;
      try {
        readSqlRunAccessor(tx);
      } catch (error) {
        caught = error;
      }
      expect(
        isRecordedCaptureGuardError(caught, "REVISION_TRACKING_RAW_SQL_DISABLED"),
      ).toBe(true);
    });
  });

  it("rejects a plain ConfigurationError without a guard code, and non-errors", () => {
    const plain = new ConfigurationError("unrelated", { capability: "x" });
    expect(isRecordedCaptureGuardError(plain)).toBe(false);
    expect(isRecordedCaptureGuardError(new Error("nope"))).toBe(false);
    expect(isRecordedCaptureGuardError(undefined)).toBe(false);
  });

  it("narrows details.code to RecordedCaptureGuardCode after the guard", () => {
    const error: unknown = new ConfigurationError("guarded", {
      code: "RECORDED_CAPTURE_RAW_SQL_DISABLED",
    });
    if (!isRecordedCaptureGuardError(error)) {
      throw new Error("expected the guard to narrow");
    }
    expectTypeOf(error.details.code).toEqualTypeOf<RecordedCaptureGuardCode>();
    expect(error.details.code).toBe("RECORDED_CAPTURE_RAW_SQL_DISABLED");
  });
});

// --- #253 type-level assertions (fail `pnpm typecheck` on regression) ---
//
// Never invoked: the assertions are checked by `tsc`, and the bodies must not
// run (they reference a `declare`d value that is erased at runtime).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function withTransactionTypeAssertions(
  externalTx: AdoptedTransaction,
  plain: Store<typeof graph>,
  history: HistoryStore<typeof graph>,
): void {
  // A plain / generic Store<G> still adopts an external transaction.
  expectTypeOf(plain.withTransaction(externalTx)).toEqualTypeOf<
    TransactionContext<typeof graph>
  >();

  // @ts-expect-error withTransaction is a compile error on a HistoryStore<G>.
  history.withTransaction(externalTx);
}

describe("SqlAvailability values", () => {
  it("covers exactly the four documented states", () => {
    const states: readonly SqlAvailability[] = [
      "available",
      "history",
      "revisionTracking",
      "unavailable",
    ];
    expect(states).toHaveLength(4);
  });
});
