/**
 * Writes inside `store.transaction(fn, { accessMode: "read_only" })`, on
 * every backend.
 *
 * Every write entry point a transaction context offers is refused by the
 * store itself, with the one read-only refusal
 * (`refuseReadOnlyTransactionWrite`), before it reaches the backend: no
 * backend member runs, so SQLite never writes and PostgreSQL never reports
 * its own read-only error, which would abort the caller's transaction. The
 * transaction stays usable after the refusal and commits.
 *
 * The collection and identity cases are driven by the write-name lists in
 * `collection-surface.ts`, through records typed over those lists, so a new
 * write method fails to compile here until it has a case.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStore,
  createAdapterStoreWithSchema,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  partOf,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { GRAPH_BACKEND_PROJECTION_KEYS } from "../../../src/backend/graph-backend-keys";
import { createPostgresTransactionBackend } from "../../../src/backend/postgres";
import {
  type AdapterBackend,
  type TransactionBackend,
} from "../../../src/backend/types";
import { UnsupportedBackendCapabilityError } from "../../../src/errors-entry";
import { defineGraphExtension } from "../../../src/graph-extension";
import { branch } from "../../../src/graph-merge/branch";
import { MergeError } from "../../../src/graph-merge/errors";
import {
  applyMergePlanInTransaction,
  planMerge,
} from "../../../src/graph-merge/merge";
import { asBranchId } from "../../../src/graph-merge/types";
import { exportGraph, importGraph } from "../../../src/interchange";
import type {
  EDGE_WRITE_NAMES,
  IDENTITY_WRITE_NAMES,
  NODE_WRITE_NAMES,
} from "../../../src/store/collection-surface";
import { requireDefined } from "../../../src/utils/presence";
import { unwrap } from "../../../src/utils/result";
import { type IntegrationTestContext } from "./test-context";

const RotPerson = defineNode("RotPerson", {
  schema: z.object({ name: z.string(), email: z.string() }),
});
const RotTeam = defineNode("RotTeam", {
  schema: z.object({ name: z.string() }),
});
const rotKnows = defineEdge("rotKnows", { schema: z.object({}) });
const rotMemberOf = defineEdge("rotMemberOf", { schema: z.object({}) });

const PERSON_EMAIL = {
  name: "rot_person_email",
  fields: ["email"],
  scope: "kind",
  collation: "binary",
} as const;

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      RotPerson: {
        type: RotPerson,
        unique: [PERSON_EMAIL],
        onDelete: "cascade",
      },
      RotTeam: { type: RotTeam, onDelete: "cascade" },
    },
    edges: {
      rotKnows: { type: rotKnows, from: [RotPerson], to: [RotPerson] },
      rotMemberOf: {
        type: rotMemberOf,
        from: [RotPerson],
        to: [RotTeam],
        cardinality: "one",
      },
    },
    ontology: [partOf(RotPerson, RotTeam, { via: rotMemberOf })],
    identity: { sameIdAcrossKinds: "ignore" },
  });
}

type RotGraph = ReturnType<typeof buildGraph>;

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `read_only_transaction_writes_${graphIdCounter}`;
}

/** The untyped surface every case calls: arguments are the case's business. */
type AnyMethods = Readonly<Record<string, (...args: never[]) => unknown>>;

type TransactionSurface = Readonly<{
  nodes: Readonly<Record<string, AnyMethods>>;
  edges: Readonly<Record<string, AnyMethods>>;
  identity: AnyMethods;
  writeNodeUpsertBatch: (entries: readonly unknown[]) => Promise<unknown>;
}>;

function person(id: string): never {
  return { kind: "RotPerson", id } as never;
}

function team(id: string): never {
  return { kind: "RotTeam", id } as never;
}

function call(
  methods: AnyMethods,
  name: string,
  ...args: readonly unknown[]
): Promise<unknown> {
  const method = methods[name] as (...a: readonly unknown[]) => unknown;
  return Promise.resolve().then(() => method.apply(methods, [...args]));
}

