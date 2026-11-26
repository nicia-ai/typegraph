/**
 * An identity mutation refuses its statement-free refusals before it enters
 * an operation, on every backend and on both facades.
 *
 * An unregistered kind, a self-assertion, a malformed window bound and a
 * reference that is not an object are decided from the call's own arguments
 * and the registry: no statement can change the verdict. Each refused call
 * below is checked to have entered no operation, opened no transaction
 * session, and called no backend member — the root's `transaction` and every
 * statement a transaction target carries included — so it neither issues the
 * identity graph lock's statement nor waits behind another writer's lock. A
 * refusal judged against the operation's own clock (a future or inverted
 * window) or against stored rows (a non-live endpoint, a contradiction) is not
 * in this matrix: it is decided inside the operation, after the lock.
 *
 * The two-connection case is the observable half on a server: a second
 * connection holds the identity graph lock in an open transaction, a valid
 * mutation is shown to wait behind it, and a refused one is shown not to.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  createStore,
  defineGraph,
  defineNode,
  type GraphBackend,
  KindNotFoundError,
  ValidationError,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { GRAPH_BACKEND_PROJECTION_KEYS } from "../../../src/backend/graph-backend-keys";
import type { TransactionBackend } from "../../../src/backend/types";
import { UnsupportedBackendCapabilityError } from "../../../src/errors-entry";
import type { IdentityFacade } from "../../../src/identity-entry";
import * as operationScope from "../../../src/store/operation-scope";
import {
  createGate,
  raceTimeout,
  TIMEOUT_SENTINEL,
} from "../../concurrency-utils";
import type { IntegrationTestContext } from "./test-context";

const RbePerson = defineNode("RbePerson", {
  schema: z.object({ name: z.string() }),
});

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: { RbePerson: { type: RbePerson } },
    edges: {},
    identity: { sameIdAcrossKinds: "ignore" },
  });
}

type RbeGraph = ReturnType<typeof buildGraph>;
type RbeIdentity = IdentityFacade<RbeGraph>;

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `identity_refusal_before_entry_${graphIdCounter}`;
}

const p1 = { kind: "RbePerson" as const, id: "p1" };
const p2 = { kind: "RbePerson" as const, id: "p2" };
/** A reference to a kind the graph does not register. */
const ghost = { kind: "RbeGhost", id: "g1" } as unknown as typeof p1;
/** A reference that is not an object at all. */
const absent = undefined as unknown as typeof p1;
const PAST = "2020-01-01T00:00:00.000Z";

type Facade = "store.identity" | "tx.identity";

type RefusalCase = Readonly<{
  name: string;
  invoke: (identity: RbeIdentity) => Promise<unknown>;
  refusal: abstract new (...args: never[]) => Error;
  /** The facades the case runs on; both unless stated. */
  facades?: readonly Facade[];
}>;

/**
 * `tx.identity.assertSame` / `assertDifferent` never see a window today: the
 * transaction receipt wrapper forwards only the two references, so there is
 * no window on that facade to refuse. Those cases run on `store.identity`
 * only until the wrapper forwards it.
 */
const WINDOW_FORWARDING_FACADES: readonly Facade[] = ["store.identity"];
const BOTH_FACADES: readonly Facade[] = ["store.identity", "tx.identity"];

