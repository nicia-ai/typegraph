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
import { createStore } from "../src/store";
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

describe("guarded edge cardinality claim", () => {
  it("folds the cardinality and endpoint probes into two successful-path statements", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const from = await fixture.store.nodes.Person.create({ name: "from" });
    const to = await fixture.store.nodes.Person.create({ name: "to" });

    fixture.reset();
    await fixture.store.edges.one.create(from, to, {});

    const statements = edgeEntityStatements(
      fixture.statements.map((statement) => statement.query),
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/insert into "typegraph_edge_claims"/iu);
    expect(statements[0]).toMatch(/exists[\s\S]*from "typegraph_edges"/iu);
    expect(statements[1]).toMatch(
      /insert into "typegraph_edges"[\s\S]*select/iu,
    );
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
            fn(projectBackendWithout(tx, ["claimEdgeCardinalityGuarded"])),
          options,
        );
      },
    });
    const store = createStore(graph, legacyBackend);
    const from = await store.nodes.Person.create({ name: "from" });
    const to = await store.nodes.Person.create({ name: "to" });

    fixture.reset();
    await store.edges.one.create(from, to, {});

    expect(
      fixture.statements.some(
        (statement) =>
          /select count/iu.test(statement.query) &&
          /from "typegraph_edges"/iu.test(statement.query),
      ),
    ).toBe(true);
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
