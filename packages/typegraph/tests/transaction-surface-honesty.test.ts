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
  type AdoptedTransaction,
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type HistoryStore,
  isRecordedCaptureGuardError,
  RECORDED_CAPTURE_GUARD_CODES,
  type RecordedCaptureGuardCode,
  type SqlAvailability,
  type Store,
  type TransactionContext,
} from "../src";
import {
  createInitializedStore,
  createTestBackend,
  disableTransactions,
} from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "transaction_surface_honesty",
  nodes: { Person: { type: Person } },
  edges: {},
});

/** Reads `tx.sql.run` — the access the guard fail-louds on under capture. */
function readSqlRunAccessor(tx: TransactionContext<typeof graph>): unknown {
  return (tx.sql as { run?: unknown }).run;
}

/** Returns whatever `fn` throws, or `undefined` if it does not throw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("#254 tx.sqlAvailability discriminant", () => {
  it("reports 'available' with a usable tx.sql on a plain transactional store", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    await store.transaction(async (tx) => {
      await tx.nodes.Person.create({ name: "probe" });
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
      await tx.nodes.Person.create({ name: "probe" });
      expect(tx.sqlAvailability).toBe("unavailable");
      expect(tx.sql).toBeUndefined();
    });
  });

  it("reports 'history' with a present-but-throwing tx.sql under history capture", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend(), {
      history: true,
    });
    await store.transaction(async (tx) => {
      await tx.nodes.Person.create({ name: "probe" });
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
      await tx.nodes.Person.create({ name: "probe" });
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

    const caught = thrownBy(call);
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
      await tx.nodes.Person.create({ name: "probe" });
      const caught = thrownBy(() => readSqlRunAccessor(tx));
      expect(
        isRecordedCaptureGuardError(
          caught,
          "RECORDED_CAPTURE_RAW_SQL_DISABLED",
        ),
      ).toBe(true);
    });
  });

  it("tags the revision-tracking tx.sql guard with REVISION_TRACKING_RAW_SQL_DISABLED", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend(), {
      revisionTracking: true,
    });
    await store.transaction(async (tx) => {
      await tx.nodes.Person.create({ name: "probe" });
      const caught = thrownBy(() => readSqlRunAccessor(tx));
      expect(
        isRecordedCaptureGuardError(
          caught,
          "REVISION_TRACKING_RAW_SQL_DISABLED",
        ),
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
// run (they reference `declare`d values that are erased at runtime).
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
void withTransactionTypeAssertions;

// Compile-time exhaustiveness pin: `satisfies Record<SqlAvailability, true>`
// fails `pnpm typecheck` if the discriminant ever gains or loses a state (a
// missing key errors, an extra key errors), which the runtime tests above —
// each covering one state — cannot enforce on their own.
({
  available: true,
  history: true,
  revisionTracking: true,
  unavailable: true,
}) satisfies Record<SqlAvailability, true>;