/** Every public identity mutation × every refusal it has that needs no statement. */
const REFUSALS: readonly RefusalCase[] = [
  ...(["assertSame", "assertDifferent"] as const).flatMap((method) => [
    {
      name: `${method} unregistered kind`,
      invoke: (identity: RbeIdentity) => identity[method](p1, ghost),
      refusal: KindNotFoundError,
    },
    {
      name: `${method} self-assertion`,
      invoke: (identity: RbeIdentity) => identity[method](p1, p1),
      refusal: ValidationError,
    },
    {
      name: `${method} malformed validFrom`,
      invoke: (identity: RbeIdentity) =>
        identity[method](p1, p2, { validFrom: "yesterday" }),
      refusal: ValidationError,
      facades: WINDOW_FORWARDING_FACADES,
    },
    {
      name: `${method} malformed validTo`,
      invoke: (identity: RbeIdentity) =>
        identity[method](p1, p2, { validFrom: PAST, validTo: "later" }),
      refusal: ValidationError,
      facades: WINDOW_FORWARDING_FACADES,
    },
    {
      name: `${method} reference that is not an object`,
      invoke: (identity: RbeIdentity) => identity[method](p1, absent),
      refusal: TypeError,
    },
  ]),
  ...(["bulkAssertSame", "bulkAssertDifferent"] as const).flatMap((method) => [
    {
      name: `${method} unregistered kind in a later pair`,
      invoke: (identity: RbeIdentity) =>
        identity[method]([
          { a: p1, b: p2 },
          { a: p2, b: ghost },
        ]),
      refusal: KindNotFoundError,
    },
    {
      name: `${method} self-assertion`,
      invoke: (identity: RbeIdentity) => identity[method]([{ a: p2, b: p2 }]),
      refusal: ValidationError,
    },
    {
      name: `${method} windowed self-assertion`,
      invoke: (identity: RbeIdentity) =>
        identity[method]([{ a: p2, b: p2, validFrom: PAST }]),
      refusal: ValidationError,
    },
    {
      name: `${method} windowed unregistered kind`,
      invoke: (identity: RbeIdentity) =>
        identity[method]([{ a: p1, b: ghost, validFrom: PAST }]),
      refusal: KindNotFoundError,
    },
    {
      name: `${method} malformed bound in a later pair`,
      invoke: (identity: RbeIdentity) =>
        identity[method]([
          { a: p1, b: p2, validFrom: PAST },
          { a: p1, b: p2, validTo: "never" },
        ]),
      refusal: ValidationError,
    },
    {
      name: `${method} pairs that are not an array`,
      invoke: (identity: RbeIdentity) =>
        identity[method](undefined as unknown as []),
      refusal: TypeError,
    },
  ]),
  ...(["retractSameAssertion", "retractDifferentAssertion"] as const).flatMap(
    (method) => [
      {
        name: `${method} unregistered kind`,
        invoke: (identity: RbeIdentity) => identity[method](ghost, p1),
        refusal: KindNotFoundError,
      },
      {
        name: `${method} reference that is not an object`,
        invoke: (identity: RbeIdentity) => identity[method](p1, absent),
        refusal: TypeError,
      },
    ],
  ),
];

/**
 * What the promise `call` returns rejects with, or `undefined` when it
 * resolves. A call that throws instead of returning a promise is reported
 * as such: the facade's methods refuse through a rejected promise, never
 * synchronously.
 */
async function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
  let pending: Promise<unknown>;
  try {
    pending = call();
  } catch (error) {
    return { threwSynchronously: error };
  }
  try {
    await pending;
    return undefined;
  } catch (error) {
    return error;
  }
}

const COUNTED_MEMBERS = [
  ...GRAPH_BACKEND_PROJECTION_KEYS,
  "execute",
  "executeRaw",
  "executeStatement",
  "transaction",
  "transactionWithNative",
] as const;

/**
 * `backend`, with every member call — at the root and on every transaction
 * target it opens — recorded in `calls` while counting is on.
 */
function countingBackend(backend: GraphBackend): Readonly<{
  backend: GraphBackend;
  calls: string[];
  setCounting: (on: boolean) => void;
}> {
  const calls: string[] = [];
  const state = { counting: false };
  function instrument<Target extends GraphBackend | TransactionBackend>(
    target: Target,
    prefix: string,
  ): Target {
    const overrides: Record<string, unknown> = {};
    for (const key of new Set<string>(COUNTED_MEMBERS)) {
      const member: unknown = (target as unknown as Record<string, unknown>)[
        key
      ];
      if (typeof member !== "function") continue;
      const call = member as (...args: unknown[]) => unknown;
      overrides[key] =
        key === "transaction" ?
          (
            fn: (tx: TransactionBackend) => Promise<unknown>,
            options: unknown,
          ) => {
            if (state.counting) calls.push(`${prefix}${key}`);
            return call.call(
              target,
              (tx: TransactionBackend) => fn(instrument(tx, "tx.")),
              options,
            );
          }
        : (...args: unknown[]) => {
            if (state.counting) calls.push(`${prefix}${key}`);
            return call.apply(target, args);
          };
    }
    return deriveBackend(target as GraphBackend, overrides as never) as Target;
  }
  return {
    backend: instrument(backend, "root."),
    calls,
    setCounting: (on) => {
      state.counting = on;
    },
  };
}

/** Counts the operations, sessions and target operations minted while it runs. */
async function observe<T>(
  counted: ReturnType<typeof countingBackend>,
  run: () => Promise<T>,
): Promise<
  Readonly<{ result: T; statements: readonly string[]; operations: number }>
> {
  const spies = [
    vi.spyOn(operationScope, "enterOperation"),
    vi.spyOn(operationScope, "enterTargetOperation"),
    vi.spyOn(operationScope, "openTransactionSession"),
  ];
  counted.calls.length = 0;
  counted.setCounting(true);
  try {
    const result = await run();
    return {
      result,
      statements: [...counted.calls],
      operations: spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0),
    };
  } finally {
    counted.setCounting(false);
    for (const spy of spies) spy.mockRestore();
  }
}

export function registerIdentityRefusalBeforeEntryIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("identity mutations refuse before entry", () => {
    it("every statement-free refusal of store.identity and tx.identity enters no operation and calls no backend member", async () => {
      const graph = buildGraph(nextGraphId());
      const seeded = await context.createStore(graph);
      const counted = countingBackend(seeded.backend);
      const store = createStore(graph, counted.backend);
      await store.nodes.RbePerson.create({ name: "p1" }, { id: "p1" });
      await store.nodes.RbePerson.create({ name: "p2" }, { id: "p2" });

      const observed: unknown[] = [];
      for (const {
        name,
        invoke,
        refusal,
        facades = BOTH_FACADES,
      } of REFUSALS) {
        const root = await observe(counted, () =>
          rejectionOf(() => invoke(store.identity)),
        );
        observed.push({
          form: "store.identity",
          name,
          refused: root.result instanceof refusal,
          statements: root.statements,
          operations: root.operations,
        });
        if (!facades.includes("tx.identity")) continue;
        await store.transaction(async (tx) => {
          const scoped = await observe(counted, () =>
            rejectionOf(() => invoke(tx.identity)),
          );
          observed.push({
            form: "tx.identity",
            name,
            refused: scoped.result instanceof refusal,
            statements: scoped.statements,
            operations: scoped.operations,
          });
        });
      }
      expect(observed).toEqual(
        REFUSALS.flatMap(({ name, facades = BOTH_FACADES }) =>
          facades.map((form) => ({
            form,
            name,
            refused: true,
            statements: [],
            operations: 0,
          })),
        ),
      );
      // Nothing was written by any refused call.
      expect(await store.identity.assertionsOf(p1)).toEqual([]);
    });
    // REVERT CHECK: move the refusals back inside `mutate` (as before this
    // change) — every row reports `root.transaction` plus the transaction's
    // schema fence and identity lock statements, and at least one operation.
    // MUTATION CHECK: drop `async` from one facade mutation — its rows report
    // a synchronous throw instead of a rejected promise.

    it("a read-only transaction's refusal enters no operation either", async () => {
      const graph = buildGraph(nextGraphId());
      const seeded = await context.createStore(graph);
      const counted = countingBackend(seeded.backend);
      const store = createStore(graph, counted.backend);
      await store.transaction(
        async (tx) => {
          const scoped = await observe(counted, () =>
            rejectionOf(() => tx.identity.assertSame(p1, p2)),
          );
          expect(scoped.result).toBeInstanceOf(
            UnsupportedBackendCapabilityError,
          );
          expect({
            statements: scoped.statements,
            operations: scoped.operations,
          }).toEqual({ statements: [], operations: 0 });
        },
        { accessMode: "read_only" },
      );
    });

    it.skipIf(!context.serverLaneConcurrency)(
      "a second connection holding the identity graph lock delays a valid mutation but not a refused one",
      async () => {
        const graph = buildGraph(nextGraphId());
        await context.createStore(graph);
        const holder = await context.createSerializedBackend();
        const caller = await context.createSerializedBackend();
        const held = createGate();
        const release = createGate();
        let holding: Promise<unknown> | undefined;
        try {
          const [holderStore] = await createAdapterStoreWithSchema(
            graph,
            holder.backend,
          );
          const [callerStore] = await createAdapterStoreWithSchema(
            graph,
            caller.backend,
          );
          await holderStore.nodes.RbePerson.create(
            { name: "p1" },
            { id: "p1" },
          );
          await holderStore.nodes.RbePerson.create(
            { name: "p2" },
            { id: "p2" },
          );
          holding = holderStore.transaction(async (tx) => {
            // Takes the identity graph lock and keeps it until `release`.
            await tx.identity.assertDifferent(p1, p2);
            held.open();
            await release.opened;
          });
          await held.opened;

          // The lock is held: a valid mutation waits behind it.
          const valid = callerStore.identity.retractSameAssertion(p1, p2);
          expect(await raceTimeout(valid, 500)).toBe(TIMEOUT_SENTINEL);

          for (const { name, invoke, refusal } of REFUSALS) {
            const startedAt = Date.now();
            const outcome = await raceTimeout(
              rejectionOf(() => invoke(callerStore.identity)),
              2000,
            );
            expect({ name, refused: outcome instanceof refusal }).toEqual({
              name,
              refused: true,
            });
            expect(Date.now() - startedAt).toBeLessThan(2000);
          }

          release.open();
          await holding;
          await expect(valid).resolves.toBeUndefined();
        } finally {
          release.open();
          // Already awaited on success; on failure the test reports its own error.
          await holding?.catch((error: unknown) => error);
          await Promise.all([holder.close(), caller.close()]);
        }
      },
    );
    // REVERT CHECK: with the refusals back inside `mutate`, the first refused
    // call times out behind the held lock and the case fails.
  });
}
