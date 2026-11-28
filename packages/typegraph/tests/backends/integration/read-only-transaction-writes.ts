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
import { sql as drizzleSql } from "drizzle-orm";
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
import { createSqliteBackend } from "../../../src/backend/sqlite";
import {
  type AdapterBackend,
  type TransactionBackend,
} from "../../../src/backend/types";
import { UnsupportedBackendCapabilityError } from "../../../src/errors-entry";
import { defineGraphExtension } from "../../../src/graph-extension";
import { branch } from "../../../src/graph-merge/branch";
import { MergeError } from "../../../src/graph-merge/errors";
import {
  applyMergePlan,
  applyMergePlanInTransaction,
  merge,
  planMerge,
} from "../../../src/graph-merge/merge";
import { asBranchId } from "../../../src/graph-merge/types";
import { rebuildIdentityClosure } from "../../../src/identity";
import {
  exportGraph,
  type GraphInterchangeChunk,
  importGraph,
  importGraphStream,
  trustedImportGraphStream,
} from "../../../src/interchange";
import type {
  EDGE_WRITE_NAMES,
  IDENTITY_WRITE_NAMES,
  NODE_WRITE_NAMES,
} from "../../../src/store/collection-surface";
import { requireDefined } from "../../../src/utils/presence";
import { unwrap } from "../../../src/utils/result";
import { expectObservation } from "../../helpers/known-defect";
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

