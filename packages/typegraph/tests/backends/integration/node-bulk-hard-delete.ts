/**
 * Node `bulkHardDelete(ids)`, on every backend.
 *
 * The contract is equivalence: a batch leaves exactly the state that calling
 * `hardDelete(id)` once per id, in first-occurrence order, inside one
 * transaction leaves, and fails with the same first refusal, with nothing
 * deleted. Each case builds one fixture twice, runs the batch on one and the
 * per-id loop on the other, and compares every table the delete can touch:
 * nodes, edges, uniqueness rows, edge claims, fulltext rows, identity
 * assertions, closure and separation, recorded history, identity
 * transitions, the per-relation row counts (which cover each embedding
 * table), the revision clock and the transaction receipt.
 *
 * Each case names, in a comment, the mutation that must make it fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  type GraphBackend,
  partOf,
  RestrictedDeleteError,
  searchable,
} from "../../../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import {
  type HardDeleteNodeParams,
  type TransactionBackend,
} from "../../../src/backend/types";
import {
  RECORDED_MAX_REVISION,
  recordedInstantRevision,
} from "../../../src/core/temporal";
import { inspectGraphStorage } from "../../../src/maintenance";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { type IntegrationTestContext } from "./test-context";

const ITEM_EMAIL_UNIQUE = {
  name: "nbhd_item_email",
  fields: ["email"],
  scope: "kind",
  collation: "binary",
} as const;

/** Removed set-wise unless an identity assertion or class names it. */
const NbhdItem = defineNode("NbhdItem", {
  schema: z.object({
    email: z.string(),
    title: searchable({ language: "english" }),
    vector: embedding(3).optional(),
  }),
});
/** `onDelete: "restrict"` (the default): any non-composition edge refuses. */
const NbhdLocked = defineNode("NbhdLocked", {
  schema: z.object({ name: z.string() }),
});
/** A composition whole of pages, and of other folders. */
const NbhdFolder = defineNode("NbhdFolder", {
  schema: z.object({ name: z.string() }),
});
const NbhdPage = defineNode("NbhdPage", {
  schema: z.object({ name: z.string() }),
});

/** `cardinality: "one"`: every edge holds a claim row to release. */
const nbhdLinks = defineEdge("nbhdLinks", { schema: z.object({}) });
/** Unconstrained, across kinds. */
const nbhdReferences = defineEdge("nbhdRefs", { schema: z.object({}) });
const nbhdPageOf = defineEdge("nbhdPageOf", { schema: z.object({}) });
const nbhdSubfolderOf = defineEdge("nbhdSubfolderOf", {
  schema: z.object({}),
});

const REFERABLE = [NbhdItem, NbhdLocked, NbhdFolder] as const;

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      NbhdItem: {
        type: NbhdItem,
        unique: [ITEM_EMAIL_UNIQUE],
        onDelete: "cascade",
      },
      NbhdLocked: { type: NbhdLocked },
      NbhdFolder: { type: NbhdFolder, onDelete: "cascade" },
      NbhdPage: { type: NbhdPage, onDelete: "cascade" },
    },
    edges: {
      nbhdLinks: {
        type: nbhdLinks,
        from: [NbhdItem],
        to: [NbhdItem],
        cardinality: "one",
      },
      nbhdRefs: { type: nbhdReferences, from: REFERABLE, to: REFERABLE },
      nbhdPageOf: {
        type: nbhdPageOf,
        from: [NbhdPage],
        to: [NbhdFolder],
        cardinality: "one",
      },
      nbhdSubfolderOf: {
        type: nbhdSubfolderOf,
        from: [NbhdFolder],
        to: [NbhdFolder],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(NbhdPage, NbhdFolder, { via: nbhdPageOf }),
      partOf(NbhdFolder, NbhdFolder, {
        via: nbhdSubfolderOf,
        partSide: "from",
      }),
    ],
    identity: { sameIdAcrossKinds: "ignore" },
  });
}

type NbhdGraph = ReturnType<typeof buildGraph>;
type NbhdStoreHandle = ReturnType<typeof createStore<NbhdGraph>>;
type NodeKindName = Extract<keyof NbhdGraph["nodes"], string>;

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `node_bulk_hard_delete_${graphIdCounter}`;
}

