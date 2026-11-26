/**
 * What each driver's native transaction handle proves about identity.
 *
 * State TypeGraph keeps for a native transaction can only be keyed by that
 * transaction if the driver's handle distinguishes one BEGIN from the next.
 * These probes state, per driver, whether it does: through the adapter's
 * `transactionWithNative` and through the `tx.sql` a Store transaction
 * exposes.
 *
 * The engine records which native transaction each binding runs on, so the
 * Store sessions of one native transaction share one state
 * (`session.native`) on every driver, including better-sqlite3, whose
 * handle is the long-lived database: the cases below pin that the state is
 * shared within one transaction and never carried into the next.
 *
 * A savepoint is not a transaction of its own: one the engine opens resolves
 * the enclosing transaction's state on every driver that has one. A caller's
 * own savepoint resolves it only where the driver proves the enclosing
 * transaction (`CALLER_SAVEPOINT_PROOF_DRIVERS`); elsewhere Drizzle's
 * savepoint object has no link to the enclosing one, and its sessions share
 * a state of their own (`src/backend/native-transaction-handle.ts`).
 *
 * Two transactions open at once on one pool never share a state.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import { backendDerivationRoot } from "../../../src/backend/derive-backend";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import type { AdapterBackend } from "../../../src/backend/types";
import type { NativeTransactionState } from "../../../src/store/native-transaction-state";
import {
  enterTransactionOperation,
  openTransactionSession,
  operationEntrySession,
} from "../../../src/store/operation-scope";
import { transactionBackend } from "../../../src/store/runtime-port";
import { requireDefined } from "../../../src/utils/presence";
import { PER_BEGIN_NATIVE_DRIVERS } from "../../helpers/native-transaction-handles";
import type {
  IntegrationLaneDriver,
  IntegrationTestContext,
} from "./test-context";

const POSTGRES_DRIVERS: ReadonlySet<IntegrationLaneDriver> = new Set([
  "pglite",
  "node-postgres",
  "postgres-js",
]);

/**
 * Drivers on which a caller's own savepoint inside a TypeGraph-owned
 * transaction carries proof of the enclosing transaction: libSQL and PGlite
 * keep the transaction's Drizzle session, and with it the per-transaction
 * driver handle it pins; better-sqlite3 runs the savepoint on the connection
 * the engine published its open transaction on. node-postgres and
 * postgres-js give the savepoint a new object with no link to the enclosing
 * one (postgres-js a new session and client too).
 */
const CALLER_SAVEPOINT_PROOF_DRIVERS: ReadonlySet<IntegrationLaneDriver> =
  new Set(["better-sqlite3", "libsql", "pglite"]);

/**
 * Drivers whose per-transaction handle reports its transaction closed once it
 * has ended (libSQL's transaction handle, PGlite's transaction client), so a
 * handle retained past its transaction resolves no state at all.
 * node-postgres and postgres-js report nothing on the Drizzle transaction
 * object, which keeps resolving the transaction it was opened for.
 */
const ENDED_HANDLE_SIGNAL_DRIVERS: ReadonlySet<IntegrationLaneDriver> = new Set(
  ["libsql", "pglite"],
);

/** A native transaction handle's own Drizzle `transaction()`. */
type CallerTransactionHandle = Readonly<{
  transaction: <T>(run: (savepoint: object) => T) => T | Promise<T>;
}>;

const ProbeItem = defineNode("ProbeItem", {
  schema: z.object({ label: z.string() }),
});

const probeGraph = defineGraph({
  id: "native_handle_probe",
  nodes: { ProbeItem: { type: ProbeItem } },
  edges: {},
});

/** The native-transaction state of the session a transaction context carries. */
function stateOf(
  context: Parameters<typeof enterTransactionOperation>[0],
): NativeTransactionState {
  return requireDefined(
    operationEntrySession(enterTransactionOperation(context)),
  ).native;
}

