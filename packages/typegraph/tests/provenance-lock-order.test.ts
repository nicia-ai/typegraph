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
 *  - `holding()` and `holding(tx)` take the graph lock and never the schema
 *    fence (they stay usable in a read-only transaction);
 *  - a transaction that already holds the locks reuses the graph lock;
 *  - a transaction containing only `assertHolds` allocates no recorded
 *    revision.
 *
 * Named mutation, verified to bite: replace the body of
 * `acquireCapabilityWriteLocks` (`src/provenance/locks.ts`) with
 * `await lockRecordedGraphWrite(transactionBackend(tx), graphId)`, the
 * graph-then-schema spelling. `retract` then shows the advisory lock before
 * any `FOR SHARE`, and a write-free `assertHolds` shows no fence at all, so the
 * order and presence assertions below fail.
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

const graph = defineGraph({
  id: "provenance_lock_order",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: { type: premiseOf, from: [Source, Fact], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Fact] },
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
 * emission order, and inside one statement by position in its text.
 */
function lockEvents(): readonly LockEvent[] {
  return statements.flatMap((statement): readonly LockEvent[] => {
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

function countGraphLockStatements(): number {
  return statements.filter((statement) => isGraphLock(statement)).length;
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

const SEEDS = ["A", "B", "C", "D", "E", "F", "G"] as const;

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
  const registeredBackend = createPostgresBackend(
    drizzle(client, {
      logger: {
        logQuery(queryText: string, params: unknown[]): void {
          statements.push({ query: queryText, params });
        },
      },
    }),
    { vector: false },
  );
  const fusedBackend: GraphBackend = deriveBackend(registeredBackend, {});
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

const STORES = [
  ["fused PostgreSQL statement", () => fusedStore, "E"],
  ["portable two-statement fence", () => portableStore, "G"],
] as const;

describe.each(STORES)(
  "lock order on the %s",
  (_label, getStore, retractableSuffix) => {
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
      expect(indexOfFirstRowWrite()).toBeGreaterThan(indexOfFirstGraphLock());
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

describe("holding takes the graph lock and no schema fence", () => {
  it("holding() reads under the graph lock alone", async () => {
    const provenance = createRetractionCapability(fusedStore, config);

    await provenance.holding();

    expect(lockEvents()).toEqual(["graph lock"]);
    expect(countGraphLockStatements()).toBe(1);
  });

  it("holding(tx) reads under the graph lock alone, even in a read-only transaction", async () => {
    const provenance = createRetractionCapability(fusedStore, config);

    const holding = await fusedStore.transaction(
      (tx) => provenance.holding(tx),
      { accessMode: "read_only" },
    );

    expect(holding.length).toBeGreaterThan(0);
    expect(lockEvents()).toEqual(["graph lock"]);
  });
});
