/**
 * The acyclicity probe (`src/store/recursive-cte.ts`'s
 * `buildEdgeAcyclicityProbe`) must be an index seek on
 * `typegraph_edges_from_idx` (or, for a mixed-orientation relation, also
 * `typegraph_edges_to_idx`) for every real write path — never a scan of the
 * whole relation.
 *
 * The defect this guards against (measured via `EXPLAIN QUERY
 * PLAN` on the real probe): the pre-fix probe folded the relation's live
 * edges and the proposed `seed` rows into one compound
 * `candidates(...) AS (SELECT ... FROM typegraph_edges ... UNION ALL SELECT
 * ... FROM seed)` CTE, and the recursive term joined `candidates`. SQLite
 * cannot flatten a compound subquery whose outer query is a join
 * (query-flattener rule 17d), so the plan was `MATERIALIZE candidates` — the
 * ENTIRE relation copied into an ephemeral table on EVERY probe, making
 * every acyclic insert O(|relation|) instead of an index seek. Every seed form
 * now joins `typegraph_edges` directly — see `AcyclicityProbeSeed`'s
 * docblock.
 *
 * Mutation check: temporarily routing the walk back through a compound
 * `candidates` CTE makes every test below fail — `MATERIALIZE` reappears in
 * the plan and the from/to-index seek disappears.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../../src";
import { resolveRecursiveTraversal } from "../../../src/backend/capabilities/recursive-traversal";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sqliteDialect } from "../../../src/query/dialect";
import { renderSqlite } from "../../../src/query/sql-fragment";
import { type AcyclicRelationMember } from "../../../src/store/acyclicity";
import { buildEdgeAcyclicityProbe } from "../../../src/store/recursive-cte";
import { requireDefined } from "../../../src/utils/presence";
import { createPlanCaptureBackend, explainQueryPlan } from "../../test-utils";

const Task = defineNode("Task", { schema: z.object({ name: z.string() }) });
const Milestone = defineNode("Milestone", {
  schema: z.object({ name: z.string() }),
});
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });
const blockedBy = defineEdge("blockedBy", { schema: z.object({}) });

function buildGraph() {
  return defineGraph({
    id: "acyclicity-query-plan",
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

/** The most recent captured statement that IS the acyclicity probe. */
function findProbeStatement(
  captured: readonly Readonly<{ sql: string; params: readonly unknown[] }>[],
) {
  return requireDefined(
    captured.find((statement) => statement.sql.includes("ancestry(")),
    "no acyclicity-probe statement was captured",
  );
}