/** The store surface these cases write through and inspect. */
type NbhdStore = NbhdStoreHandle &
  Readonly<{
    backend: GraphBackend;
    revisionNow: () => Promise<string | undefined>;
  }>;

type StoreMode = "live" | "history";

/** A node reference, cast for the typed edge and identity APIs. */
function ref(kind: NodeKindName, id: string): never {
  return { kind, id } as never;
}

/** The recorded rows of one entity id, from a `recordedNodes`/`recordedEdges` dump. */
function recordedFor(rows: readonly string[], id: string): readonly string[] {
  return rows.filter((row) => row.split("|")[1] === id);
}

/** A sanitized table identifier. */
function table(name: string) {
  return sql.identifier(name);
}

/** Narrows the typed collection a case addresses by kind name. */
function nodeCollection(
  nodes: NbhdStoreHandle["nodes"],
  kind: NodeKindName,
): Readonly<{
  hardDelete: (id: string) => Promise<void>;
  bulkHardDelete: (ids: readonly string[]) => Promise<void>;
}> {
  return nodes[kind] as never;
}

/**
 * Seeds the same rows, under the same ids, into any graph built by
 * {@link buildGraph}. Sequential, so two graphs seeded alike advance their
 * revision clocks alike.
 */
async function seed(store: NbhdStore): Promise<void> {
  const vectors = store.backend.capabilities.vector?.supported === true;
  const items = store.nodes.NbhdItem;
  for (const [index, id] of [
    "i1",
    "i2",
    "i3",
    "i4",
    "i5",
    "i6",
    "i7",
    "i8",
    "dup",
  ].entries()) {
    await items.create(
      {
        email: `${id}@example.com`,
        title: `title of ${id}`,
        ...(vectors ? { vector: [index + 1, 1, 0] } : {}),
      },
      { id },
    );
  }
  // A tombstoned node: hard delete purges it.
  await items.delete("i7" as never);
  for (const id of ["l1", "l2", "l3", "l4", "l5", "dup"]) {
    await store.nodes.NbhdLocked.create({ name: id }, { id });
  }
  for (const id of ["f1", "f2", "f3", "f4", "f5"]) {
    await store.nodes.NbhdFolder.create({ name: id }, { id });
  }
  // Composition edges under stated ids (a `partOf` create option would
  // generate them), so two graphs seeded alike hold the same edge ids.
  await store.edges.nbhdSubfolderOf.create(
    ref("NbhdFolder", "f3"),
    ref("NbhdFolder", "f1"),
    {},
    { id: "s1" },
  );
  for (const [id, whole] of [
    ["p1", "f1"],
    ["p2", "f1"],
    ["p3", "f3"],
  ] as const) {
    await store.nodes.NbhdPage.create({ name: id }, { id });
    await store.edges.nbhdPageOf.create(
      ref("NbhdPage", id),
      ref("NbhdFolder", whole),
      {},
      { id: `of-${id}` },
    );
  }

  const { nbhdLinks: links, nbhdRefs: references } = store.edges;
  await links.create(
    ref("NbhdItem", "i1"),
    ref("NbhdItem", "i2"),
    {},
    {
      id: "k1",
    },
  );
  await links.create(
    ref("NbhdItem", "i2"),
    ref("NbhdItem", "i3"),
    {},
    {
      id: "k2",
    },
  );
  await links.create(
    ref("NbhdItem", "i5"),
    ref("NbhdItem", "i1"),
    {},
    {
      id: "k3",
    },
  );
  await references.create(
    ref("NbhdItem", "i1"),
    ref("NbhdItem", "i4"),
    {},
    {
      id: "r1",
    },
  );
  await references.create(
    ref("NbhdItem", "i4"),
    ref("NbhdItem", "i4"),
    {},
    {
      id: "r2",
    },
  );
  await references.create(
    ref("NbhdItem", "i3"),
    ref("NbhdLocked", "l1"),
    {},
    {
      id: "r3",
    },
  );
  await references.create(
    ref("NbhdFolder", "f1"),
    ref("NbhdItem", "i6"),
    {},
    {
      id: "r4",
    },
  );
  await references.create(
    ref("NbhdItem", "i2"),
    ref("NbhdItem", "i5"),
    {},
    {
      id: "r5",
    },
  );
  await references.delete("r5" as never);
  await references.create(
    ref("NbhdLocked", "l4"),
    ref("NbhdLocked", "l5"),
    {},
    {
      id: "r6",
    },
  );
  await references.create(
    ref("NbhdItem", "dup"),
    ref("NbhdItem", "i4"),
    {},
    {
      id: "r7",
    },
  );
  // Identity: one class of three items, one of two partless folders, and one
  // separation. i1, i2, i4, i7 and dup take part in none of it.
  await store.identity.assertSame(ref("NbhdItem", "i3"), ref("NbhdItem", "i5"));
  await store.identity.assertSame(ref("NbhdItem", "i5"), ref("NbhdItem", "i6"));
  await store.identity.assertSame(
    ref("NbhdFolder", "f4"),
    ref("NbhdFolder", "f5"),
  );
  await store.identity.assertDifferent(
    ref("NbhdItem", "i5"),
    ref("NbhdItem", "i8"),
  );
}

