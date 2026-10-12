/**
 * WHO WRITES THE GRAPH'S FENCE ROW, AND WHO DOES NOT.
 *
 * The per-graph write fence is taken by every history-capturing,
 * revision-tracking or constraint-fenced write, but the graph's row in
 * `typegraph_fences` is advanced only by a writer that makes a decision
 * nothing but the fence protects: an edge-acyclicity probe, a composition
 * whole's parts closure, a match-key convergence. That row is one hot row per
 * graph, so every other holder of the fence must leave it alone — and must not
 * pay a statement for the privilege.
 *
 * Asserted from the emitted SQL, on PGlite: which statements name the fences
 * relation, how many statements each write issues, and what the row's
 * generation is afterwards.
 *
 * - A graph declaring no acyclic and no composition relation issues the same
 *   NUMBER of statements per write as it did before the fence row existed
 *   (`STATEMENTS_WITHOUT_A_FENCE_ROW`, counted on the commit preceding the fence
 *   row) and none of them names the fences relation.
 * - In a graph that does declare one, only the deciding write advances the
 *   row, in the statement that takes the fence; a write that decides nothing
 *   leaves it alone.
 * - A frame that reaches the decision under evidence of the exclusion alone —
 *   a transaction whose fence was taken by a write that decided nothing, or an
 *   edge kind whose named constraint is its cardinality — advances the row
 *   behind the lock it already holds, once.
 *
 * MUTATION CHECKS, each verified and reverted:
 * - `lockRecordedGraphWrite` issuing `acquireKeyedSnapshotFence` (every holder
 *   of the portable fence advances the row) fails the revision-tracking "writes
 *   no fence row" case; the fused statement ignoring `fenceRow: "leave"` fails
 *   the other two and "leaves the row alone".
 * - `writeDecidesUnderLockOnly` answering `true` for every named reason fails
 *   all three "writes no fence row" cases, on their cardinality write.
 * - `writeDecidesUnderLockOnly` answering `false` fails "folds the advance into
 *   the acquisition" (the row is then advanced by a second statement) and both
 *   match-key convergence cases (nothing advances the row).
 * - `fenceLockOnlyDecision` skipping `lockRecordedGraphDecision` fails
 *   "advances the row … at the decision itself".
 * - The frame keeping the evidence it found instead of upgrading it fails both
 *   "advances the row behind the lock a transaction already holds" cases.
 * - A transaction that exposes `tx.sql` keeping its fence evidence across
 *   writes fails "takes the fence again … after the caller rolls back the
 *   savepoint": the second decision then issues no fence statement and the
 *   row is never advanced.
 */