type Invoke = (methods: AnyMethods) => Promise<unknown>;

const NODE_WRITES: Readonly<Record<(typeof NODE_WRITE_NAMES)[number], Invoke>> =
  {
    create: (c) => call(c, "create", { name: "n", email: "n@example.test" }),
    createFromRecord: (c) =>
      call(c, "createFromRecord", { name: "n", email: "n@example.test" }),
    update: (c) => call(c, "update", asNodeId("p1"), { name: "renamed" }),
    reparent: (c) => call(c, "reparent", asNodeId("p1"), { to: team("t2") }),
    bulkReparent: (c) =>
      call(c, "bulkReparent", [
        { id: asNodeId("p1"), options: { to: team("t2") } },
      ]),
    compareAndSet: (c) =>
      call(c, "compareAndSet", asNodeId("p1"), {
        expected: { name: "p1" },
        patch: { name: "renamed" },
      }),
    updateWhere: (c) => call(c, "updateWhere", { patch: { name: "renamed" } }),
    delete: (c) => call(c, "delete", asNodeId("p2")),
    hardDelete: (c) => call(c, "hardDelete", asNodeId("p2")),
    upsertById: (c) =>
      call(c, "upsertById", "p9", { name: "p9", email: "p9@example.test" }),
    upsertByIdFromRecord: (c) =>
      call(c, "upsertByIdFromRecord", "p9", {
        name: "p9",
        email: "p9@example.test",
      }),
    bulkCreate: (c) =>
      call(c, "bulkCreate", [
        { props: { name: "b", email: "b@example.test" } },
      ]),
    bulkReplaceById: (c) =>
      call(c, "bulkReplaceById", [
        { id: "p1", props: { name: "r", email: "p1@example.test" } },
      ]),
    bulkUpsertById: (c) =>
      call(c, "bulkUpsertById", [
        { id: "p9", props: { name: "p9", email: "p9@example.test" } },
      ]),
    bulkInsert: (c) =>
      call(c, "bulkInsert", [
        { props: { name: "i", email: "i@example.test" } },
      ]),
    bulkDelete: (c) => call(c, "bulkDelete", [asNodeId("p2")]),
    bulkHardDelete: (c) => call(c, "bulkHardDelete", [asNodeId("p2")]),
    getOrCreateByConstraint: (c) =>
      call(c, "getOrCreateByConstraint", PERSON_EMAIL.name, {
        name: "g",
        email: "g@example.test",
      }),
    bulkGetOrCreateByConstraint: (c) =>
      call(c, "bulkGetOrCreateByConstraint", PERSON_EMAIL.name, [
        { props: { name: "g", email: "g@example.test" } },
      ]),
  };

const EDGE_WRITES: Readonly<Record<(typeof EDGE_WRITE_NAMES)[number], Invoke>> =
  {
    create: (c) => call(c, "create", person("p2"), person("p1"), {}),
    update: (c) => call(c, "update", "k1", {}),
    delete: (c) => call(c, "delete", "k1"),
    hardDelete: (c) => call(c, "hardDelete", "k1"),
    bulkCreate: (c) =>
      call(c, "bulkCreate", [
        { from: person("p2"), to: person("p1"), props: {} },
      ]),
    bulkUpsertById: (c) =>
      call(c, "bulkUpsertById", [
        { id: "k9", from: person("p2"), to: person("p1"), props: {} },
      ]),
    bulkInsert: (c) =>
      call(c, "bulkInsert", [
        { from: person("p2"), to: person("p1"), props: {} },
      ]),
    bulkDelete: (c) => call(c, "bulkDelete", ["k1"]),
    bulkHardDelete: (c) => call(c, "bulkHardDelete", ["k1"]),
    getOrCreateByEndpoints: (c) =>
      call(c, "getOrCreateByEndpoints", person("p2"), person("p1"), {}),
    bulkGetOrCreateByEndpoints: (c) =>
      call(c, "bulkGetOrCreateByEndpoints", [
        { from: person("p2"), to: person("p1"), props: {} },
      ]),
  };