export function buildGraph(id: string) {
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

export type RotGraph = ReturnType<typeof buildGraph>;

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

/**
 * The Store members that refuse a write by their own name, before they read
 * their arguments, on a Store over a transaction inside a read-only scope.
 * An early, clearer refusal only: the backend over that transaction refuses
 * every write member whatever reaches it (`read-only-backend-gate.ts`).
 */
const EARLY_REFUSED_STORE_MEMBERS = [
  "clear",
  "deprecateKinds",
  "evolve",
  "materializeIndexes",
  "materializeRemovals",
  "materializeSystemIndexes",
  "pruneRecordedInstants",
  "rebuildContribution",
  "rebuildIdentityClosure",
  "reembedVectorField",
  "refreshStatistics",
  "removeKinds",
  "repairContributions",
  "rotateAllocationOwner",
  "undeprecateKinds",
  "transaction",
  "transactionWithReceipt",
] as const;

/** A step that does nothing. */
function settled(): Promise<void> {
  return Promise.resolve();
}

/** The native handle a transaction context exposes as `tx.sql`. */
export function nativeHandle(tx: object): unknown {
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
export async function seed(
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

export async function graphState(
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

/** A chunk stream that fails the test if anything reads it. */
function unreadChunks(): AsyncIterable<GraphInterchangeChunk> {
  return {
    [Symbol.asyncIterator]: () => {
      throw new Error("the import read its stream before refusing");
    },
  };
}

/** What `pending` rejects with, or `undefined` when it resolves. */
export async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * What a write's rejection says: TypeGraph's read-only refusal; else a
 * SQLSTATE anywhere on the error's cause chain, else the first other code
 * there (a driver code), else the innermost cause's message.
 * `"fulfilled"` when the write resolved.
 */
export function writeOutcome(write: unknown): string {
  if (write === undefined) return "fulfilled";
  if (
    write instanceof UnsupportedBackendCapabilityError &&
    write.details["capability"] === "write transaction access"
  ) {
    return "refused as read-only";
  }
  const codes: string[] = [];
  let message = "a rejection that is not an Error";
  let current: unknown = write;
  while (typeof current === "object" && current !== null) {
    const code = (current as Readonly<{ code?: unknown }>).code;
    if (typeof code === "string") codes.push(code);
    if (current instanceof Error) message = current.message;
    current = (current as Readonly<{ cause?: unknown }>).cause;
  }
  const sqlState = codes.find((code) => /^[0-9A-Z]{5}$/.test(code));
  return `rejected: ${sqlState ?? codes[0] ?? message}`;
}

/**
 * What a write through a handle retained from an ended transaction does
 * inside a later read-only transaction, on the lanes that run every
 * transaction on one connection.
 */
const RETAINED_HANDLE_WRITE: Readonly<Record<string, string>> = {
  "better-sqlite3": "refused as read-only",
  libsql: "rejected: TRANSACTION_CLOSED",
  pglite: "rejected: Transaction is closed",
};

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

    for (const status of ["change", "noop"] as const) {
      it(`refuses store.withEvolvedTransaction(tx.sql) with a ${status} plan before its callback`, async () => {
        const graph = buildGraph(nextGraphId());
        const backend = context.getBackend();
        const [base] = await createAdapterStoreWithSchema(graph, backend);
        await seed(base);
        const extension = defineGraphExtension({
          nodes: { RotExtra: { properties: { label: { type: "string" } } } },
        });
        // A no-op plan is the plan of an extension the store already has.
        const store = status === "noop" ? await base.evolve(extension) : base;
        const activeBefore = await backend.getActiveSchema(graph.id);
        const version = activeBefore?.version;
        const before = await graphState(base);
        const plan = await store.planEvolution(extension);
        // A changing plan is refused as read-only before any capability
        // decision (SQLite cannot adopt a schema write at all), a no-op plan
        // before its schema lock.
        expect(plan.status).toBe(status);
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
        const active = await backend.getActiveSchema(graph.id);
        expect(active?.version).toBe(version);
        expect(await graphState(base)).toEqual(before);
      });
    }

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

    it("refuses a write through a second Store's adoption of the same handle", async () => {
      const graph = buildGraph(nextGraphId());
      const otherGraph = buildGraph(nextGraphId());
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const [otherStore] = await createAdapterStoreWithSchema(
        otherGraph,
        backend,
      );
      await seed(store);
      let refusal: unknown;
      const committed = await store.transaction(
        async (tx) => {
          // The first binding of the handle, then a second one through a
          // Store of another graph: both are sessions of the one native
          // transaction, so the second reads its read-only scope too.
          await store
            .withTransaction(nativeHandle(tx))
            .nodes.RotPerson.getById(asNodeId("p1"));
          refusal = await rejectionOf(
            otherStore
              .withTransaction(nativeHandle(tx))
              .nodes.RotTeam.create({ name: "t3" }, { id: "t3" }),
          );
          return tx.nodes.RotPerson.getById(asNodeId("p1"));
        },
        { accessMode: "read_only" },
      );
      expectReadOnlyRefusal(
        refusal,
        "tx.nodes.RotTeam.create()",
        otherGraph.id,
      );
      expect(committed?.id).toBe("p1");
      expect(await otherStore.nodes.RotTeam.getById(asNodeId("t3"))).toBe(
        undefined,
      );
    });

    it("never writes through a context bound in an earlier transaction and used inside a later read-only one on a one-connection backend", async () => {
      const graph = buildGraph(nextGraphId());
      const serialized =
        context.serverLaneConcurrency ?
          await context.createSerializedBackend()
        : undefined;
      try {
        const [store] = await createAdapterStoreWithSchema(
          graph,
          serialized?.backend ?? context.getBackend(),
        );
        await seed(store);
        let bound: ReturnType<typeof store.withTransaction> | undefined;
        await store.transaction(async (tx) => {
          bound = store.withTransaction(nativeHandle(tx));
          await bound.nodes.RotPerson.getById(asNodeId("p1"));
        });
        let write: unknown;
        const later = await rejectionOf(
          store.transaction(
            async () => {
              write = await rejectionOf(
                (async () =>
                  requireDefined(bound).nodes.RotTeam.create(
                    { name: "t3" },
                    { id: "t3" },
                  ))(),
              );
            },
            { accessMode: "read_only" },
          ),
        );
        const team = await store.nodes.RotTeam.getById(asNodeId("t3"));
        // The context's session holds the earlier transaction's state. On
        // better-sqlite3 its statements now run in the later transaction on
        // the same connection, which holds the later read-only scope, so the
        // write is refused. libSQL and PGlite report the earlier
        // transaction's handle closed.
        const outcome = writeOutcome(write);
        expect({
          written: outcome === "fulfilled" || team !== undefined,
          exact:
            context.serverLaneConcurrency ? undefined : (
              {
                write: outcome,
                later: later === undefined ? "fulfilled" : "rejected",
              }
            ),
        }).toEqual({
          written: false,
          exact:
            context.serverLaneConcurrency ? undefined : (
              {
                write: RETAINED_HANDLE_WRITE[context.driver],
                later: "fulfilled",
              }
            ),
        });
      } finally {
        await serialized?.close();
      }
    });

    it("never writes through a handle retained from an earlier transaction and adopted inside a later read-only one on a one-connection backend", async () => {
      const graph = buildGraph(nextGraphId());
      // Server PostgreSQL needs a one-client pool for the later transaction
      // to run on the retained handle's connection; the other lanes already
      // run every transaction on one connection.
      const serialized =
        context.serverLaneConcurrency ?
          await context.createSerializedBackend()
        : undefined;
      try {
        const [store] = await createAdapterStoreWithSchema(
          graph,
          serialized?.backend ?? context.getBackend(),
        );
        await seed(store);
        let retained: unknown;
        await store.transaction(async (tx) => {
          retained = nativeHandle(tx);
          await tx.nodes.RotPerson.getById(asNodeId("p1"));
        });
        let write: unknown;
        const later = await rejectionOf(
          store.transaction(
            async () => {
              write = await rejectionOf(
                (async () =>
                  store
                    .withTransaction(retained)
                    .nodes.RotTeam.create({ name: "t3" }, { id: "t3" }))(),
              );
            },
            { accessMode: "read_only" },
          ),
        );
        const team = await store.nodes.RotTeam.getById(asNodeId("t3"));
        // better-sqlite3's handle is the connection, which proves the later
        // transaction (proof 4), so the adoption is refused as read-only.
        // libSQL and PGlite pin the earlier transaction's driver handle, which
        // reports itself closed, so the driver refuses the statement. On
        // server PostgreSQL the retained object still resolves the ended
        // transaction (a residual `native-transaction-handle.ts` names), so
        // TypeGraph does not refuse; the later transaction is READ ONLY at the
        // engine, which refuses the statement instead.
        const outcome = writeOutcome(write);
        expect({
          written: outcome === "fulfilled" || team !== undefined,
          // The exact outcome on the lanes this test could observe it on.
          exact:
            context.serverLaneConcurrency ? undefined : (
              {
                write: outcome,
                later: later === undefined ? "fulfilled" : "rejected",
              }
            ),
        }).toEqual({
          written: false,
          exact:
            context.serverLaneConcurrency ? undefined : (
              {
                write: RETAINED_HANDLE_WRITE[context.driver],
                later: "fulfilled",
              }
            ),
        });
      } finally {
        await serialized?.close();
      }
    });

    it("refuses a write left floating through a context adopted over tx.sql until the read-only transaction has ended", async () => {
      const graph = buildGraph(nextGraphId());
      let beforeEnd: () => Promise<void> = settled;
      const base = context.getBackend();
      // `beforeEnd` runs once the Store's callback has settled and before the
      // backend ends the transaction: the window a write left floating by the
      // callback lands in.
      const backend = deriveBackend(base, {
        transaction: (fn, options) =>
          base.transaction(async (tx) => {
            const output = await fn(tx);
            await beforeEnd();
            return output;
          }, options),
        transactionWithNative: (fn, options) =>
          base.transactionWithNative(async (tx, native) => {
            const output = await fn(tx, native);
            await beforeEnd();
            return output;
          }, options),
      });
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      await seed(store);
      let late: unknown = "not issued";
      await store.transaction(
        async (tx) => {
          const adopted = store.withTransaction(nativeHandle(tx));
          beforeEnd = async () => {
            beforeEnd = settled;
            late = await rejectionOf(
              adopted.nodes.RotTeam.create({ name: "late" }, { id: "late" }),
            );
          };
          return tx.nodes.RotPerson.getById(asNodeId("p1"));
        },
        { accessMode: "read_only" },
      );
      expectReadOnlyRefusal(late, "tx.nodes.RotTeam.create()", graph.id);
      expect(await store.nodes.RotTeam.getById(asNodeId("late"))).toBe(
        undefined,
      );
    });

    // Compatibility guard: passes on main too; no claim of this change rests on it.
    it("ends the read-only scope of a transaction whose callback throws synchronously or rejects", async () => {
      const graph = buildGraph(nextGraphId());
      const [store] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
      );
      await seed(store);
      const throwing = (() => {
        throw new Error("the read-only callback throws");
      }) as unknown as () => Promise<void>;
      await expect(
        store.transaction(throwing, { accessMode: "read_only" }),
      ).rejects.toThrow("the read-only callback throws");
      await expect(
        store.transaction(
          () => Promise.reject(new Error("the read-only callback rejects")),
          { accessMode: "read_only" },
        ),
      ).rejects.toThrow("the read-only callback rejects");
      // A scope left open would hold the transaction's connection, and the
      // next transaction on it would read as read-only.
      await store.transaction(async (tx) => {
        await tx.nodes.RotTeam.create({ name: "t3" }, { id: "t3" });
        await store
          .withTransaction(nativeHandle(tx))
          .nodes.RotTeam.create({ name: "t4" }, { id: "t4" });
      });
      const teams = await store.nodes.RotTeam.find();
      expect(teams.map((node) => node.id).toSorted()).toEqual([
        "t1",
        "t2",
        "t3",
        "t4",
      ]);
    });

    // Compatibility guard: passes on main too; no claim of this change rests on it.
    it("leaves a later read-write transaction writable through the same adoption (a native transaction of its own)", async () => {
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

    it("refuses a write through a savepoint the caller opens on tx.sql and adopts directly, where the driver proves its transaction, and leaves it to the read-only engine transaction where none does", async () => {
      const graph = buildGraph(nextGraphId());
      const [store] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
      );
      await seed(store);
      let write: unknown;
      const transaction = await rejectionOf(
        store.transaction(
          async (tx) => {
            const handle = nativeHandle(tx) as Readonly<{
              transaction: (
                fn: (savepoint: unknown) => Promise<unknown>,
              ) => Promise<unknown>;
            }>;
            // The savepoint's own outcome is not the question: PostgreSQL
            // refuses an unrefused write itself, and Drizzle then rolls the
            // savepoint back. better-sqlite3 runs a nested transaction
            // synchronously, so there the write is started inside it and
            // awaited after it.
            let pending: Promise<unknown> | undefined;
            await rejectionOf(
              (async () =>
                handle.transaction((savepoint) => {
                  pending = store
                    .withTransaction(savepoint)
                    .nodes.RotTeam.create({ name: "t3" }, { id: "t3" });
                  return context.driver === "better-sqlite3" ?
                      (undefined as never)
                    : pending;
                }))(),
            );
            write = await rejectionOf(requireDefined(pending));
          },
          { accessMode: "read_only" },
        ),
      );
      const team = await store.nodes.RotTeam.getById(asNodeId("t3"));
      // A caller's savepoint resolves the read-only transaction where the
      // driver proves which transaction it is in: better-sqlite3 runs it on
      // the connection the opener published its transaction on, and libSQL
      // and PGlite keep the transaction's pinned driver handle in it
      // (`native-transaction-handle.ts`, proofs 2 and 4). node-postgres gives
      // it a new transaction object with no link to the enclosing one, so it
      // gets a state of its own, but it keeps the pooled client, which holds
      // the read-only scope while it runs. postgres-js gives it a new client
      // as well, so TypeGraph does not refuse; the engine transaction is READ
      // ONLY, so the engine refuses the write (SQLSTATE 25006) and Drizzle
      // rolls the savepoint back.
      const engineDecides = context.driver === "postgres-js";
      expect({
        write: writeOutcome(write),
        transaction: transaction === undefined ? "fulfilled" : "rejected",
        team: team === undefined ? undefined : String(team.id),
      }).toEqual({
        write: engineDecides ? "rejected: 25006" : "refused as read-only",
        transaction: "fulfilled",
        team: undefined,
      });
    });

    // Compatibility guard: passes on main too; no claim of this change rests on it.
    it("leaves a native read-only transaction the Store did not open to the engine", async () => {
      const graph = buildGraph(nextGraphId());
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      await seed(store);
      // Opened on the backend directly, not by `store.transaction`: no
      // read-only scope is open on it, so TypeGraph does not refuse; the
      // engine decides (PostgreSQL rejects the statement, SQLite has no
      // read-only transaction and writes).
      const write = await rejectionOf(
        backend.transactionWithNative(
          async (_transaction, nativeTransaction) => {
            await store
              .withTransaction(nativeTransaction)
              .nodes.RotTeam.create({ name: "t3" }, { id: "t3" });
          },
          { accessMode: "read_only" },
        ),
      );
      expect(
        write instanceof UnsupportedBackendCapabilityError &&
          write.details["capability"] === "write transaction access",
      ).toBe(false);
      expect(write === undefined).toBe(backend.dialect === "sqlite");
    });
  });

  /**
   * A backend over the caller's transaction handle `handle`:
   * `createPostgresTransactionBackend` on PostgreSQL, `createSqliteBackend` in
   * `transactionMode: "drizzle"` over libSQL's transaction object.
   */
  function backendOverTransaction(handle: unknown): AdapterBackend<unknown> {
    return context.driver === "libsql" ?
        (createSqliteBackend(handle as never, {
          executionProfile: { isSync: false, transactionMode: "drizzle" },
        }) as AdapterBackend<unknown>)
      : (createPostgresTransactionBackend(
          handle as never,
        ) as AdapterBackend<unknown>);
  }

  // better-sqlite3 hands `tx.sql` out as the database itself, not a
  // transaction object, so there is no backend over its transaction to build.
  describe.runIf(context.driver !== "better-sqlite3")(
    "writes through a Store over a backend built on a read-only transaction's tx.sql",
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
          // A read-write unit is refused as it opens, before its fences.
          operation: "store.transaction()",
          write: (store) =>
            store.transaction((tx) => tx.nodes.RotTeam.create({ name: "t3" })),
        },
        {
          operation: "store.transactionWithReceipt()",
          write: (store) =>
            store.transactionWithReceipt((tx) =>
              tx.nodes.RotTeam.create({ name: "t3" }),
            ),
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
        {
          operation: "importGraphStream()",
          write: (store) =>
            importGraphStream(store, unreadChunks(), { onConflict: "update" }),
        },
        {
          operation: "trustedImportGraphStream()",
          write: (store) => trustedImportGraphStream(store, unreadChunks()),
        },
        {
          operation: "store.clear()",
          write: (store) => store.clear(),
        },
        {
          operation: "store.evolve()",
          write: (store) =>
            store.evolve(
              defineGraphExtension({
                nodes: {
                  RotExtra: { properties: { label: { type: "string" } } },
                },
              }),
            ),
        },
        {
          operation: "store.deprecateKinds()",
          write: (store) => store.deprecateKinds(["RotTeam"]),
        },
        {
          operation: "store.undeprecateKinds()",
          write: (store) => store.undeprecateKinds(["RotTeam"]),
        },
        {
          operation: "store.removeKinds()",
          write: (store) => store.removeKinds(["RotTeam"]),
        },
        {
          operation: "store.materializeRemovals()",
          write: (store) => store.materializeRemovals(),
        },
        {
          operation: "store.materializeIndexes()",
          write: (store) => store.materializeIndexes(),
        },
        {
          operation: "store.rebuildIdentityClosure()",
          write: (store) => rebuildIdentityClosure(store),
        },
        {
          operation: "store.repairContributions()",
          write: (store) => store.repairContributions(),
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
                backendOverTransaction(nativeHandle(tx)),
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

      it("refuses a history Store's own read-write store.transaction() as it opens, before its isolation check, at repeatable read", async () => {
        const graph = buildGraph(nextGraphId());
        const [store] = await createAdapterStoreWithSchema(
          graph,
          context.getBackend(),
        );
        await seed(store);
        let refusal: unknown;
        const committed = await store.transaction(
          async (tx) => {
            const overTransaction = createAdapterStore(
              graph,
              backendOverTransaction(nativeHandle(tx)),
              { history: true },
            );
            refusal = await rejectionOf(
              overTransaction.transaction((inner) =>
                inner.nodes.RotTeam.create({ name: "t3" }),
              ),
            );
            return tx.nodes.RotPerson.getById(asNodeId("p1"));
          },
          { accessMode: "read_only", isolationLevel: "repeatable_read" },
        );
        expectReadOnlyRefusal(refusal, "store.transaction()", graph.id);
        expect(committed?.id).toBe("p1");
      });

      it("refuses a write through a savepoint the caller opens while a read-only savepoint of its transaction runs", async () => {
        const graph = buildGraph(nextGraphId());
        const [store] = await createAdapterStoreWithSchema(
          graph,
          context.getBackend(),
        );
        await seed(store);
        let write: unknown;
        await store.transaction(async (tx) => {
          const handle = nativeHandle(tx) as Readonly<{
            transaction: (
              fn: (savepoint: unknown) => Promise<unknown>,
            ) => Promise<unknown>;
          }>;
          const overTransaction = createAdapterStore(
            graph,
            backendOverTransaction(handle),
          );
          // The read-only store.transaction is a savepoint of the caller's
          // read-write transaction, so the engine accepts writes; the caller's
          // own savepoint, opened while it runs, must still be refused.
          await overTransaction.transaction(
            async () => {
              await rejectionOf(
                handle.transaction(async (savepoint) => {
                  write = await rejectionOf(
                    (async () =>
                      store
                        .withTransaction(savepoint)
                        .nodes.RotTeam.create({ name: "t3" }, { id: "t3" }))(),
                  );
                }),
              );
            },
            { accessMode: "read_only" },
          );
        });
        const team = await store.nodes.RotTeam.getById(asNodeId("t3"));
        // libSQL and PGlite keep the transaction's pinned driver handle in
        // the caller's savepoint, and node-postgres its pooled client, which
        // holds the read-only scope while it runs, so the Store refuses the
        // write. postgres-js gives the savepoint a client of its own that
        // nothing ties to the scope, and the caller's transaction is
        // read-write at the engine (TypeGraph leaves a caller's access mode
        // alone): the write commits with it, as on main.
        expectObservation({
          lane: { driver: context.driver },
          observed: {
            write: writeOutcome(write),
            team: team === undefined ? undefined : String(team.id),
          },
          correct: { write: "refused as read-only", team: undefined },
          defects: [
            {
              label: "rework-957-fix6-defect-caller-savepoint-postgres-js",
              on: { driver: ["postgres-js"] },
              today: { write: "fulfilled", team: "t3" },
            },
          ],
        });
      });

      /** Runs `text` through a Drizzle transaction handle as raw SQL. */
      function rawStatement(handle: unknown, text: string): Promise<unknown> {
        const raw = drizzleSql.raw(text);
        const runner = handle as Readonly<{
          execute?: (query: typeof raw) => Promise<unknown>;
          all?: (query: typeof raw) => Promise<unknown>;
        }>;
        const member = requireDefined(
          context.driver === "libsql" ? runner.all : runner.execute,
        );
        return Reflect.apply(member, runner, [raw]);
      }

      /** The rows a raw statement returned, on either dialect. */
      function rowsOf(
        result: unknown,
      ): readonly Readonly<Record<string, unknown>>[] {
        type Rows = readonly Readonly<Record<string, unknown>>[];
        return Array.isArray(result) ?
            (result as Rows)
          : (result as Readonly<{ rows: Rows }>).rows;
      }

      it("refuses to mint a revision origin in a read-only scope, and runs no DDL for one", async () => {
        const graph = buildGraph(nextGraphId());
        const backend = context.getBackend();
        const [tracking] = await createAdapterStoreWithSchema(graph, backend, {
          revisionTracking: true,
        });
        await seed(tracking);
        const opener = createAdapterStore(graph, backend);
        const where = `WHERE graph_id = '${graph.id}'`;
        // A graph with no revision origin yet: the next allocation-owner read
        // would mint one.
        await opener.transaction(async (tx) => {
          await rawStatement(
            nativeHandle(tx),
            `DELETE FROM typegraph_revision_origins ${where}`,
          );
        });
        let mint: unknown;
        let origins: unknown;
        const committed = await opener.transaction(
          async (tx) => {
            const overTransaction = createAdapterStore(
              graph,
              backendOverTransaction(nativeHandle(tx)),
              { revisionTracking: true },
            );
            mint = await rejectionOf(overTransaction.allocationOwner());
            origins = rowsOf(
              await rawStatement(
                nativeHandle(tx),
                `SELECT origin FROM typegraph_revision_origins ${where}`,
              ),
            ).length;
            return tx.nodes.RotPerson.getById(asNodeId("p1"));
          },
          { accessMode: "read_only" },
        );
        expectReadOnlyRefusal(mint, "store.allocationOwner()", graph.id);
        expect(origins).toBe(0);
        // On PostgreSQL the transaction is the engine's read-only one, so the
        // relation DDL would have aborted it before this read.
        expect(committed?.id).toBe("p1");
      });

      it("leaves a raw tx.sql write in a read-only unit on a caller's read-write transaction to the caller: TypeGraph sets no access mode there", async () => {
        const graph = buildGraph(nextGraphId());
        const [store] = await createAdapterStoreWithSchema(
          graph,
          context.getBackend(),
        );
        await seed(store);
        const table = `read_only_raw_${graph.id}`;
        let write: unknown;
        let rows: unknown;
        await store.transaction(async (tx) => {
          const handle = nativeHandle(tx);
          await rawStatement(handle, `CREATE TABLE ${table} (x INTEGER)`);
          const overTransaction = createAdapterStore(
            graph,
            backendOverTransaction(handle),
          );
          write = await rejectionOf(
            overTransaction.transaction(
              async (inner) => {
                await rawStatement(
                  nativeHandle(inner),
                  `INSERT INTO ${table} (x) VALUES (1)`,
                );
              },
              { accessMode: "read_only" },
            ),
          );
          // The caller's transaction is read-write again once the read-only
          // savepoint has ended, whichever way it ended.
          await rawStatement(handle, `INSERT INTO ${table} (x) VALUES (2)`);
          const read = await rawStatement(
            handle,
            `SELECT x FROM ${table} ORDER BY x`,
          );
          rows = rowsOf(read).map((row) => Number(row["x"]));
        });
        // SQL the caller wrote is the engine's to refuse, and the caller's
        // transaction is read-write at the engine on every dialect: the
        // read-only unit opens a savepoint of it and changes nothing else,
        // so the write runs, as on main.
        expect({ write: writeOutcome(write), rows }).toEqual({
          write: "fulfilled",
          rows: [1, 2],
        });
      });

      it("refuses every Store member that writes, on a Store over the transaction, by the member's own name before it reads its arguments", async () => {
        const graph = buildGraph(nextGraphId());
        const backend = context.getBackend();
        // A history Store provisions the recorded relations, so the history
        // members (pruning, owner rotation) reach their writes.
        const [historyStore] = await createAdapterStoreWithSchema(
          graph,
          backend,
          { history: true },
        );
        await seed(historyStore);
        const before = await graphState(historyStore);
        const owner = await historyStore.allocationOwner();
        const recorded = await historyStore.recordedNow();
        // A history Store does not hand out `tx.sql`; a plain Store over the
        // same graph opens the read-only transaction.
        const opener = createAdapterStore(graph, backend);

        const refusals: Record<string, unknown> = {};
        const committed = await opener.transaction(
          async (tx) => {
            for (const history of [false, true]) {
              const overTransaction = createAdapterStore(
                graph,
                backendOverTransaction(nativeHandle(tx)),
                { history },
              ) as unknown as Readonly<
                Record<string, (...args: never[]) => unknown>
              >;
              for (const name of EARLY_REFUSED_STORE_MEMBERS) {
                // No arguments: the refusal comes before anything reads them.
                refusals[`${history ? "history" : "plain"} ${name}`] =
                  await rejectionOf(
                    Promise.resolve().then((): unknown =>
                      Reflect.apply(
                        requireDefined(overTransaction[name]),
                        overTransaction,
                        [],
                      ),
                    ),
                  );
              }
            }
            return tx.nodes.RotPerson.getById(asNodeId("p1"));
          },
          { accessMode: "read_only" },
        );
        expect(Object.keys(refusals)).toHaveLength(
          2 * EARLY_REFUSED_STORE_MEMBERS.length,
        );
        for (const [label, refusal] of Object.entries(refusals)) {
          const member = requireDefined(label.split(" ")[1]);
          expectReadOnlyRefusal(refusal, `store.${member}()`, graph.id);
        }
        // On PostgreSQL the transaction is the engine's read-only one, so a
        // write statement would have aborted it before this read.
        expect(committed?.id).toBe("p1");
        expect(await graphState(historyStore as never)).toEqual(before);
        expect(await historyStore.allocationOwner()).toEqual(owner);
        expect(await historyStore.recordedNow()).toEqual(recorded);
      });

      it("refuses graph-merge writes on a Store over the transaction at the unit they open, and lets a branch read it", async () => {
        const graph = buildGraph(nextGraphId());
        const backend = context.getBackend();
        const [store] = await createAdapterStoreWithSchema(graph, backend, {
          revisionTracking: true,
        });
        await seed(store);
        const source = unwrap(
          await branch(store, () => context.createIsolatedBackend(), {
            id: asBranchId("read-only-surface-merge"),
          }),
        );
        await source.store.nodes.RotPerson.create(
          { name: "p5", email: "p5@example.test" },
          { id: "p5" },
        );
        const artifact = unwrap(await planMerge(store, [source]));
        const before = await graphState(store);
        // A revision-tracking Store does not hand out `tx.sql`; a plain Store
        // over the same graph opens the read-only transaction.
        const opener = createAdapterStore(graph, backend);

        const outcomes: Record<string, unknown> = {};
        let branched: unknown;
        await opener.transaction(
          async (tx) => {
            const overTransaction = createAdapterStore(
              graph,
              backendOverTransaction(nativeHandle(tx)),
              { revisionTracking: true },
            );
            // A branch only reads the Store it forks.
            const forked = await branch(
              overTransaction,
              () => context.createIsolatedBackend(),
              { id: asBranchId("read-only-surface-branch") },
            );
            branched = forked.success ? "branched" : forked.error;
            outcomes["merge()"] = await rejectionOf(
              (async () => unwrap(await merge(overTransaction, [source])))(),
            );
            outcomes["applyMergePlan()"] = await rejectionOf(
              (async () =>
                unwrap(await applyMergePlan(overTransaction, artifact)))(),
            );
            return;
          },
          { accessMode: "read_only" },
        );
        expect(branched).toBe("branched");
        expect(Object.keys(outcomes)).toEqual(["merge()", "applyMergePlan()"]);
        for (const outcome of Object.values(outcomes)) {
          // Merge reports every failure as a MergeError; the refusal of the
          // unit it opens is its cause.
          expect(outcome).toBeInstanceOf(MergeError);
          const cause = (outcome as MergeError).cause;
          expect(cause).toBeInstanceOf(UnsupportedBackendCapabilityError);
          expect(
            (cause as UnsupportedBackendCapabilityError).details,
          ).toMatchObject({
            capability: "write transaction access",
            accessMode: "read_only",
            graphId: graph.id,
          });
        }
        expect(await graphState(store)).toEqual(before);
      });

      it("reads a read-only savepoint as a scope: the caller's read-write transaction refuses only while it runs", async () => {
        const graph = buildGraph(nextGraphId());
        const [store] = await createAdapterStoreWithSchema(
          graph,
          context.getBackend(),
        );
        await seed(store);
        let inside: unknown;
        await store.transaction(async (tx) => {
          const overTransaction = createAdapterStore(
            graph,
            backendOverTransaction(nativeHandle(tx)),
          );
          // A read-only store.transaction on this Store is a savepoint of the
          // caller's transaction: the caller's own context is refused while
          // it runs, not after.
          await overTransaction.transaction(
            async () => {
              inside = await rejectionOf(
                tx.nodes.RotTeam.create({ name: "t3" }, { id: "t3" }),
              );
            },
            { accessMode: "read_only" },
          );
          // A read-only savepoint whose callback throws ends its scope too.
          await rejectionOf(
            overTransaction.transaction(
              async () => {
                await Promise.resolve();
                throw new Error("the read-only callback fails");
              },
              { accessMode: "read_only" },
            ),
          );
          await tx.nodes.RotTeam.create({ name: "t4" }, { id: "t4" });
          await overTransaction.nodes.RotTeam.create(
            { name: "t5" },
            { id: "t5" },
          );
        });
        expectReadOnlyRefusal(inside, "tx.nodes.RotTeam.create()", graph.id);
        const teams = await store.nodes.RotTeam.find();
        expect(teams.map((team) => team.id).toSorted()).toEqual([
          "t1",
          "t2",
          "t4",
          "t5",
        ]);
      });
    },
  );
}