import { sql as drizzleSql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStore,
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import type { GraphBackend } from "../src/backend/types";
import { sql as fragment } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import {
  createRecordedPostgresStore,
  type LoggedStatement,
} from "./statement-recorder";

const Task = defineNode("Task", {
  schema: z.object({ name: z.string(), slug: z.string().optional() }),
});
const relatesTo = defineEdge("relatesTo", { schema: z.object({}) });
const assignedTo = defineEdge("assignedTo", { schema: z.object({}) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });
const blocks = defineEdge("blocks", { schema: z.object({}) });

const taskRegistration = {
  type: Task,
  unique: [
    {
      name: "task_slug",
      fields: ["slug"],
      scope: "kind",
      collation: "binary",
    },
  ],
} as const;

/** Constrained, history-capable, and declaring no lock-only-fenced relation. */
const undeclaredGraph = defineGraph({
  id: "fence-row-scope-undeclared",
  nodes: { Task: taskRegistration },
  edges: {
    relatesTo: { type: relatesTo, from: [Task], to: [Task] },
    assignedTo: {
      type: assignedTo,
      from: [Task],
      to: [Task],
      cardinality: "one",
    },
  },
});

const acyclicGraph = defineGraph({
  id: "fence-row-scope-acyclic",
  nodes: { Task: taskRegistration },
  edges: {
    relatesTo: { type: relatesTo, from: [Task], to: [Task] },
    dependsOn: { type: dependsOn, from: [Task], to: [Task], acyclic: true },
    // Names `edgeCardinality` as its fence reason, and is acyclic as well.
    blocks: {
      type: blocks,
      from: [Task],
      to: [Task],
      cardinality: "one",
      acyclic: true,
    },
  },
});

const FENCES_RELATION = '"typegraph_fences"';
const GRAPH_WRITE_FENCE_NAMESPACE = "typegraph:recorded-graph-write";

/** The statements that name the fences relation: the fence-row writes. */
function fenceRowWrites(
  statements: readonly LoggedStatement[],
): readonly LoggedStatement[] {
  return statements.filter((statement) =>
    statement.query.includes(FENCES_RELATION),
  );
}

/** The statements that take the per-graph write fence. */
function fenceAcquisitions(
  statements: readonly LoggedStatement[],
): readonly LoggedStatement[] {
  return statements.filter(
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      statement.params.includes(GRAPH_WRITE_FENCE_NAMESPACE),
  );
}

async function fenceRowGeneration(
  backend: GraphBackend,
  graphId: string,
): Promise<number | undefined> {
  const rows = await backend.execute<{ generation: string | number }>(
    asCompiledRowsSql(
      fragment`SELECT generation FROM "typegraph_fences" WHERE key = ${`${GRAPH_WRITE_FENCE_NAMESPACE}:${graphId}`}`,
    ),
  );
  const [row] = rows;
  return row === undefined ? undefined : Number(row.generation);
}

type StoreFlavor = "history" | "revisionTracking" | "schemaManaged";

/**
 * Statements each write issues on a graph declaring no lock-only-fenced
 * relation, per store flavor — counted on the commit that precedes the fence
 * row, so an equal count here is "no new statement".
 */
const STATEMENTS_WITHOUT_A_FENCE_ROW = {
  history: {
    nodeCreate: 8,
    nodeUpdate: 9,
    unconstrainedEdgeCreate: 8,
    cardinalityEdgeCreate: 8,
    nodeDelete: 13,
  },
  revisionTracking: {
    nodeCreate: 5,
    nodeUpdate: 6,
    unconstrainedEdgeCreate: 5,
    cardinalityEdgeCreate: 5,
    nodeDelete: 9,
  },
  schemaManaged: {
    nodeCreate: 5,
    nodeUpdate: 6,
    unconstrainedEdgeCreate: 5,
    cardinalityEdgeCreate: 5,
    nodeDelete: 9,
  },
} as const satisfies Record<StoreFlavor, Record<string, number>>;

/** A capturing store of `undeclaredGraph` on a recorded backend. */
async function undeclaredStore(flavor: StoreFlavor) {
  const recorded = await createRecordedPostgresStore(undeclaredGraph);
  switch (flavor) {
    case "history": {
      const [store] = await createStoreWithSchema(
        undeclaredGraph,
        recorded.backend,
        { history: true },
      );
      return { ...recorded, store };
    }
    case "revisionTracking": {
      const store = createStore(undeclaredGraph, recorded.backend, {
        revisionTracking: true,
      });
      return { ...recorded, store };
    }
    case "schemaManaged": {
      const [store] = await createStoreWithSchema(
        undeclaredGraph,
        recorded.backend,
        { revisionTracking: true },
      );
      return { ...recorded, store };
    }
  }
}

/** A schema-managed, revision-tracked store of `acyclicGraph`, with three tasks. */
async function acyclicStore() {
  const recorded = await createRecordedPostgresStore(acyclicGraph);
  const [store] = await createStoreWithSchema(acyclicGraph, recorded.backend, {
    revisionTracking: true,
  });
  const a = await store.nodes.Task.create({ name: "a", slug: "a" });
  const b = await store.nodes.Task.create({ name: "b", slug: "b" });
  const c = await store.nodes.Task.create({ name: "c", slug: "c" });
  return { ...recorded, store, a, b, c };
}

describe("the graph's fence row is written only by a lock-only decision", () => {
  describe.each(["history", "revisionTracking", "schemaManaged"] as const)(
    "a %s store of a graph declaring no acyclic or composition relation",
    (flavor) => {
      it("writes no fence row and pays no statement for one", async () => {
        const recorded = await undeclaredStore(flavor);
        const { store } = recorded;
        const counts: Record<string, number> = {};
        const issued: LoggedStatement[] = [];
        const measure = async <T>(
          name: string,
          write: () => Promise<T>,
        ): Promise<T> => {
          recorded.reset();
          const result = await write();
          counts[name] = recorded.statements.length;
          issued.push(...recorded.statements);
          return result;
        };

        const a = await measure("nodeCreate", () =>
          store.nodes.Task.create({ name: "a", slug: "a" }),
        );
        const b = await store.nodes.Task.create({ name: "b", slug: "b" });
        const c = await store.nodes.Task.create({ name: "c", slug: "c" });
        await measure("nodeUpdate", () =>
          store.nodes.Task.update(a.id, { name: "a2" }),
        );
        await measure("unconstrainedEdgeCreate", () =>
          store.edges.relatesTo.create(a, b),
        );
        await measure("cardinalityEdgeCreate", () =>
          store.edges.assignedTo.create(a, b),
        );
        await measure("nodeDelete", () => store.nodes.Task.delete(c.id));

        // Every one of these writes takes the fence: the store captures.
        expect(fenceAcquisitions(issued).length).toBeGreaterThan(0);
        expect(fenceRowWrites(issued)).toEqual([]);
        expect(counts).toEqual(STATEMENTS_WITHOUT_A_FENCE_ROW[flavor]);
        expect(
          await fenceRowGeneration(recorded.backend, undeclaredGraph.id),
        ).toBeUndefined();
      });
    },
  );

  it("leaves the row alone for a write that decides nothing, in a graph that declares an acyclic relation", async () => {
    const recorded = await acyclicStore();
    const { store, a, b } = recorded;
    recorded.reset();

    await store.nodes.Task.update(a.id, { name: "a2" });
    await store.edges.relatesTo.create(a, b);

    expect(fenceAcquisitions(recorded.statements)).toHaveLength(2);
    expect(fenceRowWrites(recorded.statements)).toEqual([]);
    expect(
      await fenceRowGeneration(recorded.backend, acyclicGraph.id),
    ).toBeUndefined();
  });

  it("folds the advance into the acquisition of a write that names an acyclic relation", async () => {
    const recorded = await acyclicStore();
    const { store, a, b, c } = recorded;
    recorded.reset();

    await store.edges.dependsOn.create(a, b);

    // One statement takes the fence and it is the one that advances the row:
    // the decision costs a row write, not a round trip.
    const fenceStatements = fenceAcquisitions(recorded.statements);
    expect(fenceStatements).toHaveLength(1);
    expect(fenceRowWrites(recorded.statements)).toEqual(fenceStatements);
    expect(await fenceRowGeneration(recorded.backend, acyclicGraph.id)).toBe(1);

    await store.edges.dependsOn.create(b, c);
    expect(await fenceRowGeneration(recorded.backend, acyclicGraph.id)).toBe(2);
  });

  it("advances the row behind the lock a transaction already holds, once, when a later write decides", async () => {
    const recorded = await acyclicStore();
    const { store, a, b, c } = recorded;
    recorded.reset();

    await store.transaction(async (tx) => {
      // Takes the fence for the revision clock and decides nothing.
      await tx.nodes.Task.update(a.id, { name: "a2" });
      expect(fenceRowWrites(recorded.statements)).toEqual([]);

      await tx.edges.dependsOn.create(a, b);
      expect(fenceRowWrites(recorded.statements)).toHaveLength(1);

      // The transaction's evidence now says the row was advanced.
      await tx.edges.dependsOn.create(b, c);
      expect(fenceRowWrites(recorded.statements)).toHaveLength(1);
    });

    expect(await fenceRowGeneration(recorded.backend, acyclicGraph.id)).toBe(1);
  });

  it("takes the fence again and advances the row again after the caller rolls back the savepoint that held the first decision", async () => {
    const recorded = await createRecordedPostgresStore(acyclicGraph);
    const store = createAdapterStore(acyclicGraph, recorded.backend);
    const a = await store.nodes.Task.create({ name: "a", slug: "a" });
    const b = await store.nodes.Task.create({ name: "b", slug: "b" });
    const c = await store.nodes.Task.create({ name: "c", slug: "c" });
    // The standalone creates above decided nothing, so no row exists yet.
    expect(
      await fenceRowGeneration(recorded.backend, acyclicGraph.id),
    ).toBeUndefined();

    await store.transaction(async (tx) => {
      if (tx.sqlAvailability !== "available") {
        throw new Error("The adapter transaction did not expose SQL");
      }
      await tx.sql.execute(drizzleSql`SAVEPOINT first_decision`);
      await tx.edges.dependsOn.create(a, b);
      // Undoes the edge, the row advance and the advisory lock taken with it.
      await tx.sql.execute(drizzleSql`ROLLBACK TO SAVEPOINT first_decision`);
      recorded.reset();

      await tx.edges.dependsOn.create(b, c);
      const fenceStatements = fenceAcquisitions(recorded.statements);
      expect(fenceStatements).toHaveLength(1);
      expect(fenceRowWrites(recorded.statements)).toEqual(fenceStatements);
    });

    expect(await fenceRowGeneration(recorded.backend, acyclicGraph.id)).toBe(1);
    expect(await store.edges.dependsOn.findFrom(a)).toEqual([]);
  });

  it("advances the row behind the lock at the decision itself when the frame named another constraint", async () => {
    const recorded = await acyclicStore();
    const { store, a, b } = recorded;
    recorded.reset();

    // The frame names `edgeCardinality`, so it takes the fence without the
    // row; the acyclicity probe is what advances it.
    await store.edges.blocks.create(a, b);

    expect(fenceRowWrites(recorded.statements)).toHaveLength(1);
    expect(await fenceRowGeneration(recorded.backend, acyclicGraph.id)).toBe(1);
  });

  it("advances the row for a match-key convergence, a lock-only decision in any graph", async () => {
    const recorded = await createRecordedPostgresStore(undeclaredGraph);
    const store = createStore(undeclaredGraph, recorded.backend);
    const a = await store.nodes.Task.create({ name: "a", slug: "a" });
    const b = await store.nodes.Task.create({ name: "b", slug: "b" });
    recorded.reset();

    await store.edges.relatesTo.getOrCreateByEndpoints(a, b, {});

    const fenceStatements = fenceAcquisitions(recorded.statements);
    expect(fenceStatements).toHaveLength(1);
    expect(fenceRowWrites(recorded.statements)).toEqual(fenceStatements);
    expect(await fenceRowGeneration(recorded.backend, undeclaredGraph.id)).toBe(
      1,
    );
  });
  it("advances the row behind the lock a transaction already holds when a later write converges on a match key", async () => {
    const recorded = await createRecordedPostgresStore(undeclaredGraph);
    const store = createStore(undeclaredGraph, recorded.backend, {
      revisionTracking: true,
    });
    const a = await store.nodes.Task.create({ name: "a", slug: "a" });
    const b = await store.nodes.Task.create({ name: "b", slug: "b" });
    recorded.reset();

    await store.transaction(async (tx) => {
      await tx.nodes.Task.update(a.id, { name: "a2" });
      expect(fenceRowWrites(recorded.statements)).toEqual([]);

      // A convergence has no decision site of its own to advance the row at:
      // its frame does, under the evidence the transaction already holds.
      await tx.edges.relatesTo.getOrCreateByEndpoints(a, b, {});
      expect(fenceRowWrites(recorded.statements)).toHaveLength(1);
    });

    expect(await fenceRowGeneration(recorded.backend, undeclaredGraph.id)).toBe(
      1,
    );
  });
});
