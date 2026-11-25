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
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import { backendDerivationRoot } from "../../../src/backend/derive-backend";
import type { NativeTransactionState } from "../../../src/store/native-transaction-state";
import {
  enterTransactionOperation,
  openTransactionSession,
  operationEntrySession,
} from "../../../src/store/operation-scope";
import { transactionBackend } from "../../../src/store/runtime-port";
import { requireDefined } from "../../../src/utils/presence";
import { PER_BEGIN_NATIVE_DRIVERS } from "../../helpers/native-transaction-handles";
import type { IntegrationTestContext } from "./test-context";

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
      expect(second.current).not.toBe(first.state);
      // A per-BEGIN handle names the transaction it was opened for; on
      // better-sqlite3 the retained handle is the database, which inside the
      // next transaction is that transaction's handle.
      const retainedOwner = perBegin ? first.state : second.current;
      expect(second.retained).toBe(retainedOwner);
      // After both ended, a per-BEGIN handle still names the first
      // transaction. The database object, outside any transaction the engine
      // opened, identifies none: each binding gets a state of its own.
      expect({
        driver: context.driver,
        firstTransaction: afterwards.map((state) => state === first.state),
        secondTransaction: afterwards.map((state) => state === second.current),
        shared: afterwards[0] === afterwards[1],
      }).toEqual({
        driver: context.driver,
        firstTransaction: [perBegin, perBegin],
        secondTransaction: [false, false],
        shared: perBegin,
      });
    });
  });
}
