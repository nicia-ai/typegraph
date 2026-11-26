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

/**
 * `pairs` followed by one hole: an index the array's length covers but that
 * holds no element. `map` and `every` skip it; a `for...of` loop reads it as
 * `undefined`.
 */
function withTrailingHole<Pair>(pairs: readonly Pair[]): Pair[] {
  const sparse = [...pairs];
  sparse.length += 1;
  return sparse;
}

type RefusalCase = Readonly<{
  name: string;
  invoke: (identity: RbeIdentity) => Promise<unknown>;
  refusal: abstract new (...args: never[]) => Error;
}>;

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
    },
    {
      name: `${method} malformed validTo`,
      invoke: (identity: RbeIdentity) =>
        identity[method](p1, p2, { validFrom: PAST, validTo: "later" }),
      refusal: ValidationError,
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
      name: `${method} hole after a valid pair`,
      invoke: (identity: RbeIdentity) =>
        identity[method](withTrailingHole([{ a: p1, b: p2 }])),
      refusal: TypeError,
    },
    {
      name: `${method} hole after a valid windowed pair`,
      invoke: (identity: RbeIdentity) =>
        identity[method](withTrailingHole([{ a: p1, b: p2, validFrom: PAST }])),
      refusal: TypeError,
    },
    {
      name: `${method} entry that is not an object`,
      invoke: (identity: RbeIdentity) =>
        identity[method]([
          { a: p1, b: p2, validFrom: PAST },
          7 as unknown as { a: typeof p1; b: typeof p1 },
        ]),
      refusal: TypeError,
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

/**
 * The first issue of a ValidationError — its code, or the field it names
 * when it has none — or what was thrown instead.
 */
async function refusalCode(call: () => Promise<unknown>): Promise<unknown> {
  const error = await rejectionOf(call);
  return error instanceof ValidationError ?
      (error.details.issues[0]?.code ?? error.details.issues[0]?.path)
    : error;
}

/** Endpoint `id` as a reference. */
function ref(id: string): typeof p1 {
  return { kind: "RbePerson", id };
}
/** `pairs`, whose `length` reads 1 the first time and 2 after that. */
function growingPairs(
  pairs: readonly Readonly<{ a: typeof p1; b: typeof p1 }>[],
): readonly Readonly<{ a: typeof p1; b: typeof p1 }>[] {
  const reads = { count: 0 };
  return new Proxy([...pairs], {
    get(target, property, receiver) {
      if (property !== "length") {
        return Reflect.get(target, property, receiver) as unknown;
      }
      reads.count += 1;
      return reads.count === 1 ? 1 : 2;
    },
  });
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
      for (const { name, invoke, refusal } of REFUSALS) {
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
        REFUSALS.flatMap(({ name }) =>
          ["store.identity", "tx.identity"].map((form) => ({
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

    it("tx.identity.assertSame and assertDifferent honor the window they are given", async () => {
      const graph = buildGraph(nextGraphId());
      const store = await context.createStore(graph);
      const createdAt = { validFrom: "2019-01-01T00:00:00.000Z" };
      await store.nodes.RbePerson.create(
        { name: "p1" },
        { id: "p1", ...createdAt },
      );
      await store.nodes.RbePerson.create(
        { name: "p2" },
        { id: "p2", ...createdAt },
      );
      const ended = { validFrom: PAST, validTo: "2021-01-01T00:00:00.000Z" };
      const written = await store.transaction(async (tx) => [
        await tx.identity.assertSame(p1, p2, ended),
        await tx.identity.assertDifferent(p1, p2, {
          validFrom: "2022-01-01T00:00:00.000Z",
          validTo: "2023-01-01T00:00:00.000Z",
        }),
      ]);
      expect(
        written.map(({ assertion }) => [
          assertion.relation,
          assertion.validFrom,
          assertion.validTo,
        ]),
      ).toEqual([
        ["same", PAST, "2021-01-01T00:00:00.000Z"],
        ["different", "2022-01-01T00:00:00.000Z", "2023-01-01T00:00:00.000Z"],
      ]);
      // Both windows have ended: neither holds now.
      expect(await store.identity.areSame(p1, p2)).toBe(false);
      expect(await store.identity.assertionsOf(p1)).toEqual([]);
    });
    // REVERT CHECK: drop the window argument in the transaction receipt
    // wrapper again — both assertions are written as current ones.

    it("a window bound read once before entry is the bound the write uses", async () => {
      const graph = buildGraph(nextGraphId());
      const store = await context.createStore(graph);
      const createdAt = { validFrom: "2019-01-01T00:00:00.000Z" };
      await store.nodes.RbePerson.create(
        { name: "p1" },
        { id: "p1", ...createdAt },
      );
      await store.nodes.RbePerson.create(
        { name: "p2" },
        { id: "p2", ...createdAt },
      );
      /** `base` plus a `validFrom` that turns malformed after its first read. */
      function withShiftingValidFrom<Base extends object>(
        base: Base,
      ): Base & Readonly<{ validFrom: string }> {
        const reads = { count: 0 };
        return Object.defineProperty({ ...base }, "validFrom", {
          enumerable: true,
          get: () => {
            reads.count += 1;
            return reads.count === 1 ? PAST : "malformed";
          },
        }) as Base & Readonly<{ validFrom: string }>;
      }
      const single = await store.identity.assertSame(
        p1,
        p2,
        withShiftingValidFrom({}),
      );
      expect(single.assertion.validFrom).toBe(PAST);
      await store.nodes.RbePerson.create(
        { name: "p3" },
        { id: "p3", ...createdAt },
      );
      const [bulk] = await store.identity.bulkAssertDifferent([
        withShiftingValidFrom({
          a: p2,
          b: { kind: "RbePerson" as const, id: "p3" },
        }),
      ]);
      expect(bulk?.assertion.validFrom).toBe(PAST);
    });
    // REVERT CHECK: hand the caller's window object to the write instead of
    // the validated snapshot — the second read refuses "malformed" under the
    // lock, after statements ran.

    it("a sparse bulk request refused inside a transaction leaves no assertion behind when the callback catches it", async () => {
      const graph = buildGraph(nextGraphId());
      const store = await context.createStore(graph);
      const createdAt = { validFrom: "2019-01-01T00:00:00.000Z" };
      await store.nodes.RbePerson.create(
        { name: "p1" },
        { id: "p1", ...createdAt },
      );
      await store.nodes.RbePerson.create(
        { name: "p2" },
        { id: "p2", ...createdAt },
      );
      const refusals = await store.transaction(async (tx) => [
        await rejectionOf(() =>
          tx.identity.bulkAssertSame(
            withTrailingHole([{ a: p1, b: p2, validFrom: PAST }]),
          ),
        ),
        await rejectionOf(() =>
          tx.identity.bulkAssertDifferent(
            withTrailingHole([{ a: p1, b: p2, validFrom: PAST }]),
          ),
        ),
      ]);
      expect(refusals.map((refusal) => refusal instanceof TypeError)).toEqual([
        true,
        true,
      ]);
      // The callback caught both refusals and committed: neither wrote its
      // first pair, whose open window from PAST would hold now.
      expect(await store.identity.assertionsOf(p1)).toEqual([]);
    });
    // REVERT CHECK: snapshot the pairs with `pairs.map` again — the windowed
    // path writes the first pair before it reads the hole and the callback's
    // catch commits it: the same assertion persists, and the different one
    // is refused as a contradiction rather than for the hole.

    it("a bulk pair's statement-free refusals are reported in pair order, and within a pair a self-assertion before a malformed bound", async () => {
      const graph = buildGraph(nextGraphId());
      const store = await context.createStore(graph);
      const malformed = "yesterday";
      const codes = {
        scalar: await refusalCode(() =>
          store.identity.assertSame(p1, p1, { validFrom: malformed }),
        ),
        onePair: await refusalCode(() =>
          store.identity.bulkAssertSame([
            { a: p1, b: p1, validFrom: malformed },
          ]),
        ),
        selfBeforeLaterBound: await refusalCode(() =>
          store.identity.bulkAssertDifferent([
            { a: p2, b: p2 },
            { a: p1, b: p2, validFrom: malformed },
          ]),
        ),
        boundBeforeLaterSelf: await refusalCode(() =>
          store.identity.bulkAssertDifferent([
            { a: p1, b: p2, validFrom: malformed },
            { a: p2, b: p2 },
          ]),
        ),
      };
      expect(codes).toEqual({
        scalar: "IDENTITY_SELF_ASSERTION",
        onePair: "IDENTITY_SELF_ASSERTION",
        selfBeforeLaterBound: "IDENTITY_SELF_ASSERTION",
        boundBeforeLaterSelf: "validFrom",
      });
    });
    // REVERT CHECK: validate the bounds before the self-assertion in the
    // request — `scalar`, `onePair` report the malformed bound instead.

    it("tx.identity bulk receipts count the pairs the request snapshotted, not a separate read of the input", async () => {
      const graph = buildGraph(nextGraphId());
      const store = await context.createStore(graph);
      for (const id of ["p1", "p2", "p3", "p4", "p5", "p6"]) {
        await store.nodes.RbePerson.create({ name: id }, { id });
      }
      const outcome = await store.transactionWithReceipt(async (tx) => [
        await tx.identity.bulkAssertSame(
          growingPairs([
            { a: ref("p1"), b: ref("p2") },
            { a: ref("p2"), b: ref("p3") },
          ]),
        ),
        await tx.identity.bulkAssertDifferent(
          growingPairs([
            { a: ref("p4"), b: ref("p5") },
            { a: ref("p4"), b: ref("p6") },
          ]),
        ),
      ]);
      const [same, different] = outcome.result;
      expect({
        sameAssertions: outcome.receipt.writes.identity.sameAssertions,
        differentAssertions:
          outcome.receipt.writes.identity.differentAssertions,
      }).toEqual({
        sameAssertions: same?.length,
        differentAssertions: different?.length,
      });
    });
    // REVERT CHECK: count `pairs.length` in the transaction receipt wrapper
    // again — the receipt reports one write of each relation while the
    // request wrote two.

    it("compatibility pin: a read-only transaction's refusal enters no operation (already true before refusals moved ahead of entry)", async () => {
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
          // The holder failing before it holds the lock ends the wait too.
          await Promise.race([
            held.opened,
            holding.then(() => {
              throw new Error("the holder committed without holding the lock");
            }),
          ]);

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
