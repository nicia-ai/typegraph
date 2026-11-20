/**
 * The retraction capability's lock order, asserted from the emitted SQL.
 *
 * Two callers that take the schema-version fence and the per-graph write lock
 * in opposite orders return the same rows, so the order cannot be seen from
 * the public API. SQLite serializes writes in the engine and issues neither
 * lock as a statement, so this suite records the statements a PGlite-backed
 * PostgreSQL backend receives.
 *
 * Contract under test:
 *  - `assertHolds` and `retract` take the schema fence BEFORE the graph write
 *    lock, whether `assertHolds` runs before any write or after one;
 *  - `retract` and `unRetract`, in their own or a caller's transaction, read
 *    and write no graph row before the graph lock;
 *  - `holding(tx)` in a read-write transaction takes the schema fence BEFORE
 *    the graph lock, so a write or `assertHolds` after it inverts nothing;
 *  - `holding()` and `holding(tx)` in a read-only transaction take the graph
 *    lock and never the schema fence (neither can write);
 *  - `assertHolds` with an empty list takes no lock;
 *  - a transaction that already holds the locks reuses the graph lock, an
 *    evolved transaction included;
 *  - a transaction containing only `assertHolds` allocates no recorded
 *    revision.
 *
 * Named mutations, verified to bite: replace the body of
 * `acquireCapabilityWriteLocks` (`src/provenance/locks.ts`) with
 * `await lockRecordedGraphWrite(transactionBackend(tx), graphId)`, the
 * graph-then-schema spelling. `retract` then shows the advisory lock before
 * any `FOR SHARE`, and a write-free `assertHolds` shows no fence at all, so the
 * order and presence assertions below fail. Making the store's
 * `acquireReadFences` take the graph lock alone in a read-write transaction
 * fails the read-write `holding(tx)` assertions the same way. Moving
 * `acquireCapabilityWriteLocks` in `transitionInTransaction`
 * (`src/provenance/transition.ts`) below `loadSupportGraph` keeps both forms'
 * statements equal and the lock before the first write, but puts the source
 * and support reads before the graph lock, so the read-order assertions fail.
 *
 * The fused PostgreSQL statement carries both locks in one query; its SQL
 * takes the schema row first, so position inside a statement is part of the
 * order.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import {
  type GraphBackend,
  type TransactionBackend,
} from "../src/backend/types";
import { defineGraphExtension } from "../src/graph-extension";
import { createRetractionCapability } from "../src/provenance";
import type { HistoryStore } from "../src/store-entry";

const GRAPH_WRITE_NAMESPACE = "typegraph:recorded-graph-write";

type LoggedStatement = Readonly<{ query: string; params: readonly unknown[] }>;
type LockEvent = "schema fence" | "graph lock";

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const Fact = defineNode("Fact", { schema: z.object({ label: z.string() }) });
const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});
const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const kinds = {
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: { type: premiseOf, from: [Source, Fact], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Fact] },
  },
} as const;

const graph = defineGraph({ id: "provenance_lock_order", ...kinds });

// Evolved in its own test, on its own graph id, so the stores above keep
// their schema version.
const evolvingGraph = defineGraph({
  id: "provenance_lock_order_evolving",
  ...kinds,
});

const noteExtension = defineGraphExtension({
  nodes: {
    LockOrderNote: {
      properties: { label: { type: "string", optional: true } },
    },
  },
});

const config = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

type LockStore = HistoryStore<typeof graph>;

const statements: LoggedStatement[] = [];

let fusedStore: LockStore;
let portableStore: LockStore;
let adapterBackend: ReturnType<typeof createPostgresBackend>;
let closeClient: () => Promise<void>;

function isGraphLock(statement: LoggedStatement): boolean {
  return (
    statement.query.includes("pg_advisory_xact_lock") &&
    (statement.params.includes(GRAPH_WRITE_NAMESPACE) ||
      statement.query.includes(`'${GRAPH_WRITE_NAMESPACE}'`))
  );
}

/**
 * The lock acquisitions in the order the server takes them: statements in
 * emission order from `fromStatement`, and inside one statement by position in
 * its text.
 */
function lockEvents(fromStatement = 0): readonly LockEvent[] {
  return statements
    .slice(fromStatement)
    .flatMap((statement): readonly LockEvent[] => {
      const schemaAt = statement.query.search(/for share/iu);
      const graphAt =
        isGraphLock(statement) ?
          statement.query.indexOf("pg_advisory_xact_lock")
        : -1;
      return [
        ...(schemaAt >= 0 ? [["schema fence", schemaAt] as const] : []),
        ...(graphAt >= 0 ? [["graph lock", graphAt] as const] : []),
      ]
        .toSorted(([, left], [, right]) => left - right)
        .map(([event]) => event);
    });
}