/** A seeded store on a fresh graph: revision-tracked live, or history. */
async function createSeededStore(
  context: IntegrationTestContext,
  mode: StoreMode,
  graphId = nextGraphId(),
): Promise<NbhdStore> {
  const graph = buildGraph(graphId);
  const store =
    mode === "history" ?
      await context.createHistoryStore(graph)
    : await context.createStore(graph, { revisionTracking: true });
  const nbhdStore = store as unknown as NbhdStore;
  await seed(nbhdStore);
  return nbhdStore;
}

type Row = Readonly<Record<string, unknown>>;

/**
 * One column value as text. Engines differ on whether a flag or a count comes
 * back as a number, a bigint or a string; text is what both stores compare.
 */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "<null>";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  return JSON.stringify(value);
}

/** The result key a select-list entry reads back as. */
function columnKey(column: string): string {
  const aliased = /\bAS (\w+)$/.exec(column);
  return aliased?.[1] ?? column.replaceAll('"', "");
}

/**
 * Rows of one relation of this graph, each as its `columns` joined with `|`,
 * sorted ({@link renderCell}).
 */
async function readRows(
  store: NbhdStore,
  relation: ReturnType<typeof sql>,
  columns: readonly string[],
): Promise<readonly string[]> {
  const rows = await store.backend.execute<Row>(
    asCompiledRowsSql(sql`
      SELECT ${sql.raw(columns.join(", "))}
      FROM ${relation}
      WHERE graph_id = ${store.graphId}
    `),
  );
  return rows
    .map((row) =>
      columns.map((column) => renderCell(row[columnKey(column)])).join("|"),
    )
    .toSorted();
}

const OPEN_RECORDED_ROW = `CASE WHEN recorded_to = ${RECORDED_MAX_REVISION} THEN 1 ELSE 0 END AS open`;
const TOMBSTONED = "CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END AS dead";

/**
 * Everything a node hard delete can leave behind for this graph, free of the
 * graph id, generated ids and wall-clock instants, so two graphs seeded alike
 * compare equal. The per-relation row counts cover what no row read here
 * names, the embedding tables among them.
 */
