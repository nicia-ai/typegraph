/**
 * Transaction-surface honesty (#252, #253, #254, #258).
 *
 * Pins the fixes that make the store transaction surface tell the truth:
 * - #253 `withTransaction()` on a {@link AdapterHistoryStore} is a compile error.
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
  type AdapterBackend,
  type AdapterHistoryStore,
  type AdapterStore,
  type AdapterTransactionContext,
  ConfigurationError,
  createAdapterStore,
  createAdapterStoreWithSchema,
  createStore,
  defineGraph,
  defineNode,
  type GraphBackend,
  isRecordedCaptureGuardError,
  RECORDED_CAPTURE_GUARD_CODES,
  type RecordedCaptureGuardCode,
  type SqlAvailability,
  type Store,
  type TransactionContext,
  type TransactionReadBackend,
} from "../src";
import { createGraphBackendProjection } from "../src/backend/graph-backend-projection";
import {
  POSTGRES_CAPABILITIES,
  SQLITE_CAPABILITIES,
} from "../src/backend/types";
import { STORE_RUNTIME } from "../src/store/runtime-port";
import { TRANSACTION_RUNTIME } from "../src/store/types";
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

describe("backend capability descriptors", () => {
  it("freezes the shared dialect capability singletons", () => {
    expect(Object.isFrozen(SQLITE_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(POSTGRES_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(SQLITE_CAPABILITIES.graphAnalytics)).toBe(true);
    expect(Object.isFrozen(POSTGRES_CAPABILITIES.graphAnalytics)).toBe(true);
  });
});

/** Reflectively reads `tx.sql.run` to exercise the runtime-only guard. */
function readSqlRunAccessor(tx: object): unknown {
  return (Reflect.get(tx, "sql") as { run?: unknown }).run;
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
      if (tx.sqlAvailability !== "available") {
        throw new Error("Expected an available adapter transaction");
      }
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
      expect(Reflect.get(tx, "sql")).toBeUndefined();
    });
  });

  it("reports 'history' with a present-but-throwing tx.sql under history capture", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: true },
    );
    await store.transaction(async (tx) => {
      await tx.nodes.Person.create({ name: "probe" });
      expect(tx.sqlAvailability).toBe("history");
      // Present-but-throwing: the property exists, and every access fails loud.
      expect("sql" in tx).toBe(true);
      expect(Object.hasOwn(tx, "sql")).toBe(true);
      expect(() => readSqlRunAccessor(tx)).toThrow(ConfigurationError);
    });
  });

  it("reports 'revisionTracking' with a present-but-throwing tx.sql", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { revisionTracking: true },
    );
    await store.transaction(async (tx) => {
      await tx.nodes.Person.create({ name: "probe" });
      expect(tx.sqlAvailability).toBe("revisionTracking");
      expect("sql" in tx).toBe(true);
      expect(Object.hasOwn(tx, "sql")).toBe(true);
      expect(() => readSqlRunAccessor(tx)).toThrow(ConfigurationError);
    });
  });
});