const IDENTITY_WRITES: Readonly<
  Record<(typeof IDENTITY_WRITE_NAMES)[number], Invoke>
> = {
  assertSame: (c) => call(c, "assertSame", person("p1"), person("p2")),
  assertDifferent: (c) =>
    call(c, "assertDifferent", person("p1"), person("p2")),
  bulkAssertSame: (c) =>
    call(c, "bulkAssertSame", [[person("p1"), person("p2")]]),
  bulkAssertDifferent: (c) =>
    call(c, "bulkAssertDifferent", [[person("p1"), person("p2")]]),
  retractAssertion: (c) => call(c, "retractAssertion", "a1"),
  retractSameAssertion: (c) =>
    call(c, "retractSameAssertion", person("p1"), person("p2")),
  retractDifferentAssertion: (c) =>
    call(c, "retractDifferentAssertion", person("p1"), person("p2")),
  bulkRetractAssertions: (c) => call(c, "bulkRetractAssertions", ["a1"]),
};

type Case = Readonly<{
  operation: string;
  invoke: (tx: TransactionSurface) => Promise<unknown>;
}>;

const CASES: readonly Case[] = [
  ...Object.entries(NODE_WRITES).map(([method, invoke]) => ({
    operation: `tx.nodes.RotPerson.${method}()`,
    invoke: (tx: TransactionSurface) => invoke(tx.nodes["RotPerson"] ?? {}),
  })),
  ...Object.entries(EDGE_WRITES).map(([method, invoke]) => ({
    operation: `tx.edges.rotKnows.${method}()`,
    invoke: (tx: TransactionSurface) => invoke(tx.edges["rotKnows"] ?? {}),
  })),
  ...Object.entries(IDENTITY_WRITES).map(([method, invoke]) => ({
    operation: `tx.identity.${method}()`,
    invoke: (tx: TransactionSurface) => invoke(tx.identity),
  })),
  {
    operation: "tx.writeNodeUpsertBatch()",
    invoke: (tx) =>
      tx.writeNodeUpsertBatch([
        {
          kind: "RotPerson",
          id: "p9",
          props: { name: "p9", email: "p9@example.test" },
        },
      ]),
  },
];

/** `target`, reporting the name of every backend member called through it. */
function instrumentTransactionTarget(
  target: TransactionBackend,
  record: (key: string) => void,
): TransactionBackend {
  const overrides: Record<string, unknown> = {};
  for (const key of GRAPH_BACKEND_PROJECTION_KEYS) {
    const member: unknown = (target as unknown as Record<string, unknown>)[key];
    if (typeof member !== "function") continue;
    overrides[key] = (...args: unknown[]) => {
      record(key);
      return (member as (...a: unknown[]) => unknown).apply(target, args);
    };
  }
  return deriveBackend(target, overrides as never);
}

/**
 * `backend`, with every backend member of a transaction it adopts counted in
 * `calls` while `counting` is on.
 */
function countingAdoptionBackend(backend: AdapterBackend<unknown>): Readonly<{
  backend: AdapterBackend<unknown>;
  calls: string[];
  setCounting: (on: boolean) => void;
}> {
  const calls: string[] = [];
  let counting = false;
  return {
    backend: deriveBackend(backend, {
      adoptTransaction: (externalTransaction) =>
        instrumentTransactionTarget(
          backend.adoptTransaction(externalTransaction),
          (key) => {
            if (counting) calls.push(key);
          },
        ),
    }),
    calls,
    setCounting: (on) => {
      counting = on;
    },
  };
}

/** The native handle a transaction context exposes as `tx.sql`. */
function nativeHandle(tx: object): unknown {
  return requireDefined((tx as Readonly<{ sql?: unknown }>).sql);
}