export function registerNativeTransactionHandleProbeTests(
  context: IntegrationTestContext,
): void {
  describe("native transaction handle identity", () => {
    it("hands transactionWithNative a distinct native object per BEGIN only on per-BEGIN drivers", async () => {
      const backend = context.getBackend();
      const first = await backend.transactionWithNative((_target, native) =>
        Promise.resolve(native),
      );
      const second = await backend.transactionWithNative((_target, native) =>
        Promise.resolve(native),
      );
      expect({
        driver: context.driver,
        distinctPerBegin: first !== second,
      }).toEqual({
        driver: context.driver,
        distinctPerBegin: PER_BEGIN_NATIVE_DRIVERS.has(context.driver),
      });
    });

    it("exposes a distinct tx.sql per store.transaction attempt only on per-BEGIN drivers", async () => {
      const [store] = await createAdapterStoreWithSchema(
        probeGraph,
        context.getBackend(),
      );
      const first = await store.transaction((tx) =>
        Promise.resolve(
          tx.sqlAvailability === "available" ? tx.sql : undefined,
        ),
      );
      const second = await store.transaction((tx) =>
        Promise.resolve(
          tx.sqlAvailability === "available" ? tx.sql : undefined,
        ),
      );
      expect({
        driver: context.driver,
        exposed: first !== undefined && second !== undefined,
        distinctPerBegin: first !== second,
      }).toEqual({
        driver: context.driver,
        exposed: true,
        distinctPerBegin: PER_BEGIN_NATIVE_DRIVERS.has(context.driver),
      });
    });
  });

  describe("native transaction state", () => {
    it("resolves one state for an opener, two plain adoptions and a history adoption of one native transaction", async () => {
      const backend = context.getBackend();
      const [plain] = await createAdapterStoreWithSchema(probeGraph, backend);
      const [history] = await createAdapterStoreWithSchema(
        probeGraph,
        backend,
        { history: true },
      );
      const observed = await backend.transactionWithNative(
        async (target, native) => {
          const opener = openTransactionSession(target);
          const first = plain.withTransaction(native);
          const second = plain.withTransaction(native);
          const { result: recorded } = await history.withRecordedTransaction(
            native,
            (tx) =>
              Promise.resolve({
                state: stateOf(tx),
                root: backendDerivationRoot(transactionBackend(tx)),
              }),
          );
          return {
            states: [
              opener.native,
              stateOf(first),
              stateOf(second),
              recorded.state,
            ],
            roots: [
              backendDerivationRoot(target),
              backendDerivationRoot(transactionBackend(first)),
              backendDerivationRoot(transactionBackend(second)),
              recorded.root,
            ],
          };
        },
      );
      // Every binding is a derivation root of its own, so nothing keyed by a
      // root can join them; the state does.
      expect(new Set(observed.roots).size).toBe(4);
      const [opener, ...others] = observed.states;
      for (const state of others) expect(state).toBe(opener);
    });

    it("resolves two states for two native transactions", async () => {
      const backend = context.getBackend();
      const [plain] = await createAdapterStoreWithSchema(probeGraph, backend);
      const first = await backend.transactionWithNative((_target, native) =>
        Promise.resolve(stateOf(plain.withTransaction(native))),
      );
      const second = await backend.transactionWithNative((_target, native) =>
        Promise.resolve(stateOf(plain.withTransaction(native))),
      );
      expect(second).not.toBe(first);
    });

    // Only the server lanes hold two transactions open at once: every
    // in-process lane serializes them on one connection.
    it.runIf(context.serverLaneConcurrency)(
      "resolves a state of its own for each of two transactions open at once on one pool",
      async () => {
        const backend = context.getBackend();
        const [plain] = await createAdapterStoreWithSchema(probeGraph, backend);
        const opens: (() => void)[] = [];
        const bothOpen = new Promise<void>((resolve) => {
          opens.push(resolve);
        });
        let opened = 0;
        const observe = (): Promise<
          Readonly<{
            opener: NativeTransactionState;
            adopted: NativeTransactionState;
            native: unknown;
          }>
        > =>
          backend.transactionWithNative(async (target, native) => {
            const opener = openTransactionSession(target).native;
            opened += 1;
            if (opened === 2) for (const open of opens) open();
            await bothOpen;
            return {
              opener,
              adopted: stateOf(plain.withTransaction(native)),
              native,
            };
          });
        const [first, second] = await Promise.all([observe(), observe()]);
        expect(first.native).not.toBe(second.native);
        expect(first.adopted).toBe(first.opener);
        expect(second.adopted).toBe(second.opener);
        expect(second.opener).not.toBe(first.opener);
      },
    );

    it("never resolves an ended transaction's state from a handle retained into the next one", async () => {
      const backend = context.getBackend();
      const [plain] = await createAdapterStoreWithSchema(probeGraph, backend);
      const first = await backend.transactionWithNative((_target, native) =>
        Promise.resolve({
          native,
          state: stateOf(plain.withTransaction(native)),
        }),
      );
      const second = await backend.transactionWithNative((_target, native) =>
        Promise.resolve({
          current: stateOf(plain.withTransaction(native)),
          retained: stateOf(plain.withTransaction(first.native)),
        }),
      );
      const afterwards = [
        stateOf(plain.withTransaction(first.native)),
        stateOf(plain.withTransaction(first.native)),
      ];
      const perBegin = PER_BEGIN_NATIVE_DRIVERS.has(context.driver);
      // A handle that reports its transaction ended resolves no state once it
      // has; a per-BEGIN object that reports nothing still names the
      // transaction it was opened for, never another.
      const namesEnded =
        perBegin && !ENDED_HANDLE_SIGNAL_DRIVERS.has(context.driver);
      expect(second.current).not.toBe(first.state);
      // On better-sqlite3 the retained handle is the database, which inside
      // the next transaction is that transaction's handle.
      expect({
        driver: context.driver,
        retainedIsFirst: second.retained === first.state,
        retainedIsCurrent: second.retained === second.current,
      }).toEqual({
        driver: context.driver,
        retainedIsFirst: namesEnded,
        retainedIsCurrent: !perBegin,
      });
      // After both ended: the database object, outside any transaction the
      // engine opened, identifies none, and neither does a handle that
      // reported its end: each binding gets a state of its own.
      expect({
        driver: context.driver,
        firstTransaction: afterwards.map((state) => state === first.state),
        secondTransaction: afterwards.map((state) => state === second.current),
        shared: afterwards[0] === afterwards[1],
      }).toEqual({
        driver: context.driver,
        firstTransaction: [namesEnded, namesEnded],
        secondTransaction: [false, false],
        shared: namesEnded,
      });
    });
  });

  describe("native transaction state of a savepoint", () => {
    it("resolves a caller's own savepoint in a TypeGraph-owned transaction to the enclosing state exactly where the driver proves the enclosing transaction", async () => {
      const backend = context.getBackend();
      const [plain] = await createAdapterStoreWithSchema(probeGraph, backend);
      const observed = await backend.transactionWithNative(
        async (target, native) => {
          const opener = openTransactionSession(target).native;
          // Returns synchronously: better-sqlite3 runs the savepoint's
          // callback synchronously and refuses a promise.
          const inSavepoint = await (
            native as CallerTransactionHandle
          ).transaction((savepoint) => [
            stateOf(plain.withTransaction(savepoint)),
            stateOf(plain.withTransaction(savepoint)),
          ]);
          return { opener, inSavepoint };
        },
      );
      const [first, second] = observed.inSavepoint;
      expect({
        driver: context.driver,
        joinsEnclosing: first === observed.opener,
        sharedWithinSavepoint: first === second,
      }).toEqual({
        driver: context.driver,
        joinsEnclosing: CALLER_SAVEPOINT_PROOF_DRIVERS.has(context.driver),
        sharedWithinSavepoint: true,
      });
    });

    // SQLite has no factory for a backend over a caller's transaction.
    describe.runIf(POSTGRES_DRIVERS.has(context.driver))(
      "over createPostgresTransactionBackend",
      () => {
        it("resolves the enclosing transaction's state in every savepoint the engine opens, at any depth, and in a Store's transaction", async () => {
          const backend = context.getBackend();
          const states = await backend.transactionWithNative(
            async (target, native) => {
              const opener = openTransactionSession(target).native;
              const overTransaction = createPostgresBackend(
                native as never,
              ) as AdapterBackend<unknown>;
              const [store] = await createAdapterStoreWithSchema(
                probeGraph,
                overTransaction,
              );
              const inStoreTransaction = await store.transaction((tx) =>
                Promise.resolve(stateOf(tx)),
              );
              const inSavepoints = await overTransaction.transactionWithNative(
                async (savepointTarget, savepoint) => {
                  const overSavepoint = createPostgresBackend(
                    savepoint as never,
                  ) as AdapterBackend<unknown>;
                  const nested = await overSavepoint.transactionWithNative(
                    (nestedTarget) =>
                      Promise.resolve(
                        openTransactionSession(nestedTarget).native,
                      ),
                  );
                  return [
                    openTransactionSession(savepointTarget).native,
                    stateOf(store.withTransaction(savepoint)),
                    nested,
                  ];
                },
              );
              return {
                opener,
                others: [
                  stateOf(store.withTransaction(native)),
                  inStoreTransaction,
                  ...inSavepoints,
                ],
              };
            },
          );
          expect(states.others).toHaveLength(5);
          for (const state of states.others) expect(state).toBe(states.opener);
        });
      },
    );
  });
}