describe("portable runtime capability boundaries", () => {
  it("does not expose adapter capabilities through a portable Store", async () => {
    const adapterBackend = createTestBackend();
    const store = createStore(graph, adapterBackend);

    expect("backend" in store).toBe(false);
    expect(Object.hasOwn(store, "backend")).toBe(false);
    expect(store.capabilities).toBe(adapterBackend.capabilities);
    expect(
      Object.prototype.propertyIsEnumerable.call(store, STORE_RUNTIME),
    ).toBe(false);

    await store.transaction((tx) => {
      expect(
        Object.prototype.propertyIsEnumerable.call(tx, TRANSACTION_RUNTIME),
      ).toBe(false);
      for (const capability of [
        "insertNode",
        "executeRaw",
        "executeStatement",
        "transactionWithNative",
        "adoptTransaction",
      ]) {
        expect(capability in tx.backend).toBe(false);
        expect(Object.hasOwn(tx.backend, capability)).toBe(false);
      }
      return Promise.resolve();
    });
  });

  it("projects adapter-native methods out of the public AdapterStore backend", () => {
    const adapterBackend = createTestBackend();
    const store = createAdapterStore(graph, adapterBackend);

    expect(store.capabilities).toBe(adapterBackend.capabilities);
    expect(Object.isFrozen(store.backend)).toBe(true);
    for (const capability of ["transactionWithNative", "adoptTransaction"]) {
      expect(capability in store.backend).toBe(false);
      expect(Object.hasOwn(store.backend, capability)).toBe(false);
    }
  });

  it("preserves the absence of optional members in backend projections", () => {
    const { executeRaw: omittedExecuteRaw, ...backendWithoutExecuteRaw } =
      createTestBackend();
    expect(omittedExecuteRaw).toBeDefined();

    const projection = createGraphBackendProjection(backendWithoutExecuteRaw);

    expect("executeRaw" in projection).toBe(false);
    expect(Object.hasOwn(projection, "executeRaw")).toBe(false);
  });

  it("keeps TypeGraph backend writes off adapter transaction contexts", async () => {
    const store = createAdapterStore(graph, createTestBackend());

    await store.transaction((tx) => {
      expect("insertNode" in tx.backend).toBe(false);
      expect("executeRaw" in tx.backend).toBe(false);
      expect(Object.hasOwn(tx.backend, "insertNode")).toBe(false);
      expect(Object.hasOwn(tx.backend, "executeRaw")).toBe(false);
      return Promise.resolve();
    });
  });

  it("projects every capture bypass out of a history Store backend", async () => {
    const backend = createTestBackend();
    const [store] = await createAdapterStoreWithSchema(graph, backend, {
      history: true,
    });
    expect(store.capabilities).toBe(backend.capabilities);
    expect(Object.isFrozen(store.backend)).toBe(true);

    for (const capability of [
      "clearGraph",
      "executeDdl",
      "executeRaw",
      "executeStatement",
      "transaction",
      "trustedImport",
    ]) {
      expect(Reflect.get(store.backend, capability)).toBeUndefined();
      expect(capability in store.backend).toBe(false);
      expect(Object.hasOwn(store.backend, capability)).toBe(false);
    }

    const capturedId = "captured-backend-write";
    await store.backend.insertNode({
      graphId: graph.id,
      kind: "Person",
      id: capturedId,
      props: { name: "captured" },
    });
    const recordedAt = await store.recordedNow();
    expect(recordedAt).toBeDefined();
    if (recordedAt === undefined) throw new Error("Expected recorded instant");
    await expect(
      store.asOfRecorded(recordedAt).nodes.Person.getById(capturedId as never),
    ).resolves.toMatchObject({ name: "captured" });

    const transactionBypassId = "transaction-native-bypass";
    let transactionCallbackRan = false;
    const leakedTransactionWithNative = Reflect.get(
      store.backend,
      "transactionWithNative",
    ) as unknown;
    if (typeof leakedTransactionWithNative === "function") {
      const transactionWithNative =
        leakedTransactionWithNative as AdapterBackend<unknown>["transactionWithNative"];
      await transactionWithNative(async (target) => {
        transactionCallbackRan = true;
        await target.insertNode({
          graphId: graph.id,
          kind: "Person",
          id: transactionBypassId,
          props: { name: "escaped" },
        });
      });
    }

    expect(leakedTransactionWithNative).toBeUndefined();
    expect(transactionCallbackRan).toBe(false);
    expect("transactionWithNative" in store.backend).toBe(false);
    expect(Object.hasOwn(store.backend, "transactionWithNative")).toBe(false);
    await expect(
      backend.getNode(graph.id, "Person", transactionBypassId),
    ).resolves.toBeUndefined();

    const adoptionBypassId = "adopted-native-bypass";
    const leakedAdoptTransaction = Reflect.get(
      store.backend,
      "adoptTransaction",
    ) as unknown;
    await backend.transactionWithNative(async (_target, nativeTransaction) => {
      if (typeof leakedAdoptTransaction === "function") {
        const adoptTransaction =
          leakedAdoptTransaction as AdapterBackend<unknown>["adoptTransaction"];
        const adopted = adoptTransaction(nativeTransaction);
        await adopted.insertNode({
          graphId: graph.id,
          kind: "Person",
          id: adoptionBypassId,
          props: { name: "escaped" },
        });
      }
    });

    expect(leakedAdoptTransaction).toBeUndefined();
    expect("adoptTransaction" in store.backend).toBe(false);
    expect(Object.hasOwn(store.backend, "adoptTransaction")).toBe(false);
    await expect(
      backend.getNode(graph.id, "Person", adoptionBypassId),
    ).resolves.toBeUndefined();
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
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: true },
    );
    // `withTransaction` is a compile error on a history store (#253); casting to
    // the general Store surface exercises the runtime guard behind it.
    const call = (): unknown =>
      (
        store as unknown as Readonly<{
          withTransaction: (externalTx: unknown) => unknown;
        }>
      ).withTransaction({});
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
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: true },
    );
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
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { revisionTracking: true },
    );
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

  it("narrows details.code to the full union when called without a code", () => {
    const error: unknown = new ConfigurationError("guarded", {
      code: "RECORDED_CAPTURE_RAW_SQL_DISABLED",
    });
    if (!isRecordedCaptureGuardError(error)) {
      throw new Error("expected the guard to narrow");
    }
    expectTypeOf(error.details.code).toEqualTypeOf<RecordedCaptureGuardCode>();
    expect(error.details.code).toBe("RECORDED_CAPTURE_RAW_SQL_DISABLED");
  });

  it("narrows details.code to the passed literal when a code is given", () => {
    const error: unknown = new ConfigurationError("guarded", {
      code: "RECORDED_CAPTURE_RAW_SQL_DISABLED",
    });
    if (
      !isRecordedCaptureGuardError(error, "RECORDED_CAPTURE_RAW_SQL_DISABLED")
    ) {
      throw new Error("expected the guard to narrow");
    }
    // The code-specific overload narrows to the literal, not the union.
    expectTypeOf(
      error.details.code,
    ).toEqualTypeOf<"RECORDED_CAPTURE_RAW_SQL_DISABLED">();
    expect(error.details.code).toBe("RECORDED_CAPTURE_RAW_SQL_DISABLED");
  });
});