function countGraphLockStatements(fromStatement = 0): number {
  return statements
    .slice(fromStatement)
    .filter((statement) => isGraphLock(statement)).length;
}

function indexOfFirstRowWrite(): number {
  return statements.findIndex(
    (statement) =>
      !statement.query.includes("pg_advisory_xact_lock") &&
      /^\s*(insert|update|delete)\b/iu.test(statement.query),
  );
}

function indexOfFirstGraphLock(): number {
  return statements.findIndex((statement) => isGraphLock(statement));
}

/**
 * The first statement that reads a graph row: a source row, or the support
 * graph's nodes and edges. A transition computes its support from these
 * reads, so they must follow the graph lock, or PostgreSQL could compute it
 * from rows a concurrent transition is about to change.
 */
function indexOfFirstGraphRowRead(): number {
  return statements.findIndex(
    (statement) =>
      !statement.query.includes("pg_advisory_xact_lock") &&
      /^\s*select\b/iu.test(statement.query) &&
      /\bfrom\s+"typegraph_(?:nodes|edges)"/iu.test(statement.query),
  );
}

/** Asserts the graph lock comes before the first graph row read and write. */
function expectGraphLockBeforeRowWork(): void {
  const graphLock = indexOfFirstGraphLock();
  expect(graphLock).toBeGreaterThanOrEqual(0);
  expect(indexOfFirstGraphRowRead()).toBeGreaterThan(graphLock);
  expect(indexOfFirstRowWrite()).toBeGreaterThan(graphLock);
}

async function seedChain(store: LockStore, suffix: string): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.nodes.Source.create({ label: `s${suffix}` }, { id: `s${suffix}` });
    await tx.nodes.Justification.create(
      { label: `j${suffix}` },
      { id: `j${suffix}` },
    );
    await tx.nodes.Fact.create({ label: `f${suffix}` }, { id: `f${suffix}` });
    await tx.edges.premiseOf.create(
      { kind: "Source", id: `s${suffix}` },
      { kind: "Justification", id: `j${suffix}` },
      {},
    );
    await tx.edges.derives.create(
      { kind: "Justification", id: `j${suffix}` },
      { kind: "Fact", id: `f${suffix}` },
      {},
    );
  });
}

const SEEDS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"] as const;

beforeAll(async () => {
  const client = await PGlite.create();
  const query = client.query.bind(client);
  const querySpy = vi.spyOn(client, "query").mockImplementation((...args) => {
    statements.push({ query: args[0], params: args[1] ?? [] });
    return query(...args);
  });
  closeClient = async () => {
    querySpy.mockRestore();
    await client.close();
  };
  await client.exec(generatePostgresDDL().join("\n\n"));
  adapterBackend = createPostgresBackend(
    drizzle(client, {
      logger: {
        logQuery(queryText: string, params: unknown[]): void {
          statements.push({ query: queryText, params });
        },
      },
    }),
    { vector: false },
  );
  const fusedBackend: GraphBackend = deriveBackend(adapterBackend, {});
  const portableBackend: GraphBackend = deriveBackend(fusedBackend, {
    transaction<T>(
      fn: (target: TransactionBackend) => Promise<T>,
      options?: Parameters<GraphBackend["transaction"]>[1],
    ): Promise<T> {
      return fusedBackend.transaction(
        (target) =>
          fn(projectBackendWithout(target, ["lockSchemaVersionAndGraphWrite"])),
        options,
      );
    },
  });
  [fusedStore] = await createStoreWithSchema(graph, fusedBackend, {
    history: true,
  });
  [portableStore] = await createStoreWithSchema(graph, portableBackend, {
    history: true,
  });
  for (const suffix of SEEDS) await seedChain(fusedStore, suffix);
});

afterAll(async () => {
  await closeClient();
});

beforeEach(() => {
  statements.splice(0);
});

function fact(suffix: string) {
  return { kind: "Fact", id: `f${suffix}` } as const;
}

// Per store: a chain `retract` closes, one a caller's transaction retracts
// and restores, and one a caller's transaction retracts after its own write.
const STORES = [
  ["fused PostgreSQL statement", () => fusedStore, "E", "H", "I"],
  ["portable two-statement fence", () => portableStore, "G", "J", "K"],
] as const;

function queryTexts(): readonly string[] {
  return statements.map((statement) => statement.query);
}

