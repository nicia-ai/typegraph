/**
 * PostgreSQL-dialect twin of `tests/backends/sqlite/edge-acyclicity-query-plan.test.ts`
 * (see that file's docblock for the full defect description). Runs against
 * PGlite — no live PostgreSQL server, per this lane's rule — but PGlite is a
 * real Postgres query planner and executor, so a plain `EXPLAIN` (no
 * `ANALYZE`: this asserts the PLAN, not measured row counts) genuinely
 * exercises the same index-choice logic a production PostgreSQL server
 * would apply to the identical statement.
 *
 * **The defect (`MATERIALIZE candidates`, SQLite query-flattener rule 17d)
 * is SQLite-specific.** Verified empirically before writing these
 * assertions: rendering the OLD compound-`candidates` shape for PostgreSQL
 * and comparing `EXPLAIN` against the new direct-join shape shows
 * PostgreSQL's planner already flattens the old compound CTE into the same
 * index-backed access either way. So the PRIMARY, mutation-provable
 * assertion on this engine is structural: the compiled SQL for the
 * `"proposed"` and `"relation"` seed forms never contains a `candidates` CTE
 * at all — that IS what reverting `buildProbeBodyDirect` reintroduces,
 * regardless of what plan PostgreSQL then picks for it.
 *
 * The plan-level assertions are the genuine backstop against the
 * complexity-class regression the fix exists to remove: a per-recursion-round
 * scan of the WHOLE relevant edge-kind partition (a `Bitmap Heap Scan`
 * driven only by `typegraph_edges_kind_idx`, or a `Seq Scan`) instead of a
 * seek CORRELATED to the current frontier node (an `Index Cond` that
 * references the worktable alias, e.g. `from_id = a_1.node_id`). At the
 * small fixture size this suite used to run at (60 nodes, a few hundred
 * edges) PostgreSQL's planner reasonably prefers the kind-partition scan —
 * it is cheaper at that scale — so the fixtures below are sized (a few
 * hundred nodes, several thousand edges) until the planner actually picks
 * the correlated seek; asserting on the correlated-seek `Index Cond` shape
 * at a size where the planner would not choose one is coverage theater; see
 * `extractRecursiveTerm`'s docblock and the mutation check recorded in
 * scratchpad/lane-D2-probe-fix-load-bearing.md.
 *
 * The `Index Cond` shape is pinned, never the index name: PostgreSQL
 * satisfies `graph_id, kind, from_kind, from_id` equally well from
 * `typegraph_edges_cardinality_idx` (leading columns happen to match) as
 * from `typegraph_edges_from_idx`, and picks whichever it estimates
 * cheaper — both are genuine index seeks, so the index name is not the
 * fact this suite needs to hold.
 *
 * Mutation check (recorded in the lane's load-bearing log,
 * scratchpad/lane-D2-probe-fix-load-bearing.md): reverting
 * `buildProbeBodyDirect` to route through `buildProbeBodyPlanned`'s
 * `candidates` CTE machinery makes the "no candidates(" assertions in every
 * test below fail immediately (the CTE reappears in the rendered SQL text),
 * and turns the correlated-seek `Index Cond` assertions into failures too
 * (the compound CTE plan has no worktable-correlated condition at all).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../../src";
import { resolveRecursiveTraversal } from "../../../src/backend/capabilities/recursive-traversal";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import {
  type GraphBackend,
  type TransactionBackend,
} from "../../../src/backend/types";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { postgresDialect } from "../../../src/query/dialect";
import { renderPostgres } from "../../../src/query/sql-fragment";
import { type CompiledRowsSql } from "../../../src/query/sql-intent";
import { type AcyclicRelationMember } from "../../../src/store/acyclicity";
import { buildEdgeAcyclicityProbe } from "../../../src/store/recursive-cte";
import { requireDefined } from "../../../src/utils/presence";

const Task = defineNode("Task", { schema: z.object({ name: z.string() }) });
const Milestone = defineNode("Milestone", {
  schema: z.object({ name: z.string() }),
});
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });
const blockedBy = defineEdge("blockedBy", { schema: z.object({}) });

function buildGraph() {
  return defineGraph({
    id: "acyclicity-query-plan-pg",
    nodes: { Task: { type: Task }, Milestone: { type: Milestone } },
    edges: {
      dependsOn: {
        type: dependsOn,
        from: [Task],
        to: [Task],
        cardinality: "many",
        acyclic: true,
      },
      blockedBy: { type: blockedBy, from: [Task], to: [Task, Milestone] },
    },
  });
}

type CapturedStatement = Readonly<{ sql: string; params: readonly unknown[] }>;

/**
 * Wraps a real PGlite-backed Postgres backend so every `execute()` call
 * (top-level and inside a transaction) is rendered — via the SAME
 * `renderPostgres` the backend itself uses internally to turn a
 * `SqlFragment` into `{ sql, params }` — and recorded. Mirrors
 * `createPlanCaptureBackend`'s SQLite device in `tests/test-utils.ts`,
 * which instead reads `backend.compileSql` (a method only the SQLite
 * adapter exposes). A `CompiledRowsSql` IS a `SqlFragment` at runtime
 * (branded only at the type level, `src/query/sql-intent.ts`), so rendering
 * the object `execute` receives, before delegating, changes nothing about
 * what actually runs.
 */