// --- #253 type-level assertions (fail `pnpm typecheck` on regression) ---
//
// Never invoked: the assertions are checked by `tsc`, and the bodies must not
// run (they reference `declare`d values that are erased at runtime).
function withTransactionTypeAssertions(
  externalTx: unknown,
  portable: Store<typeof graph>,
  plain: AdapterStore<typeof graph, unknown>,
  history: AdapterHistoryStore<typeof graph, unknown>,
): void {
  expectTypeOf<Store<typeof graph>>().not.toHaveProperty("withTransaction");
  expectTypeOf<TransactionContext<typeof graph>>().not.toHaveProperty(
    "sqlAvailability",
  );

  // The default Store keeps graph-owned transactions but does not expose
  // adapter-native handles or caller-owned transaction adoption.
  void portable.transaction((tx) => {
    expectTypeOf(tx).toEqualTypeOf<TransactionContext<typeof graph>>();
    return Promise.resolve();
  });

  // AdapterStore is the explicit native-interoperability surface.
  expectTypeOf(plain.withTransaction(externalTx)).toEqualTypeOf<
    AdapterTransactionContext<typeof graph, unknown>
  >();

  expectTypeOf(history).not.toHaveProperty("withTransaction");
}
void withTransactionTypeAssertions;

function portableFactoryTypeAssertions(backend: GraphBackend): void {
  const store = createStore(graph, backend);
  expectTypeOf(store).toEqualTypeOf<Store<typeof graph>>();
  void store.transaction((tx) => {
    expectTypeOf(tx.backend).toEqualTypeOf<TransactionReadBackend>();
    expectTypeOf(tx.backend).not.toHaveProperty("insertNode");
    expectTypeOf(tx.backend).not.toHaveProperty("executeRaw");
    return Promise.resolve();
  });
}
void portableFactoryTypeAssertions;

type NativeTransactionProbe = Readonly<{
  executeNative: (statement: string) => void;
}>;

function nativeTransactionTypeAssertions(
  backend: AdapterBackend<NativeTransactionProbe>,
  externalTx: NativeTransactionProbe,
): void {
  const store = createAdapterStore(graph, backend);

  void store.transaction((tx) => {
    // @ts-expect-error Native handles require an explicit availability check.
    const leakedToUnknown: unknown = tx.sql;
    void leakedToUnknown;
    if (tx.sqlAvailability === "available") {
      expectTypeOf(tx.sql).toEqualTypeOf<NativeTransactionProbe>();
    }
    return Promise.resolve();
  });
  expectTypeOf(store.withTransaction(externalTx)).toEqualTypeOf<
    AdapterTransactionContext<typeof graph, NativeTransactionProbe>
  >();

  // @ts-expect-error the store accepts only its adapter's native handle.
  store.withTransaction({ executeOther: String });
}
void nativeTransactionTypeAssertions;

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
