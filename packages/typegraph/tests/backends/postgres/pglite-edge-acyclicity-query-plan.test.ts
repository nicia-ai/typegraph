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
 * index-backed `Bitmap Heap Scan` either way (cost 541 old vs 511 new on a
 * 200-node/2000-edge fixture — a real but modest improvement, not a
 * complexity-class change). So the PRIMARY, mutation-provable assertion on
 * this engine is structural: the compiled SQL for the `"proposed"` and
 * `"relation"` seed forms never contains a `candidates` CTE at all — that
 * IS what reverting `buildProbeBodyDirect` reintroduces, regardless of what
 * plan PostgreSQL then picks for it. The plan-level assertions (no `Seq
 * Scan` of the whole `typegraph_edges` table; some index-backed access
 * instead) are a genuine backstop against a full-table-scan regression on
 * this engine, even though they do not differentiate old from new here.
 *
 * Mutation check (recorded in the lane's load-bearing log,
 * scratchpad/lane-D2-probe-fix-load-bearing.md): reverting
 * `buildProbeBodyDirect` to route through `buildProbeBodyPlanned`'s
 * `candidates` CTE machinery makes the "no candidates(" assertions in every
 * test below fail immediately (the CTE reappears in the rendered SQL text).
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

describe("edge-acyclicity probe (PostgreSQL dialect, PGlite): query plan (item D.2 perf ruling)", () => {
  it("a single create's probe compiles no candidates CTE and seeks an index, never a Seq Scan of typegraph_edges", async () => {
    const { backend: raw, client } = await createLocalPgliteBackend({
      vector: false,
    });
    try {
      const { backend, captured } = capturePostgresProbes(raw);
      const store = createStore(buildGraph(), backend);

      const nodes = await Promise.all(
        Array.from({ length: 60 }, (_unused, index) =>
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
        600,
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

      expect(plan).not.toMatch(/Seq Scan on typegraph_edges\b/);
      expect(plan).toMatch(/(Index Scan|Bitmap Index Scan).*typegraph_edges/);
    } finally {
      await raw.close();
    }
  }, 30_000);

  it("a bulkCreate batch's post-insert probe compiles no candidates CTE and seeks an index, never a Seq Scan of typegraph_edges", async () => {
    const { backend: raw, client } = await createLocalPgliteBackend({
      vector: false,
    });
    try {
      const { backend, captured } = capturePostgresProbes(raw);
      const store = createStore(buildGraph(), backend);

      const nodes = await Promise.all(
        Array.from({ length: 60 }, (_unused, index) =>
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
        600,
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

      expect(plan).not.toMatch(/Seq Scan on typegraph_edges\b/);
      expect(plan).toMatch(/(Index Scan|Bitmap Index Scan).*typegraph_edges/);
    } finally {
      await raw.close();
    }
  }, 30_000);

  it("a mixed-orientation relation's audit probe compiles no candidates CTE and seeks BOTH from/to indexes, never a Seq Scan", async () => {
    const { backend: raw, client } = await createLocalPgliteBackend({
      vector: false,
    });
    try {
      const store = createStore(buildGraph(), raw);

      const tasks = await Promise.all(
        Array.from({ length: 60 }, (_unused, index) =>
          store.nodes.Task.create({ name: `t${String(index)}` }),
        ),
      );
      const milestones = await Promise.all(
        Array.from({ length: 60 }, (_unused, index) =>
          store.nodes.Milestone.create({ name: `m${String(index)}` }),
        ),
      );
      for (let index = 0; index < 50; index += 1) {
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
      // Unrelated-kind noise, same shape as the other two tests: without
      // it the whole table is only ~100 rows of exactly the two relevant
      // kinds, and the planner reasonably prefers ONE cheap Seq Scan
      // (materialized and reused across recursion rounds) over any index at
      // that trivial scale — a real graph's edges table holds many kinds.
      for (let index = 0; index < 900; index += 1) {
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
      expect(plan).not.toMatch(/Seq Scan on typegraph_edges\b/);
      expect(plan).toMatch(/(Index Scan|Bitmap Index Scan).*typegraph_edges/);
    } finally {
      await raw.close();
    }
  }, 30_000);
});