describe.each(STORES)(
  "lock order on the %s",
  (
    _label,
    getStore,
    retractableSuffix,
    callerRoundTripSuffix,
    callerAfterWriteSuffix,
  ) => {
    it("assertHolds before any write takes the schema fence, then the graph lock, before any row work", async () => {
      const store = getStore();
      const provenance = createRetractionCapability(store, config);

      await store.transaction(async (tx) => {
        await provenance.assertHolds(tx, [fact("A")]);
      });

      expect(lockEvents().slice(0, 2)).toEqual(["schema fence", "graph lock"]);
      expect(countGraphLockStatements()).toBe(1);
      expect(indexOfFirstRowWrite()).toBe(-1);
    });

    it("assertHolds after a write has already taken the locks does not invert them", async () => {
      const store = getStore();
      const provenance = createRetractionCapability(store, config);

      await store.transaction(async (tx) => {
        await tx.nodes.Fact.create({ label: "late" }, { id: `late-${_label}` });
        await provenance.assertHolds(tx, [fact("B")]);
      });

      const events = lockEvents();
      expect(events[0]).toBe("schema fence");
      expect(events.indexOf("graph lock")).toBeGreaterThan(0);
      expect(events.filter((event) => event === "graph lock")).toHaveLength(1);
    });

    it("assertHolds, a write, then assertHolds again takes the graph lock once and never before the schema fence", async () => {
      const store = getStore();
      const provenance = createRetractionCapability(store, config);

      const held = await store.transaction(async (tx) => {
        const before = await provenance.assertHolds(tx, [fact("C")]);
        await tx.nodes.Fact.create({ label: "mid" }, { id: `mid-${_label}` });
        const after = await provenance.assertHolds(tx, [fact("C")]);
        return [before, after] as const;
      });

      expect(held[0]).toHaveLength(1);
      expect(held[1]).toHaveLength(1);
      expect(countGraphLockStatements()).toBe(1);
      const events = lockEvents();
      expect(events[0]).toBe("schema fence");
      expect(events[1]).toBe("graph lock");
    });

    it("repeated assertHolds calls in one transaction reuse the held graph lock and complete", async () => {
      const store = getStore();
      const provenance = createRetractionCapability(store, config);

      await store.transaction(async (tx) => {
        await provenance.assertHolds(tx, [fact("D")]);
        await provenance.assertHolds(tx, [fact("D")]);
        await provenance.assertHolds(tx, [fact("D")]);
      });

      expect(countGraphLockStatements()).toBe(1);
      expect(lockEvents().slice(0, 2)).toEqual(["schema fence", "graph lock"]);
    });

    it("retract takes the schema fence, then the graph lock, before its first row write", async () => {
      const store = getStore();
      const provenance = createRetractionCapability(store, config);

      await provenance.retract({ kind: "Source", id: `s${retractableSuffix}` });

      expect(lockEvents().slice(0, 2)).toEqual(["schema fence", "graph lock"]);
      expect(countGraphLockStatements()).toBe(1);
      expectGraphLockBeforeRowWork();
    });

    // Load-bearing for "no transaction behaves exactly as before": both
    // forms run one implementation, so the caller's form inside a fresh
    // transaction issues the same statements, locks first.
    it("retract and unRetract on a caller's transaction issue exactly the statements of their own transaction, schema fence then graph lock first", async () => {
      const store = getStore();
      const provenance = createRetractionCapability(store, config);
      const source = {
        kind: "Source",
        id: `s${callerRoundTripSuffix}`,
      } as const;

      const ownRetract = await provenance.retract(source);
      const ownRetractQueries = queryTexts();
      statements.splice(0);
      const ownRestore = await provenance.unRetract(source);
      const ownRestoreQueries = queryTexts();
      statements.splice(0);

      const callerRetract = await store.transaction((tx) =>
        provenance.retract(source, tx),
      );
      expect(lockEvents().slice(0, 2)).toEqual(["schema fence", "graph lock"]);
      expect(countGraphLockStatements()).toBe(1);
      expectGraphLockBeforeRowWork();
      const callerRetractQueries = queryTexts();
      statements.splice(0);
      const callerRestore = await store.transaction((tx) =>
        provenance.unRetract(source, tx),
      );
      expect(lockEvents().slice(0, 2)).toEqual(["schema fence", "graph lock"]);
      expectGraphLockBeforeRowWork();
      const callerRestoreQueries = queryTexts();

      expect(ownRetract.died).toEqual([fact(callerRoundTripSuffix)]);
      expect(callerRetract).toEqual(ownRetract);
      expect(callerRestore).toEqual(ownRestore);
      expect(callerRetractQueries).toEqual(ownRetractQueries);
      expect(callerRestoreQueries).toEqual(ownRestoreQueries);
    });

    it("retract on a caller's transaction after the caller's own write inverts no lock", async () => {
      const store = getStore();
      const provenance = createRetractionCapability(store, config);

      await store.transaction(async (tx) => {
        await tx.nodes.Fact.create(
          { label: "before retract" },
          { id: `before-retract-${_label}` },
        );
        await provenance.retract(
          { kind: "Source", id: `s${callerAfterWriteSuffix}` },
          tx,
        );
      });

      const events = lockEvents();
      expect(events[0]).toBe("schema fence");
      expect(events.indexOf("graph lock")).toBeGreaterThan(0);
      expect(countGraphLockStatements()).toBe(1);
    });

    it("holding(tx) in a read-write transaction takes the schema fence, then the graph lock, and a later write and assertHolds add no inverted acquisition", async () => {
      const store = getStore();
      const provenance = createRetractionCapability(store, config);

      await store.transaction(async (tx) => {
        await provenance.holding(tx);
        expect(lockEvents()).toEqual(["schema fence", "graph lock"]);
        await tx.nodes.Fact.create(
          { label: "after holding" },
          { id: `after-holding-${_label}` },
        );
        await provenance.assertHolds(tx, [fact("A")]);
      });

      expect(lockEvents().slice(0, 2)).toEqual(["schema fence", "graph lock"]);
      expect(countGraphLockStatements()).toBe(1);
      expect(indexOfFirstRowWrite()).toBeGreaterThan(indexOfFirstGraphLock());
    });

    it("assertHolds with an empty list in an owned transaction returns [] and issues no lock statement", async () => {
      const store = getStore();
      const provenance = createRetractionCapability(store, config);

      const held = await store.transaction((tx) =>
        provenance.assertHolds(tx, []),
      );

      expect(held).toEqual([]);
      expect(lockEvents()).toEqual([]);
      expect(countGraphLockStatements()).toBe(0);
    });

    it("a transaction containing only assertHolds allocates no recorded revision", async () => {
      const store = getStore();
      const provenance = createRetractionCapability(store, config);

      const outcome = await store.transactionWithReceipt(async (tx) => {
        await provenance.assertHolds(tx, [fact("F")]);
        await provenance.assertHolds(tx, [fact("F")]);
      });

      expect(outcome.receipt.recorded).toBeUndefined();
      expect(outcome.receipt.writes.total).toBe(0);
    });
  },
);