type AdoptingStore = Readonly<{
  withTransaction: (externalTx: unknown) => unknown;
  withRecordedTransaction: (
    externalTx: unknown,
    fn: (tx: unknown) => Promise<void>,
  ) => Promise<unknown>;
}>;

type Adoption = Readonly<{
  entry: string;
  run: (
    store: AdoptingStore,
    externalTx: unknown,
    body: (adopted: TransactionSurface) => Promise<void>,
  ) => Promise<void>;
}>;

/** Every way a store builds a write context over a caller's native handle. */
const ADOPTIONS: readonly Adoption[] = [
  {
    entry: "store.withTransaction(tx.sql)",
    run: (store, externalTx, body) =>
      body(store.withTransaction(externalTx) as TransactionSurface),
  },
  {
    entry: "store.withRecordedTransaction(tx.sql, fn)",
    run: async (store, externalTx, body) => {
      await store.withRecordedTransaction(externalTx, (adopted) =>
        body(adopted as TransactionSurface),
      );
    },
  },
];

/**
 * `backend`, with every backend member a transaction target exposes counted
 * in `calls` while `counting` is on.
 */
function countingBackend(backend: GraphBackend): Readonly<{
  backend: GraphBackend;
  calls: string[];
  setCounting: (on: boolean) => void;
}> {
  const calls: string[] = [];
  let counting = false;
  const instrument = (target: TransactionBackend): TransactionBackend =>
    instrumentTransactionTarget(target, (key) => {
      if (counting) calls.push(key);
    });
  return {
    backend: deriveBackend(backend, {
      transaction: (fn, options) =>
        backend.transaction((tx) => fn(instrument(tx)), options),
    }),
    calls,
    setCounting: (on) => {
      counting = on;
    },
  };
}

/** Two people, a team, a link between the people and an identity assertion. */
async function seed(
  store: ReturnType<typeof createStore<RotGraph>>,
): Promise<void> {
  await store.nodes.RotPerson.create(
    { name: "p1", email: "p1@example.test" },
    { id: "p1" },
  );
  await store.nodes.RotPerson.create(
    { name: "p2", email: "p2@example.test" },
    { id: "p2" },
  );
  await store.nodes.RotTeam.create({ name: "t1" }, { id: "t1" });
  await store.nodes.RotTeam.create({ name: "t2" }, { id: "t2" });
  await store.edges.rotKnows.create(
    person("p1"),
    person("p2"),
    {},
    {
      id: "k1",
    },
  );
  await store.edges.rotMemberOf.create(
    person("p1"),
    team("t1"),
    {},
    {
      id: "m1",
    },
  );
}

async function graphState(
  store: ReturnType<typeof createStore<RotGraph>>,
): Promise<unknown> {
  const people = await store.nodes.RotPerson.find();
  const teams = await store.nodes.RotTeam.find();
  const knows = await store.edges.rotKnows.find();
  const memberOf = await store.edges.rotMemberOf.find();
  return {
    people: people.map((node) => [node.id, node.name]),
    teams: teams.map((node) => node.id),
    knows: knows.map((edge) => edge.id),
    memberOf: memberOf.map((edge) => edge.id),
    classes: await store.identity.classes({ limit: 100 }),
  };
}

/** What `pending` rejects with, or `undefined` when it resolves. */
async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectReadOnlyRefusal(
  error: unknown,
  operation: string,
  graphId: string,
): void {
  expect(error).toBeInstanceOf(UnsupportedBackendCapabilityError);
  expect({
    operation,
    details: (error as UnsupportedBackendCapabilityError).details,
  }).toEqual({
    operation,
    details: {
      operation,
      capability: "write transaction access",
      graphId,
      accessMode: "read_only",
    },
  });
}

export function registerReadOnlyTransactionWritesIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("writes in a read-only transaction", () => {
    it("refuses every transaction write entry point before any backend call, and the transaction stays usable", async () => {
      const graph = buildGraph(nextGraphId());
      const seeded = await context.createStore(graph, {
        revisionTracking: true,
      });
      const counted = countingBackend(seeded.backend);
      const store = createStore(graph, counted.backend, {
        revisionTracking: true,
      });
      await seed(store);
      const before = await graphState(store);

      for (const { operation, invoke } of CASES) {
        let refusal: unknown;
        const committed = await store.transaction(
          async (tx) => {
            counted.setCounting(true);
            refusal = await rejectionOf(
              invoke(tx as unknown as TransactionSurface),
            );
            counted.setCounting(false);
            // Still usable: on PostgreSQL an engine-rejected write would
            // abort the transaction and fail this read.
            return tx.nodes.RotPerson.getById(asNodeId("p1"));
          },
          { accessMode: "read_only" },
        );
        expectReadOnlyRefusal(refusal, operation, graph.id);
        expect({ operation, calls: counted.calls }).toEqual({
          operation,
          calls: [],
        });
        expect(committed?.id).toBe("p1");
      }
      expect(await graphState(store)).toEqual(before);
    });
    // MUTATION CHECK: drop the read-only arm of the receipt recorder's
    // `assertWritable` — both cases fail: the first write is not refused by
    // the store (on SQLite `create` commits its row).

    it("refuses applyMergePlanInTransaction, writes nothing, and the transaction stays usable", async () => {
      const graph = buildGraph(nextGraphId());
      const target = await context.createStore(graph, {
        revisionTracking: true,
      });
      await seed(target);
      const source = unwrap(
        await branch(target, () => context.createIsolatedBackend(), {
          id: asBranchId("read-only-merge"),
        }),
      );
      await source.store.nodes.RotPerson.create(
        { name: "p5", email: "p5@example.test" },
        { id: "p5" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      let refusal: unknown;
      const committed = await target.transaction(
        async (tx) => {
          refusal = await rejectionOf(
            applyMergePlanInTransaction(target, tx, artifact),
          );
          return tx.nodes.RotPerson.getById(asNodeId("p1"));
        },
        { accessMode: "read_only" },
      );
      expect(committed?.id).toBe("p1");
      // Merge reports every failure as a MergeError; the refusal is its cause.
      expect(refusal).toBeInstanceOf(MergeError);
      expectReadOnlyRefusal(
        (refusal as MergeError).cause,
        "applyMergePlanInTransaction()",
        graph.id,
      );
      expect(
        await target.nodes.RotPerson.getById(asNodeId("p5")),
      ).toBeUndefined();
    });
    // MUTATION CHECK: drop the `transactionAssertWritable` call from
    // `applyMergePlanInTransaction` — the apply is not refused.
  });

  describe("writes through a context adopted over a read-only transaction's native handle", () => {
    // `tx.sql` of `store.transaction(fn, { accessMode: "read_only" })`, handed
    // back to the store, builds a NEW context. The read-only fact is bound to
    // the handle's native session, so that context refuses exactly as the
    // original does, before any statement, on every backend.
    for (const adoption of ADOPTIONS) {
      it(`refuses every write entry point through ${adoption.entry} before any backend call, and the transaction stays usable`, async () => {
        const graph = buildGraph(nextGraphId());
        const counted = countingAdoptionBackend(context.getBackend());
        const [store] = await createAdapterStoreWithSchema(
          graph,
          counted.backend,
        );
        await seed(store);
        const before = await graphState(store);

        for (const { operation, invoke } of CASES) {
          let refusal: unknown;
          const committed = await store.transaction(
            async (tx) => {
              await adoption.run(store, nativeHandle(tx), async (adopted) => {
                counted.setCounting(true);
                refusal = await rejectionOf(invoke(adopted));
                counted.setCounting(false);
              });
              // Still usable: on PostgreSQL an engine-rejected write would
              // abort the transaction and fail this read.
              return tx.nodes.RotPerson.getById(asNodeId("p1"));
            },
            { accessMode: "read_only" },
          );
          expectReadOnlyRefusal(refusal, operation, graph.id);
          expect({ operation, calls: counted.calls }).toEqual({
            operation,
            calls: [],
          });
          expect(committed?.id).toBe("p1");
        }
        expect(await graphState(store)).toEqual(before);
      });
    }
    // MUTATION CHECK: build the adopted contexts' write access from
    // `transactionReadOnlyAccess(undefined)` instead of the handle — every
    // case fails: SQLite commits the write, PostgreSQL reports its own
    // read-only error and aborts the transaction.

    it("refuses applyMergePlanInTransaction through store.withRecordedTransaction(tx.sql, fn)", async () => {
      const graph = buildGraph(nextGraphId());
      const backend = context.getBackend();
      // A public merge plan needs revision tracking, which withholds tx.sql;
      // a plain store over the same graph opens the read-only transaction.
      const [plain] = await createAdapterStoreWithSchema(graph, backend);
      const [target] = await createAdapterStoreWithSchema(graph, backend, {
        revisionTracking: true,
      });
      await seed(target);
      const source = unwrap(
        await branch(target, () => context.createIsolatedBackend(), {
          id: asBranchId("read-only-adopted-merge"),
        }),
      );
      await source.store.nodes.RotPerson.create(
        { name: "p5", email: "p5@example.test" },
        { id: "p5" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      let refusal: unknown;
      const committed = await plain.transaction(
        async (tx) => {
          // Merge apply needs an active callback of its target, which an
          // adopted withRecordedTransaction callback is.
          await target.withRecordedTransaction(
            nativeHandle(tx),
            async (adopted) => {
              refusal = await rejectionOf(
                applyMergePlanInTransaction(target, adopted, artifact),
              );
            },
          );
          return tx.nodes.RotPerson.getById(asNodeId("p1"));
        },
        { accessMode: "read_only" },
      );
      expect(committed?.id).toBe("p1");
      expect(refusal).toBeInstanceOf(MergeError);
      expectReadOnlyRefusal(
        (refusal as MergeError).cause,
        "applyMergePlanInTransaction()",
        graph.id,
      );
      expect(
        await target.nodes.RotPerson.getById(asNodeId("p5")),
      ).toBeUndefined();
    });

    it("refuses store.withEvolvedTransaction(tx.sql) before its callback", async () => {
      const graph = buildGraph(nextGraphId());
      const [store] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
      );
      await seed(store);
      const before = await graphState(store);
      const plan = await store.planEvolution(
        defineGraphExtension({
          nodes: { RotExtra: { properties: { label: { type: "string" } } } },
        }),
      );
      // The refusal precedes every look at the plan, so a changing plan
      // stands for a no-op one too.
      expect(plan.status).toBe("change");
      let callbackRan = false;
      let refusal: unknown;
      const committed = await store.transaction(
        async (tx) => {
          refusal = await rejectionOf(
            store.withEvolvedTransaction(nativeHandle(tx), plan, async () => {
              callbackRan = true;
              await Promise.resolve();
            }),
          );
          return tx.nodes.RotPerson.getById(asNodeId("p1"));
        },
        { accessMode: "read_only" },
      );
      expectReadOnlyRefusal(
        refusal,
        "store.withEvolvedTransaction()",
        graph.id,
      );
      expect(callbackRan).toBe(false);
      expect(committed?.id).toBe("p1");
      const active = await context.getBackend().getActiveSchema(graph.id);
      expect(active?.version).toBe(1);
      expect(await graphState(store)).toEqual(before);
    });

    it("refuses a history store's withRecordedTransaction(tx.sql) before its callback", async () => {
      const graph = buildGraph(nextGraphId());
      const backend = context.getBackend();
      const [plain] = await createAdapterStoreWithSchema(graph, backend);
      const [history] = await createAdapterStoreWithSchema(graph, backend, {
        history: true,
      });
      await seed(plain);
      const before = await graphState(plain);

      let callbackRan = false;
      let refusal: unknown;
      const committed = await plain.transaction(
        async (tx) => {
          refusal = await rejectionOf(
            history.withRecordedTransaction(nativeHandle(tx), async () => {
              callbackRan = true;
              await Promise.resolve();
            }),
          );
          return tx.nodes.RotPerson.getById(asNodeId("p1"));
        },
        { accessMode: "read_only" },
      );
      expectReadOnlyRefusal(
        refusal,
        "store.withRecordedTransaction()",
        graph.id,
      );
      expect(callbackRan).toBe(false);
      expect(committed?.id).toBe("p1");
      expect(await graphState(plain)).toEqual(before);
    });

    it("does not outlive the transaction: the same adoption writes in a read-write transaction afterwards", async () => {
      const graph = buildGraph(nextGraphId());
      const [store] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
      );
      await seed(store);
      await store.transaction(
        async (tx) => tx.nodes.RotPerson.getById(asNodeId("p1")),
        { accessMode: "read_only" },
      );
      await store.transaction(async (tx) => {
        await store
          .withTransaction(nativeHandle(tx))
          .nodes.RotTeam.create({ name: "t3" }, { id: "t3" });
      });
      const team = await store.nodes.RotTeam.getById(asNodeId("t3"));
      expect(team?.id).toBe("t3");
    });
  });

  // SQLite has no factory for a backend over a caller's transaction.
  describe.runIf(
    context.driver === "pglite" ||
      context.driver === "node-postgres" ||
      context.driver === "postgres-js",
  )(
    "writes through a Store over createPostgresTransactionBackend(tx.sql) of a read-only transaction",
    () => {
      type StoreOverTransaction = Awaited<
        ReturnType<typeof createAdapterStoreWithSchema<RotGraph, unknown>>
      >[0];
      const WRITES: readonly Readonly<{
        operation: string;
        write: (
          store: StoreOverTransaction,
          data: Awaited<ReturnType<typeof exportGraph>>,
        ) => Promise<unknown>;
      }>[] = [
        {
          operation: "store.nodes.RotTeam.create()",
          write: (store) => store.nodes.RotTeam.create({ name: "t3" }),
        },
        {
          operation: "store.edges.rotKnows.create()",
          write: (store) =>
            store.edges.rotKnows.create(person("p2"), person("p1"), {}),
        },
        {
          operation: "store.identity.assertSame()",
          write: (store) =>
            store.identity.assertSame(person("p1"), person("p2")),
        },
        {
          operation: "tx.nodes.RotTeam.create()",
          write: (store) =>
            store.transaction((tx) => tx.nodes.RotTeam.create({ name: "t3" })),
        },
        {
          operation: "importGraph()",
          write: (store, data) =>
            importGraph(store, data, {
              onConflict: "update",
              onUnknownProperty: "error",
              validateReferences: true,
              batchSize: 100,
              refreshStatistics: false,
            }),
        },
      ];

      for (const { operation, write } of WRITES) {
        it(`refuses ${operation} before any statement, and the transaction stays usable`, async () => {
          const graph = buildGraph(nextGraphId());
          const backend = context.getBackend();
          const [store] = await createAdapterStoreWithSchema(graph, backend);
          await seed(store);
          const data = await exportGraph(store);
          const before = await graphState(store);

          let refusal: unknown;
          const committed = await store.transaction(
            async (tx) => {
              const overTransaction = createAdapterStore(
                graph,
                createPostgresTransactionBackend(nativeHandle(tx) as never),
              ) as unknown as StoreOverTransaction;
              refusal = await rejectionOf(write(overTransaction, data));
              return tx.nodes.RotPerson.getById(asNodeId("p1"));
            },
            { accessMode: "read_only" },
          );
          expectReadOnlyRefusal(refusal, operation, graph.id);
          expect(committed?.id).toBe("p1");
          expect(await graphState(store)).toEqual(before);
        });
      }
    },
  );
}