function capturingExecute(captured: CapturedStatement[]) {
  return async function execute<R>(
    target: Pick<TransactionBackend, "execute">,
    query: CompiledRowsSql,
  ): Promise<readonly R[]> {
    captured.push(renderPostgres(query));
    return target.execute<R>(query);
  };
}

function captureTransactionTarget(
  target: TransactionBackend,
  captured: CapturedStatement[],
): TransactionBackend {
  const execute = capturingExecute(captured);
  return deriveBackend(target, {
    execute: <R>(query: CompiledRowsSql) => execute<R>(target, query),
  });
}

function capturePostgresProbes(raw: GraphBackend): Readonly<{
  backend: GraphBackend;
  captured: CapturedStatement[];
}> {
  const captured: CapturedStatement[] = [];
  const execute = capturingExecute(captured);
  const backend = deriveBackend(raw, {
    execute: <R>(query: CompiledRowsSql) => execute<R>(raw, query),
    transaction: (fn, options) =>
      raw.transaction(
        (target) => fn(captureTransactionTarget(target, captured)),
        options,
      ),
  });
  return { backend, captured };
}

function findProbeStatement(captured: readonly CapturedStatement[]) {
  return requireDefined(
    captured.find((statement) => statement.sql.includes("ancestry(")),
    "no acyclicity-probe statement was captured",
  );
}