describe("holding takes the graph lock alone where it can never write", () => {
  it("holding() reads under the graph lock alone", async () => {
    const provenance = createRetractionCapability(fusedStore, config);

    await provenance.holding();

    expect(lockEvents()).toEqual(["graph lock"]);
    expect(countGraphLockStatements()).toBe(1);
  });

  it("holding(tx) in a read-only transaction reads under the graph lock alone", async () => {
    const provenance = createRetractionCapability(fusedStore, config);

    const holding = await fusedStore.transaction(
      (tx) => provenance.holding(tx),
      { accessMode: "read_only" },
    );

    expect(holding.length).toBeGreaterThan(0);
    expect(lockEvents()).toEqual(["graph lock"]);
  });
});

describe("lock order in an evolved transaction", () => {
  it("holding(tx) and assertHolds reuse the schema fence and graph lock the evolved frame took in order, and judge against the evolved graph", async () => {
    const [store] = await createAdapterStoreWithSchema(
      evolvingGraph,
      adapterBackend,
      { history: true },
    );
    await store.transaction(async (tx) => {
      await tx.nodes.Source.create({ label: "evolving" }, { id: "evolving-s" });
      await tx.nodes.Justification.create(
        { label: "evolving" },
        { id: "evolving-j" },
      );
      await tx.nodes.Fact.create({ label: "evolving" }, { id: "evolving-f" });
      await tx.edges.premiseOf.create(
        { kind: "Source", id: "evolving-s" },
        { kind: "Justification", id: "evolving-j" },
        {},
      );
      await tx.edges.derives.create(
        { kind: "Justification", id: "evolving-j" },
        { kind: "Fact", id: "evolving-f" },
        {},
      );
    });
    const provenance = createRetractionCapability(store, config);
    const plan = await store.planEvolution(noteExtension);
    if (plan.status !== "change") throw new Error("Expected a change plan.");
    const evolvingFact = { kind: "Fact", id: "evolving-f" } as const;

    let callbackStart = -1;
    statements.splice(0);
    const outcome = await adapterBackend.transactionWithNative(
      async (_target, nativeTx) =>
        store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
          callbackStart = statements.length;
          const believed = await provenance.holding(tx);
          await tx.nodes.Fact.create(
            { label: "evolved" },
            { id: "evolved-unjustified" },
          );
          const held = await provenance.assertHolds(tx, [evolvingFact]);
          return { believed, held };
        }),
    );

    expect(outcome.result.believed).toEqual([evolvingFact]);
    expect(outcome.result.held).toEqual([
      {
        fact: evolvingFact,
        via: [{ kind: "Justification", id: "evolving-j" }],
      },
    ]);
    // The adopted capture frame takes the evolved store's fences before the
    // callback runs; the reads and the write inside reuse them.
    expect(lockEvents()).toEqual(["schema fence", "graph lock"]);
    expect(indexOfFirstGraphLock()).toBeLessThan(callbackStart);
    expect(lockEvents(callbackStart)).toEqual([]);
  });
});