describe("edge-acyclicity probe: query plan", () => {
  it("a single create's probe seeks typegraph_edges_from_idx directly, no MATERIALIZE candidates", async () => {
    const { backend, captured, client } = createPlanCaptureBackend();
    const store = createStore(buildGraph(), backend);

    // Populate the relation with a real chain, so the probe runs against a
    // non-trivial live population rather than an empty table.
    const nodes = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        store.nodes.Task.create({ name: `t${String(index)}` }),
      ),
    );
    for (let index = 0; index < nodes.length - 2; index += 1) {
      await store.edges.dependsOn.create(
        requireDefined(nodes[index]),
        requireDefined(nodes[index + 1]),
      );
    }
    await store.refreshStatistics();

    captured.length = 0;
    // Extends the chain by one more edge — not a cycle.
    await store.edges.dependsOn.create(
      requireDefined(nodes.at(-2)),
      requireDefined(nodes.at(-1)),
    );

    const probeStatement = findProbeStatement(captured);
    const plan = explainQueryPlan(client, probeStatement);

    expect(plan).toMatch(/typegraph_edges_from_idx/);
    // `MATERIALIZE seed` (the small proposed-row VALUES list) is fine and
    // expected; `MATERIALIZE candidates` — the whole-relation copy — is the
    // regression this test exists to catch, and cannot appear at all now
    // that the `"proposed"` form has no `candidates` CTE.
    // No standalone "no full scan" assertion here: verified empirically (by the
    // mutation check) that reverting to the old compound
    // `candidates` CTE makes SQLite populate it via an INDEX SEARCH on
    // `typegraph_edges_to_idx` (filtered only by `graph_id`), never a bare
    // `SCAN e` — a scan-shaped assertion would never fire. The
    // `from_idx`/`MATERIALIZE candidates` pair above already fails under
    // that exact mutation and is the real backstop.
    expect(plan).not.toContain("MATERIALIZE candidates");
  });

  it("a bulkCreate batch's pre-insert probe seeks typegraph_edges_from_idx directly, no MATERIALIZE candidates", async () => {
    const { backend, captured, client } = createPlanCaptureBackend();
    const store = createStore(buildGraph(), backend);

    const nodes = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        store.nodes.Task.create({ name: `t${String(index)}` }),
      ),
    );
    for (let index = 0; index < nodes.length - 3; index += 1) {
      await store.edges.dependsOn.create(
        requireDefined(nodes[index]),
        requireDefined(nodes[index + 1]),
      );
    }
    await store.refreshStatistics();

    captured.length = 0;
    // Two more edges in ONE batch, extending the chain — not a cycle. The
    // batch's own probe runs BEFORE this insert, with both rows as origins.
    await store.edges.dependsOn.bulkCreate([
      { from: requireDefined(nodes.at(-3)), to: requireDefined(nodes.at(-2)) },
      { from: requireDefined(nodes.at(-2)), to: requireDefined(nodes.at(-1)) },
    ]);

    const probeStatement = findProbeStatement(captured);
    expect(probeStatement.sql).toContain("VALUES");
    const plan = explainQueryPlan(client, probeStatement);

    expect(plan).toMatch(/typegraph_edges_from_idx/);
    // No standalone "no full scan" assertion here: verified empirically (by the
    // mutation check) that reverting to the old compound
    // `candidates` CTE makes SQLite populate it via an INDEX SEARCH on
    // `typegraph_edges_to_idx` (filtered only by `graph_id`), never a bare
    // `SCAN e` — a scan-shaped assertion would never fire. The
    // `from_idx`/`MATERIALIZE candidates` pair above already fails under
    // that exact mutation and is the real backstop.
    expect(plan).not.toContain("MATERIALIZE candidates");
  });

  it("a mixed-orientation relation's audit probe seeks BOTH from_idx and to_idx directly (MULTI-INDEX OR), no candidates CTE", async () => {
    const { backend, client } = createPlanCaptureBackend();
    const store = createStore(buildGraph(), backend);

    // `blockedBy` is not itself `acyclic: true` in this fixture — the mixed
    // relation below is constructed directly, in the composition style, exactly as
    // tests/edge-acyclicity.test.ts's mixed-orientation fixture does.
    // A larger population than the other two tests: SQLite's OR-optimization
    // (`MULTI-INDEX OR`, seeking BOTH `typegraph_edges_from_idx` and
    // `typegraph_edges_to_idx`) is a cost-based choice the planner declines
    // at trivial cardinality, seeking only one index and filtering the rest
    // — still correct, but not what this test is pinning.
    const tasks = await Promise.all(
      Array.from({ length: 40 }, (_unused, index) =>
        store.nodes.Task.create({ name: `t${String(index)}` }),
      ),
    );
    const milestones = await Promise.all(
      Array.from({ length: 40 }, (_unused, index) =>
        store.nodes.Milestone.create({ name: `m${String(index)}` }),
      ),
    );
    for (let index = 0; index < 30; index += 1) {
      await backend.insertEdge({
        graphId: "acyclicity-query-plan",
        id: `f${String(index)}`,
        kind: "dependsOn",
        fromKind: "Task",
        fromId: requireDefined(tasks[index]).id,
        toKind: "Task",
        toId: requireDefined(tasks[index + 1]).id,
        props: {},
      });
      await backend.insertEdge({
        graphId: "acyclicity-query-plan",
        id: `r${String(index)}`,
        kind: "blockedBy",
        fromKind: "Task",
        fromId: requireDefined(tasks[index]).id,
        toKind: "Milestone",
        toId: requireDefined(milestones[index]).id,
        props: {},
      });
    }
    await store.refreshStatistics();

    const members: readonly AcyclicRelationMember[] = [
      { edgeKind: "dependsOn", reversed: false },
      { edgeKind: "blockedBy", reversed: true },
    ];
    const fragment = buildEdgeAcyclicityProbe({
      graphId: "acyclicity-query-plan",
      members,
      seed: { kind: "relation" },
      dialect: sqliteDialect,
      schema: createSqlSchema(backend.tableNames),
      recursiveTraversal: resolveRecursiveTraversal(backend.capabilities),
      operation: "test",
    });
    const rendered = renderSqlite(fragment);
    expect(rendered.sql).not.toContain("candidates(");

    const plan = explainQueryPlan(client, rendered);
    expect(plan).toContain("MULTI-INDEX OR");
    expect(plan).toMatch(/typegraph_edges_from_idx/);
    expect(plan).toMatch(/typegraph_edges_to_idx/);
    expect(plan).not.toContain("MATERIALIZE candidates");
  });
});