async function dumpState(store: NbhdStore): Promise<unknown> {
  const schema = createSqlSchema(store.backend.tableNames);
  const inspection = await inspectGraphStorage(store);
  const revision = await store.revisionNow();
  return {
    nodes: await readRows(store, schema.nodesTable, ["kind", "id", TOMBSTONED]),
    edges: await readRows(store, schema.edgesTable, ["kind", "id", TOMBSTONED]),
    uniques: await readRows(store, table(schema.tables.uniques), [
      "node_kind",
      "constraint_name",
      '"key"',
      "node_id",
      "concrete_kind",
    ]),
    claims: await readRows(store, table(schema.tables.edgeClaims), [
      "axis",
      '"key"',
      "edge_id",
    ]),
    fulltext: await readRows(store, schema.fulltextTable, [
      "node_kind",
      "node_id",
    ]),
    assertions: await readRows(store, schema.identityAssertionsTable, [
      "rel",
      "a_kind",
      "a_id",
      "b_kind",
      "b_id",
      "CASE WHEN valid_to IS NULL THEN 0 ELSE 1 END AS ended",
      TOMBSTONED,
    ]),
    closure: await readRows(store, schema.identityClosureTable, [
      "member_kind",
      "member_id",
      "class_kind",
      "class_id",
    ]),
    separation: await readRows(store, schema.identitySeparationTable, [
      "class_key_low",
      "class_key_high",
    ]),
    transitions: await readRows(store, schema.identityTransitionsTable, [
      "cause",
      "class_kind",
      "class_id",
      "prior_class_kind",
      "prior_class_id",
    ]),
    recordedNodes: await readRows(store, schema.recordedNodesTable, [
      "kind",
      "id",
      "op",
      OPEN_RECORDED_ROW,
    ]),
    recordedEdges: await readRows(store, schema.recordedEdgesTable, [
      "kind",
      "id",
      "op",
      OPEN_RECORDED_ROW,
    ]),
    recordedAssertions: await readRows(
      store,
      schema.recordedIdentityAssertionsTable,
      ["a_kind", "a_id", "b_kind", "b_id", "op", OPEN_RECORDED_ROW],
    ),
    relationCounts: inspection.relations.map(
      (relation) => `${relation.relation}=${relation.rows}`,
    ),
    revision:
      revision === undefined ? undefined : recordedInstantRevision(revision),
  };
}

type Outcome = Readonly<{
  error: unknown;
  receipt: unknown;
  state: unknown;
}>;

/** What a refusal carries that a caller can act on. */
function describeError(error: unknown): unknown {
  if (error === undefined) return undefined;
  if (error instanceof RestrictedDeleteError) {
    return {
      name: error.name,
      nodeKind: error.details.nodeKind,
      nodeId: error.details.nodeId,
      edgeCount: error.details.edgeCount,
      edgeKinds: [...error.details.edgeKinds].toSorted(),
    };
  }
  return error instanceof Error ? { name: error.name } : error;
}

/**
 * Runs `write` inside one receipt-reporting transaction, catching what it
 * throws, and dumps the state it leaves.
 */
async function runOutcome(
  store: NbhdStore,
  mode: StoreMode,
  write: (nodes: NbhdStoreHandle["nodes"]) => Promise<void>,
): Promise<Outcome> {
  let error: unknown;
  let receipt: unknown;
  try {
    const outcome = await store.transactionWithReceipt(async (tx) => {
      await write(tx.nodes);
    });
    receipt = {
      writes: outcome.receipt.writes,
      cascadedParts: outcome.receipt.cascadedParts,
    };
  } catch (error_) {
    error = error_;
  }
  return {
    error: describeError(error),
    receipt,
    state: await dumpState(store),
  };
}

/**
 * Builds the fixture twice and compares a per-id `hardDelete` loop in one
 * transaction with one `bulkHardDelete` of the same ids. Returns the batch's
 * outcome for case-specific assertions.
 */
async function expectLoopEquivalence(
  context: IntegrationTestContext,
  mode: StoreMode,
  kind: NodeKindName,
  ids: readonly string[],
): Promise<Outcome> {
  const looped = await createSeededStore(context, mode);
  const batched = await createSeededStore(context, mode);
  const loopOutcome = await runOutcome(looped, mode, async (nodes) => {
    for (const id of ids) await nodeCollection(nodes, kind).hardDelete(id);
  });
  const batchOutcome = await runOutcome(batched, mode, async (nodes) => {
    await nodeCollection(nodes, kind).bulkHardDelete(ids);
  });
  expect(batchOutcome).toEqual(loopOutcome);
  return batchOutcome;
}

class InjectedHardDeleteFailure extends Error {}

const BATCH_MEMBERS = [
  "hardDeleteNodesBatch",
  "findEdgesConnectedToNodes",
] as const;

/**
 * The lane's backend, on the root and on every transaction target, with
 * every call to a node or edge row write counted in `writes`, optionally
 * without the batch members (so the batch must take its per-node fallback),
 * and optionally throwing on the `failOnHardDeleteNode`-th `hardDeleteNode`.
 */