async function explainPlan(
  client: Awaited<ReturnType<typeof createLocalPgliteBackend>>["client"],
  statement: CapturedStatement,
): Promise<string> {
  const result = await client.query<Readonly<{ "QUERY PLAN": string }>>(
    `EXPLAIN ${statement.sql}`,
    [...statement.params],
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/**
 * Isolates the `Recursive Union`'s recursive term from a full `EXPLAIN`
 * text tree, so the plan assertions below can pin what the recursive STEP
 * does per round without also matching the (irrelevant) seed CTE scan or
 * the outer closing `SELECT`. `EXPLAIN`'s indentation is structural: the
 * sibling node that follows the `ancestry` CTE (`HashAggregate`, `Sort`, or
 * similar, depending on whether the seed form needs `DISTINCT`/`LIMIT`)
 * always renders at exactly two leading spaces before its own `->`, one
 * level shallower than anything inside the CTE — so that is the boundary.
 */
function extractRecursiveTerm(plan: string): string {
  const startIndex = plan.indexOf("Recursive Union");
  if (startIndex === -1) {
    return "";
  }
  const rest = plan.slice(startIndex);
  const boundary = /\n {2}->/.exec(rest);
  return boundary === null ? rest : rest.slice(0, boundary.index);
}

/** A worktable-correlated `Index Cond` on the FORWARD (`from`) direction — the shape that proves the recursive step seeks per-frontier-node rather than scanning the kind partition. Pins the condition shape, not the index name (PostgreSQL may satisfy it from `typegraph_edges_cardinality_idx` or `typegraph_edges_from_idx`). */
const FORWARD_SEEK_INDEX_COND = /from_id\s*=\s*\w+\.node_id/;
/** The reversed-direction twin of {@link FORWARD_SEEK_INDEX_COND}. */
const REVERSED_SEEK_INDEX_COND = /to_id\s*=\s*\w+\.node_id/;

/** Seeds `count` unrelated-kind edges so a real edge kind's own rows are a minority of the table — the shape a real multi-kind graph has, and the shape that lets the planner's index choice be meaningful rather than "scan everything, it's all one kind anyway". */
async function seedNoiseEdges(
  raw: GraphBackend,
  graphId: string,
  taskIds: readonly string[],
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await raw.insertEdge({
      graphId,
      id: `noise${String(index)}`,
      kind: "blockedBy",
      fromKind: "Task",
      fromId: requireDefined(taskIds[index % taskIds.length]),
      toKind: "Task",
      toId: requireDefined(taskIds[(index + 1) % taskIds.length]),
      props: {},
    });
  }
}

/**
 * Node/noise-edge counts tuned (empirically, against real PGlite `EXPLAIN`
 * output) so the planner actually prefers a per-frontier-node correlated
 * index seek over scanning the whole `dependsOn`/`blockedBy` partition.
 * Below this scale the partition is cheap enough that a `Bitmap Heap Scan`
 * driven only by `typegraph_edges_kind_idx` wins on cost — which is the
 * right call by the planner, but useless as a regression backstop for the
 * O(relation) shape this suite exists to catch.
 */
const PLAN_FIXTURE_NODE_COUNT = 400;
const PLAN_FIXTURE_NOISE_EDGE_COUNT = 4000;

describe("edge-acyclicity probe (PostgreSQL dialect, PGlite): query plan (item D.2 perf ruling)", () => {
  it("a single create's probe compiles no candidates CTE and its recursive step seeks a worktable-correlated index, never a Seq Scan of typegraph_edges", async () => {
    const { backend: raw, client } = await createLocalPgliteBackend({
      vector: false,
    });
    try {
      const { backend, captured } = capturePostgresProbes(raw);
      const store = createStore(buildGraph(), backend);

      const nodes = await Promise.all(
        Array.from({ length: PLAN_FIXTURE_NODE_COUNT }, (_unused, index) =>
          store.nodes.Task.create({ name: `t${String(index)}` }),
        ),
      );
      for (let index = 0; index < nodes.length - 2; index += 1) {
        await store.edges.dependsOn.create(
          requireDefined(nodes[index]),
          requireDefined(nodes[index + 1]),
        );
      }
      await seedNoiseEdges(
        raw,
        "acyclicity-query-plan-pg",
        nodes.map((node) => node.id),
        PLAN_FIXTURE_NOISE_EDGE_COUNT,
      );
      await client.query("ANALYZE typegraph_edges");

      captured.length = 0;
      await store.edges.dependsOn.create(
        requireDefined(nodes.at(-2)),
        requireDefined(nodes.at(-1)),
      );

      const probeStatement = findProbeStatement(captured);
      expect(probeStatement.sql).not.toContain("candidates(");
      const plan = await explainPlan(client, probeStatement);
      const recursiveTerm = extractRecursiveTerm(plan);

      expect(recursiveTerm).not.toMatch(/Seq Scan on typegraph_edges\b/);
      expect(recursiveTerm).toMatch(/Index (Scan|Cond)/);
      expect(recursiveTerm).toMatch(FORWARD_SEEK_INDEX_COND);
    } finally {
      await raw.close();
    }
  }, 30_000);

  it("a bulkCreate batch's post-insert probe compiles no candidates CTE and its recursive step seeks a worktable-correlated index, never a Seq Scan of typegraph_edges", async () => {
    const { backend: raw, client } = await createLocalPgliteBackend({
      vector: false,
    });
    try {
      const { backend, captured } = capturePostgresProbes(raw);
      const store = createStore(buildGraph(), backend);

      const nodes = await Promise.all(
        Array.from({ length: PLAN_FIXTURE_NODE_COUNT }, (_unused, index) =>
          store.nodes.Task.create({ name: `t${String(index)}` }),
        ),
      );
      for (let index = 0; index < nodes.length - 3; index += 1) {
        await store.edges.dependsOn.create(
          requireDefined(nodes[index]),
          requireDefined(nodes[index + 1]),
        );
      }
      await seedNoiseEdges(
        raw,
        "acyclicity-query-plan-pg",
        nodes.map((node) => node.id),
        PLAN_FIXTURE_NOISE_EDGE_COUNT,
      );
      await client.query("ANALYZE typegraph_edges");

      captured.length = 0;
      await store.edges.dependsOn.bulkCreate([
        {
          from: requireDefined(nodes.at(-3)),
          to: requireDefined(nodes.at(-2)),
        },
        {
          from: requireDefined(nodes.at(-2)),
          to: requireDefined(nodes.at(-1)),
        },
      ]);

      const probeStatement = findProbeStatement(captured);
      expect(probeStatement.sql).toContain("VALUES");
      expect(probeStatement.sql).not.toContain("candidates(");
      const plan = await explainPlan(client, probeStatement);
      const recursiveTerm = extractRecursiveTerm(plan);

      expect(recursiveTerm).not.toMatch(/Seq Scan on typegraph_edges\b/);
      expect(recursiveTerm).toMatch(/Index (Scan|Cond)/);
      expect(recursiveTerm).toMatch(FORWARD_SEEK_INDEX_COND);
    } finally {
      await raw.close();
    }
  }, 30_000);

  it("a mixed-orientation relation's audit probe compiles no candidates CTE and its recursive step BitmapOrs two worktable-correlated index seeks, one per direction, never a Seq Scan", async () => {
    const { backend: raw, client } = await createLocalPgliteBackend({
      vector: false,
    });
    try {
      const store = createStore(buildGraph(), raw);

      const tasks = await Promise.all(
        Array.from({ length: PLAN_FIXTURE_NODE_COUNT }, (_unused, index) =>
          store.nodes.Task.create({ name: `t${String(index)}` }),
        ),
      );
      const milestones = await Promise.all(
        Array.from({ length: PLAN_FIXTURE_NODE_COUNT }, (_unused, index) =>
          store.nodes.Milestone.create({ name: `m${String(index)}` }),
        ),
      );
      for (let index = 0; index < tasks.length - 1; index += 1) {
        await raw.insertEdge({
          graphId: "acyclicity-query-plan-pg",
          id: `f${String(index)}`,
          kind: "dependsOn",
          fromKind: "Task",
          fromId: requireDefined(tasks[index]).id,
          toKind: "Task",
          toId: requireDefined(tasks[index + 1]).id,
          props: {},
        });
        await raw.insertEdge({
          graphId: "acyclicity-query-plan-pg",
          id: `r${String(index)}`,
          kind: "blockedBy",
          fromKind: "Task",
          fromId: requireDefined(tasks[index]).id,
          toKind: "Milestone",
          toId: requireDefined(milestones[index]).id,
          props: {},
        });
      }
      // Unrelated-kind noise, same shape and same tuned scale as the other
      // two tests: without it (or below `PLAN_FIXTURE_NOISE_EDGE_COUNT`) the
      // planner reasonably prefers a single `Bitmap Heap Scan` of the whole
      // `dependsOn`/`blockedBy` partition (materialized and reused across
      // recursion rounds) over a correlated seek — a real graph's edges
      // table holds many kinds, and that scan IS the O(relation) shape this
      // suite exists to catch.
      for (let index = 0; index < PLAN_FIXTURE_NOISE_EDGE_COUNT; index += 1) {
        await raw.insertEdge({
          graphId: "acyclicity-query-plan-pg",
          id: `noise${String(index)}`,
          kind: "noise",
          fromKind: "Task",
          fromId: requireDefined(tasks[index % tasks.length]).id,
          toKind: "Task",
          toId: requireDefined(tasks[(index + 1) % tasks.length]).id,
          props: {},
        });
      }
      await client.query("ANALYZE typegraph_edges");

      const members: readonly AcyclicRelationMember[] = [
        { edgeKind: "dependsOn", reversed: false },
        { edgeKind: "blockedBy", reversed: true },
      ];
      const fragment = buildEdgeAcyclicityProbe({
        graphId: "acyclicity-query-plan-pg",
        members,
        seed: { kind: "relation" },
        dialect: postgresDialect,
        schema: createSqlSchema(raw.tableNames),
        recursiveTraversal: resolveRecursiveTraversal(raw.capabilities),
        operation: "test",
      });
      const rendered = renderPostgres(fragment);
      expect(rendered.sql).not.toContain("candidates(");

      const plan = await explainPlan(client, rendered);
      const recursiveTerm = extractRecursiveTerm(plan);

      expect(recursiveTerm).not.toMatch(/Seq Scan on typegraph_edges\b/);
      // The OR of two index-seekable arms (buildAcyclicityAncestryStepDirect's
      // docblock) is what lets PostgreSQL's BitmapOr seek both directions in
      // one recursive step instead of falling back to a partition scan.
      expect(recursiveTerm).toContain("BitmapOr");
      expect(recursiveTerm).toMatch(FORWARD_SEEK_INDEX_COND);
      expect(recursiveTerm).toMatch(REVERSED_SEEK_INDEX_COND);
    } finally {
      await raw.close();
    }
  }, 30_000);
});
