import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type GraphBackend,
  type TransactionBackend,
} from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { createStore, createStoreWithSchema } from "../src/store";
import { createRecordedPostgresStore } from "./statement-recorder";
import { createInitializedStore } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const relation = defineEdge("relation", { schema: z.object({}) });

const graph = defineGraph({
  id: "guarded_edge_cardinality_claim",
  nodes: { Person: { type: Person } },
  edges: {
    one: { type: relation, from: [Person], to: [Person], cardinality: "one" },
    unique: {
      type: relation,
      from: [Person],
      to: [Person],
      cardinality: "unique",
    },
    oneActive: {
      type: relation,
      from: [Person],
      to: [Person],
      cardinality: "oneActive",
    },
  },
});

function edgeEntityStatements(queries: readonly string[]): readonly string[] {
  return queries.filter(
    (query) =>
      /insert into "typegraph_edge_claims"/iu.test(query) ||
      /insert into "typegraph_edges"/iu.test(query) ||
      /select count\(\*\).*from "typegraph_edges"/isu.test(query) ||
      /select .*from "typegraph_nodes"/isu.test(query),
  );
}

async function readClaimRows(
  backend: GraphBackend,
): Promise<readonly { axis: string; key: string; edge_id: string }[]> {
  const schema = createSqlSchema(backend.tableNames);
  return backend.execute<{ axis: string; key: string; edge_id: string }>(
    asCompiledRowsSql(sql`
      SELECT axis, key, edge_id
      FROM ${sql.identifier(schema.tables.edgeClaims)}
      WHERE graph_id = ${graph.id}
      ORDER BY axis, key
    `),
  );
}