function instrumentedBackend(
  backend: GraphBackend,
  options: Readonly<{
    withoutBatchMembers?: boolean;
    failOnHardDeleteNode?: number;
  }> = {},
): Readonly<{
  backend: GraphBackend;
  hardDeleteNodeCalls: () => number;
  writes: string[];
}> {
  let hardDeleteNodeCalls = 0;
  const writes: string[] = [];
  function instrument<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): T {
    const base =
      options.withoutBatchMembers === true ?
        (projectBackendWithout(target, [...BATCH_MEMBERS]) as T)
      : target;
    const counted = (name: string, original: unknown) =>
      typeof original === "function" ?
        {
          [name]: (...args: unknown[]) => {
            writes.push(name);
            return (original as (...a: unknown[]) => unknown).apply(
              target,
              args,
            );
          },
        }
      : {};
    return deriveBackend(base, {
      ...counted("hardDeleteEdgesBatch", base.hardDeleteEdgesBatch),
      ...counted("hardDeleteEdge", base.hardDeleteEdge),
      ...counted("hardDeleteNodesBatch", base.hardDeleteNodesBatch),
      async hardDeleteNode(params: HardDeleteNodeParams): Promise<void> {
        writes.push("hardDeleteNode");
        hardDeleteNodeCalls += 1;
        if (hardDeleteNodeCalls === options.failOnHardDeleteNode) {
          throw new InjectedHardDeleteFailure();
        }
        await target.hardDeleteNode(params);
      },
    } as never);
  }
  const derived: GraphBackend = deriveBackend(instrument(backend), {
    transaction: (fn, transactionOptions) =>
      backend.transaction((tx) => fn(instrument(tx)), transactionOptions),
  });
  return {
    backend: derived,
    hardDeleteNodeCalls: () => hardDeleteNodeCalls,
    writes,
  };
}

/** A second store over `seeded`'s graph and rows, through `backend`. */
function reopen(seeded: NbhdStore, backend: GraphBackend): NbhdStoreHandle {
  return createStore(buildGraph(seeded.graphId), backend, {
    revisionTracking: true,
  });
}

export function registerNodeBulkHardDeleteIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("node bulkHardDelete", () => {
    for (const mode of ["live", "history"] as const) {
      it(`matches the per-id loop for plain nodes, absent, repeated, tombstoned and other-kind ids (${mode} store)`, async () => {
        const outcome = await expectLoopEquivalence(context, mode, "NbhdItem", [
          "i1",
          "i2",
          "absent",
          "i4",
          "i1",
          "i7",
          "dup",
        ]);
        expect(outcome.error).toBeUndefined();
        const state = outcome.state as Readonly<{ nodes: readonly string[] }>;
        // The other kind's row under the same id survives; i7 was a
        // tombstone and is purged.
        expect(state.nodes).toContain("NbhdLocked|dup|0");
        expect(
          state.nodes.filter((row) => row.startsWith("NbhdItem|")),
        ).toEqual([
          "NbhdItem|i3|0",
          "NbhdItem|i5|0",
          "NbhdItem|i6|0",
          "NbhdItem|i8|0",
        ]);
      });
      // MUTATION CHECK: drop the `kind` predicate from
      // `buildHardDeleteNodesBatch` — NbhdLocked "dup" (and its uniqueness
      // row) is removed by the batch, not the loop.

      it(`matches the per-id loop when plain nodes and identity participants interleave, in several orders (${mode} store)`, async () => {
        for (const ids of [
          ["i1", "i3", "i2", "i5", "i4", "i6", "i8"],
          ["i5", "i1", "i6", "i3", "i2"],
          ["i8", "i3", "i5", "i6", "i4"],
        ]) {
          const outcome = await expectLoopEquivalence(
            context,
            mode,
            "NbhdItem",
            ids,
          );
          expect(outcome.error).toBeUndefined();
        }
      });
      // MUTATION CHECK: return an empty set from `readIdentityParticipants`
      // (every identity participant classified as plain) — the detach is
      // skipped, and the assertion, closure and transition rows diverge.

      it(`matches the per-id loop for composition wholes with and without parts and identity participants, in several orders (${mode} store)`, async () => {
        for (const ids of [
          ["f2", "f1", "f4", "f5"],
          ["f1", "f2", "f4", "f3"],
          ["f4", "f3", "f1", "f2", "f5"],
          ["f3", "f2", "f1"],
        ]) {
          const outcome = await expectLoopEquivalence(
            context,
            mode,
            "NbhdFolder",
            ids,
          );
          expect(outcome.error).toBeUndefined();
        }
      });
      // MUTATION CHECK: make `wholeCascadesToParts` answer `false` — f1 is
      // removed as a plain node and its pages survive.
    }

    it("refuses a late restrict id with the loop's first refusal and deletes nothing, top-level and caught inside a committed transaction", async () => {
      // l1 is connected (r3) and comes last: a batch that wrote as it judged
      // would already have removed l2 and l3.
      const batch = ["l2", "l3", "l1"];
      const outcome = await expectLoopEquivalence(
        context,
        "live",
        "NbhdLocked",
        batch,
      );
      expect(outcome.error).toMatchObject({
        name: "RestrictedDeleteError",
        nodeId: "l1",
        edgeKinds: ["nbhdRefs"],
      });

      const seeded = await createSeededStore(context, "live");
      const before = await dumpState(seeded);
      const instrumented = instrumentedBackend(seeded.backend);
      const store = reopen(seeded, instrumented.backend);
      await expect(
        store.nodes.NbhdLocked.bulkHardDelete(batch as never),
      ).rejects.toBeInstanceOf(RestrictedDeleteError);
      const caught = await store.transaction(async (tx) =>
        tx.nodes.NbhdLocked.bulkHardDelete(batch as never).catch(
          (error: unknown) => error,
        ),
      );
      expect(caught).toBeInstanceOf(RestrictedDeleteError);
      // Every refusal precedes the first write: not one row write was issued.
      expect(instrumented.writes).toEqual([]);
      expect(await dumpState(seeded)).toEqual(before);
    });
    // MUTATION CHECK: apply each planned delete as soon as it is judged
    // (move the writes into `planNodeHardDeleteBatch`'s loop) — l2 and l3
    // are written before l1 refuses, and the committed transaction keeps
    // them.

    it("names the first restrict id in input order when two batch members restrict each other", async () => {
      for (const [ids, refused] of [
        [["l4", "l5"], "l4"],
        [["l5", "l4"], "l5"],
      ] as const) {
        const outcome = await expectLoopEquivalence(
          context,
          "live",
          "NbhdLocked",
          ids,
        );
        expect(outcome.error).toMatchObject({ nodeId: refused });
      }
    });

    it("records no delete row in a history store and closes the removed rows' history", async () => {
      const outcome = await expectLoopEquivalence(
        context,
        "history",
        "NbhdItem",
        ["i1", "i4"],
      );
      const state = outcome.state as Readonly<{
        recordedNodes: readonly string[];
        recordedEdges: readonly string[];
      }>;
      for (const id of ["i1", "i4"]) {
        const rows = recordedFor(state.recordedNodes, id);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.endsWith("|0"))).toBe(true);
        expect(rows.some((row) => row.split("|")[2] === "delete")).toBe(false);
      }
      for (const edgeId of ["k1", "k3", "r1", "r2"]) {
        const rows = recordedFor(state.recordedEdges, edgeId);
        expect(rows.every((row) => row.endsWith("|0"))).toBe(true);
      }
    });

    it("is a no-op that advances no revision and takes no lock for an empty or all-absent batch", async () => {
      const seeded = await createSeededStore(context, "live");
      const before = await dumpState(seeded);
      const transactions: string[] = [];
      const observed = deriveBackend(seeded.backend, {
        transaction: (fn, options) => {
          transactions.push("transaction");
          return seeded.backend.transaction(fn, options);
        },
      });
      const store = reopen(seeded, observed);

      await store.nodes.NbhdItem.bulkHardDelete([]);
      await store.nodes.NbhdItem.bulkHardDelete([
        "absent-1",
        "l1",
        "absent-1",
      ] as never);

      expect(transactions).toEqual([]);
      expect(await dumpState(seeded)).toEqual(before);
    });
    // MUTATION CHECK: drop the gate (`if (gate.size === 0) return;`) from
    // `executeNodeHardDeleteBatch` — the batch opens a transaction.

    it("is refused on a read-only view and with an options argument", async () => {
      const store = await createSeededStore(context, "live");
      const view = store.asOf(new Date().toISOString()).nodes
        .NbhdItem as unknown as Readonly<{
        bulkHardDelete: (ids: readonly string[]) => unknown;
      }>;
      expect(() => view.bulkHardDelete(["i1"])).toThrow(ConfigurationError);
      const untyped = store.nodes.NbhdItem.bulkHardDelete as unknown as (
        ids: readonly string[],
        options: unknown,
      ) => Promise<void>;
      await expect(
        untyped.call(store.nodes.NbhdItem, ["i1"], { expect: {} }),
      ).rejects.toThrow("takes no options");
      expect(
        await store.backend.getNode(store.graphId, "NbhdItem", "i1"),
      ).toBeDefined();
    });

    it("takes the per-node fallback without the batch members, with the same result and no partial write on failure", async () => {
      const ids = ["i1", "i2", "i3", "i4"];
      const reference = await createSeededStore(context, "live");
      await reference.nodes.NbhdItem.bulkHardDelete(ids as never);

      const fallbackSeed = await createSeededStore(context, "live");
      const before = await dumpState(fallbackSeed);
      const failing = instrumentedBackend(fallbackSeed.backend, {
        withoutBatchMembers: true,
        failOnHardDeleteNode: 2,
      });
      await expect(
        reopen(fallbackSeed, failing.backend).nodes.NbhdItem.bulkHardDelete(
          ids as never,
        ),
      ).rejects.toBeInstanceOf(InjectedHardDeleteFailure);
      // The first node's row went before the second failed; the batch's
      // one transaction must have rolled it back.
      expect(failing.hardDeleteNodeCalls()).toBe(2);
      expect(failing.writes).not.toContain("hardDeleteNodesBatch");
      expect(await dumpState(fallbackSeed)).toEqual(before);

      const fallback = instrumentedBackend(fallbackSeed.backend, {
        withoutBatchMembers: true,
      });
      await reopen(
        fallbackSeed,
        fallback.backend,
      ).nodes.NbhdItem.bulkHardDelete(ids as never);
      // i1, i2 and i4 per node in the fallback run, i3 through the single
      // path: four `hardDeleteNode` calls.
      expect(fallback.hardDeleteNodeCalls()).toBe(4);
      expect(fallback.writes).not.toContain("hardDeleteNodesBatch");
      // The failed attempt rolled back without advancing the revision, so
      // even the clocks agree.
      expect(await dumpState(fallbackSeed)).toEqual(await dumpState(reference));
    });
    // MUTATION CHECK: implement the collection's `bulkHardDelete` as a loop
    // of `executeNodeHardDelete` calls, each its own transaction — i1 stays
    // removed after the injected failure.

    it("keeps none of its writes when a failure among them is caught inside a transaction that commits", async () => {
      const seeded = await createSeededStore(context, "live");
      const before = await dumpState(seeded);
      // i1 and i2 are plain and are removed set-wise first; i3 takes the
      // single path, whose `hardDeleteNode` fails.
      const failing = instrumentedBackend(seeded.backend, {
        failOnHardDeleteNode: 1,
      });
      const caught = await reopen(seeded, failing.backend).transaction(
        async (tx) =>
          tx.nodes.NbhdItem.bulkHardDelete(["i1", "i2", "i3"] as never).catch(
            (error: unknown) => error,
          ),
      );
      expect(caught).toBeInstanceOf(InjectedHardDeleteFailure);
      expect(failing.writes).toContain("hardDeleteNodesBatch");
      expect(await dumpState(seeded)).toEqual(before);
    });
    // MUTATION CHECK: call the writes directly instead of through
    // `runFrameWritesAsUnit` in `executeNodeHardDeleteBatch` — i1 and i2 stay
    // removed after the caught failure commits.
  });
}