describe("guarded edge cardinality claim", () => {
  it.each(["one", "unique", "oneActive"] as const)(
    "folds the %s cardinality claim and endpoint insert into one statement",
    async (kind) => {
      const fixture = await createRecordedPostgresStore(graph);
      const from = await fixture.store.nodes.Person.create({ name: "from" });
      const to = await fixture.store.nodes.Person.create({ name: "to" });

      fixture.reset();
      await fixture.store.edges[kind].create(from, to, {});

      const statements = edgeEntityStatements(
        fixture.statements.map((statement) => statement.query),
      );
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/insert into "typegraph_edge_claims"/iu);
      expect(statements[0]).toMatch(/exists[\s\S]*from "typegraph_edges"/iu);
      expect(statements[0]).toMatch(
        /insert into "typegraph_edges"[\s\S]*select/iu,
      );
      expect(statements[0]).toMatch(/typegraph_nodes/iu);
    },
  );

  it("runs the combined schema/graph fence before the fused edge write", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const [store] = await createStoreWithSchema(graph, fixture.backend);
    const from = await store.nodes.Person.create({ name: "from" });
    const to = await store.nodes.Person.create({ name: "to" });

    fixture.reset();
    await store.edges.one.create(from, to, {});

    const statements = fixture.statements.map((statement) => statement.query);
    const fenceIndex = statements.findIndex(
      (statement) =>
        /for share/iu.test(statement) &&
        /pg_advisory_xact_lock/iu.test(statement),
    );
    const fusedIndex = statements.findIndex(
      (statement) =>
        /insert into "typegraph_edge_claims"/iu.test(statement) &&
        /insert into "typegraph_edges"/iu.test(statement),
    );
    expect(fenceIndex).toBeGreaterThanOrEqual(0);
    expect(fusedIndex).toBe(fenceIndex + 1);
  });

  it("retains the separate probe when the exact target lacks the strong member", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const legacyBackend: GraphBackend = deriveBackend(fixture.backend, {
      async transaction<T>(
        fn: (tx: TransactionBackend) => Promise<T>,
        options?: Parameters<NonNullable<GraphBackend["transaction"]>>[1],
      ): Promise<T> {
        return fixture.backend.transaction(
          (tx) =>
            fn(
              projectBackendWithout(tx, [
                "insertEdgeIfEndpointsLiveWithCardinalityClaim",
              ]),
            ),
          options,
        );
      },
    });
    const store = createStore(graph, legacyBackend);
    const from = await store.nodes.Person.create({ name: "from" });
    const to = await store.nodes.Person.create({ name: "to" });

    fixture.reset();
    await store.edges.one.create(from, to, {});

    const statements = edgeEntityStatements(
      fixture.statements.map((statement) => statement.query),
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/insert into "typegraph_edge_claims"/iu);
    expect(statements[1]).toMatch(/insert into "typegraph_edges"/iu);
  });

  it("does not leave a claim when a fused endpoint check returns no row", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const to = await fixture.store.nodes.Person.create({ name: "to" });

    await fixture.store.transaction(async (transaction) => {
      await expect(
        transaction.edges.one.create(
          { kind: "Person", id: "missing-from" },
          to,
          {},
        ),
      ).rejects.toMatchObject({ details: { endpoint: "from" } });
      // Catching the refusal lets this caller-owned transaction commit. The
      // endpoint CTE must therefore prevent the claim write itself; relying on
      // an operation-owned rollback would not protect this path.
    });
    expect(await readClaimRows(fixture.backend)).toEqual([]);

    const from = await fixture.store.nodes.Person.create({ name: "from" });
    await fixture.store.nodes.Person.delete(to.id);
    await fixture.store.transaction(async (transaction) => {
      await expect(
        transaction.edges.one.create(from, to, {}),
      ).rejects.toMatchObject({ details: { endpoint: "to" } });
    });
    expect(await readClaimRows(fixture.backend)).toEqual([]);
  });

  it("refuses a cardinality conflict without inserting the losing edge", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const from = await fixture.store.nodes.Person.create({ name: "from" });
    const firstTo = await fixture.store.nodes.Person.create({ name: "first" });
    const secondTo = await fixture.store.nodes.Person.create({
      name: "second",
    });

    const incumbent = await fixture.store.edges.one.create(from, firstTo, {});
    await expect(
      fixture.store.edges.one.create(from, secondTo, {}),
    ).rejects.toMatchObject({ details: { cardinality: "one" } });

    expect(await fixture.store.edges.one.findFrom(from)).toHaveLength(1);
    expect(await readClaimRows(fixture.backend)).toEqual([
      expect.objectContaining({ edge_id: incumbent.id }),
    ]);
  });

  it("does not claim a claimless incumbent's axis when the caller commits", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const from = await fixture.store.nodes.Person.create({ name: "from" });
    const firstTo = await fixture.store.nodes.Person.create({ name: "first" });
    const secondTo = await fixture.store.nodes.Person.create({
      name: "second",
    });
    await fixture.backend.insertEdge({
      graphId: graph.id,
      id: "claimless-incumbent",
      kind: "one",
      fromKind: "Person",
      fromId: from.id,
      toKind: "Person",
      toId: firstTo.id,
      props: {},
    });

    await fixture.store.transaction(async (transaction) => {
      await expect(
        transaction.edges.one.create(from, secondTo, {}),
      ).rejects.toMatchObject({ details: { cardinality: "one" } });
    });

    expect(await readClaimRows(fixture.backend)).toEqual([]);
    expect(await fixture.store.edges.one.findFrom(from)).toHaveLength(1);
  });

  it("takes over a stale foreign claim through the fresh fallback", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const from = await fixture.store.nodes.Person.create({ name: "from" });
    const to = await fixture.store.nodes.Person.create({ name: "to" });
    const claim = fixture.backend.claimEdgeCardinality;
    if (claim === undefined) throw new Error("expected edge claim support");

    await claim({
      graphId: graph.id,
      cardinality: "one",
      edgeKind: "one",
      edgeId: "stale-holder",
      fromKind: "Person",
      fromId: from.id,
      toKind: "Person",
      toId: to.id,
    });

    fixture.reset();
    const created = await fixture.store.edges.one.create(from, to, {});
    expect(created.id).not.toBe("stale-holder");
    expect(await readClaimRows(fixture.backend)).toEqual([
      expect.objectContaining({ edge_id: created.id }),
    ]);
    expect(
      fixture.statements.some((statement) =>
        /update "typegraph_edge_claims"/iu.test(statement.query),
      ),
    ).toBe(true);
  });

  it("rolls back the fused claim statement when its edge id is duplicate", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const firstFrom = await fixture.store.nodes.Person.create({
      name: "from-1",
    });
    const secondFrom = await fixture.store.nodes.Person.create({
      name: "from-2",
    });
    const to = await fixture.store.nodes.Person.create({ name: "to" });

    const incumbent = await fixture.store.edges.one.create(
      firstFrom,
      to,
      {},
      {
        id: "duplicate-edge-id",
      },
    );
    await fixture.backend.transaction(async (transaction) => {
      const fused = transaction.insertEdgeIfEndpointsLiveWithCardinalityClaim;
      if (fused === undefined) throw new Error("expected fused edge support");
      await expect(
        fused(
          {
            graphId: graph.id,
            id: "duplicate-edge-id",
            kind: "one",
            fromKind: "Person",
            fromId: secondFrom.id,
            toKind: "Person",
            toId: to.id,
            props: {},
          },
          {
            graphId: graph.id,
            cardinality: "one",
            edgeKind: "one",
            edgeId: "duplicate-edge-id",
            fromKind: "Person",
            fromId: secondFrom.id,
            toKind: "Person",
            toId: to.id,
          },
        ),
      ).rejects.toBeDefined();
      // The duplicate is caught inside the caller's transaction, which then
      // commits. SQL statement atomicity must still roll back its new claim.
    });

    expect(await fixture.store.edges.one.find()).toHaveLength(1);
    expect(await readClaimRows(fixture.backend)).toEqual([
      expect.objectContaining({ edge_id: incumbent.id }),
    ]);
  });

  it("refuses a fused claim that does not describe the inserted edge", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const from = await fixture.store.nodes.Person.create({ name: "from" });
    const to = await fixture.store.nodes.Person.create({ name: "to" });

    await fixture.backend.transaction(async (transaction) => {
      const fused = transaction.insertEdgeIfEndpointsLiveWithCardinalityClaim;
      if (fused === undefined) throw new Error("expected fused edge support");
      await expect(
        fused(
          {
            graphId: graph.id,
            id: "edge-id",
            kind: "one",
            fromKind: "Person",
            fromId: from.id,
            toKind: "Person",
            toId: to.id,
            props: {},
          },
          {
            graphId: graph.id,
            cardinality: "one",
            edgeKind: "one",
            edgeId: "different-edge-id",
            fromKind: "Person",
            fromId: from.id,
            toKind: "Person",
            toId: to.id,
          },
        ),
      ).rejects.toMatchObject({ code: "COMPILER_INVARIANT_ERROR" });
    });

    expect(await fixture.store.edges.one.find()).toEqual([]);
    expect(await readClaimRows(fixture.backend)).toEqual([]);
  });

  it("captures a fused edge row and its claim atomically under history", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const historyStore = createStore(graph, fixture.backend, { history: true });
    const from = await historyStore.nodes.Person.create({ name: "from" });
    const to = await historyStore.nodes.Person.create({ name: "to" });

    fixture.reset();
    const created = await historyStore.edges.one.create(from, to, {});
    const schema = createSqlSchema(fixture.backend.tableNames);
    const recordedRows = await fixture.backend.execute<{ total: number }>(
      asCompiledRowsSql(sql`
        SELECT COUNT(*) AS total
        FROM ${schema.recordedEdgesTable}
        WHERE graph_id = ${graph.id} AND id = ${created.id}
      `),
    );
    expect(recordedRows[0]?.total).toBe(1);
    expect(
      fixture.statements.some((statement) =>
        /insert into "typegraph_recorded_edges"/iu.test(statement.query),
      ),
    ).toBe(true);
    const fused = fixture.statements.filter(
      (statement) =>
        /insert into "typegraph_edge_claims"/iu.test(statement.query) &&
        /insert into "typegraph_edges"/iu.test(statement.query),
    );
    expect(fused).toHaveLength(1);
  });

  it("refuses claimless live incumbents for one, unique, and oneActive", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const from = await fixture.store.nodes.Person.create({ name: "from" });
    const firstTo = await fixture.store.nodes.Person.create({ name: "first" });
    const secondTo = await fixture.store.nodes.Person.create({
      name: "second",
    });

    for (const kind of ["one", "oneActive"] as const) {
      await fixture.backend.insertEdge({
        graphId: graph.id,
        id: `claimless-${kind}`,
        kind,
        fromKind: "Person",
        fromId: from.id,
        toKind: "Person",
        toId: firstTo.id,
        props: {},
      });
      await expect(
        fixture.store.edges[kind].create(from, secondTo, {}),
      ).rejects.toMatchObject({ details: { cardinality: kind } });
    }

    await fixture.backend.insertEdge({
      graphId: graph.id,
      id: "claimless-unique",
      kind: "unique",
      fromKind: "Person",
      fromId: from.id,
      toKind: "Person",
      toId: firstTo.id,
      props: {},
    });
    await expect(
      fixture.store.edges.unique.create(from, firstTo, {}),
    ).rejects.toMatchObject({ details: { cardinality: "unique" } });
  });

  it("ignores tombstones and ended oneActive rows without weakening one", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const from = await fixture.store.nodes.Person.create({ name: "from" });
    const firstTo = await fixture.store.nodes.Person.create({ name: "first" });
    const secondTo = await fixture.store.nodes.Person.create({
      name: "second",
    });

    await fixture.backend.insertEdge({
      graphId: graph.id,
      id: "tombstone-one",
      kind: "one",
      fromKind: "Person",
      fromId: from.id,
      toKind: "Person",
      toId: firstTo.id,
      props: {},
    });
    await fixture.backend.deleteEdge({
      graphId: graph.id,
      id: "tombstone-one",
      kind: "one",
    });
    await expect(
      fixture.store.edges.one.create(from, secondTo, {}),
    ).resolves.toBeDefined();

    await fixture.backend.insertEdge({
      graphId: graph.id,
      id: "ended-active",
      kind: "oneActive",
      fromKind: "Person",
      fromId: secondTo.id,
      toKind: "Person",
      toId: firstTo.id,
      props: {},
      validTo: "2020-01-01T00:00:00.000Z",
    });
    await expect(
      fixture.store.edges.oneActive.create(secondTo, from, {}),
    ).resolves.toBeDefined();

    await fixture.backend.insertEdge({
      graphId: graph.id,
      id: "ended-one",
      kind: "one",
      fromKind: "Person",
      fromId: firstTo.id,
      toKind: "Person",
      toId: secondTo.id,
      props: {},
      validTo: "2020-01-01T00:00:00.000Z",
    });
    await expect(
      fixture.store.edges.one.create(firstTo, from, {}),
    ).rejects.toMatchObject({ details: { cardinality: "one" } });
  });

  it("refuses a stale claim plus a different claimless live edge on SQLite", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const store = await createInitializedStore(graph, backend);
      const from = await store.nodes.Person.create({ name: "from" });
      const firstTo = await store.nodes.Person.create({ name: "first" });
      const secondTo = await store.nodes.Person.create({ name: "second" });

      await backend.claimEdgeCardinality?.({
        graphId: graph.id,
        cardinality: "one",
        edgeKind: "one",
        edgeId: "missing-stale-holder",
        fromKind: "Person",
        fromId: from.id,
        toKind: "Person",
        toId: firstTo.id,
      });
      await backend.insertEdge({
        graphId: graph.id,
        id: "claimless-live-incumbent",
        kind: "one",
        fromKind: "Person",
        fromId: from.id,
        toKind: "Person",
        toId: firstTo.id,
        props: {},
      });

      await expect(
        store.edges.one.create(from, secondTo, {}),
      ).rejects.toMatchObject({ details: { cardinality: "one" } });
    } finally {
      await backend.close();
    }
  });
});
