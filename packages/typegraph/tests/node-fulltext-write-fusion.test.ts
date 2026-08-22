import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, searchable } from "../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import { createSqliteBackend } from "../src/backend/sqlite";
import {
  type GraphBackend,
  type InsertNodeParams,
  type NodeFulltextSync,
  type NodeInsertPlan,
  type NodeInsertProjection,
  type SchemaWriteFenceParams,
  type TransactionBackend,
} from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { createStore, createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";
import { createRecordedPostgresStore } from "./statement-recorder";
import { createTestDatabase, revisionsAdvanced } from "./test-utils";

const Document = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }).optional(),
  }),
});

const graph = defineGraph({
  id: "node_fulltext_write_fusion",
  nodes: { Document: { type: Document } },
  edges: {},
});

function hasNodeInsert(query: string): boolean {
  return /insert\s+into\s+"typegraph_nodes"/iu.test(query);
}

function hasFulltextWrite(query: string): boolean {
  return /(?:insert\s+into|delete\s+from)\s+"typegraph_node_fulltext"/iu.test(
    query,
  );
}

function hasSchemaFence(query: string): boolean {
  return /typegraph_schema_versions/iu.test(query);
}

function fulltextProjection(fulltext: NodeFulltextSync): NodeInsertProjection {
  return fulltext.action === "upsert" ?
      {
        kind: "fulltext",
        action: "upsert",
        content: fulltext.content,
        language: fulltext.language,
      }
    : { kind: "fulltext", action: "delete" };
}

function ordinaryPlan(fulltext: NodeFulltextSync): NodeInsertPlan {
  return {
    mode: { kind: "ordinary" },
    projections: [fulltextProjection(fulltext)],
  };
}

function schemaFencedPlan(
  fulltext: NodeFulltextSync,
  schemaFence: SchemaWriteFenceParams,
): NodeInsertPlan {
  return {
    mode: { kind: "schema-fenced", schemaFence },
    projections: [fulltextProjection(fulltext)],
  };
}

describe("fresh node + fulltext write fusion", () => {
  it("uses one schema-fenced statement for a generated searchable node", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const [store] = await createStoreWithSchema(graph, fixture.backend);

    fixture.reset();
    const node = await store.transaction(async (tx) =>
      tx.nodes.Document.create({
        title: "Neon keeps this in one round trip",
        body: "searchable content",
      }),
    );

    expect((node as unknown as { title: string }).title).toBe(
      "Neon keeps this in one round trip",
    );
    expect(fixture.statements).toHaveLength(1);
    const statement = requireDefined(fixture.statements[0], "fused statement");
    expect(hasSchemaFence(statement.query)).toBe(true);
    expect(hasNodeInsert(statement.query)).toBe(true);
    expect(hasFulltextWrite(statement.query)).toBe(true);
    expect(statement.query).toMatch(/inserted_node/iu);
  });

  it("dispatches the root generated-ID path through the fused member", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const [store] = await createStoreWithSchema(graph, fixture.backend);
    requireDefined(
      fixture.backend.insertNodeWithProjections,
      "projection member",
    );
    const spy = vi.spyOn(fixture.backend, "insertNodeWithProjections");
    const transactionSpy = vi.spyOn(fixture.backend, "transaction");

    await store.nodes.Document.create({ title: "root dispatch" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.results[0]?.type).toBe("return");
    expect(spy.mock.calls[0]?.[1].mode.kind).toBe("schema-fenced");
    expect(transactionSpy).not.toHaveBeenCalled();
    spy.mockRestore();
    transactionSpy.mockRestore();
  });

  it("combines the ordinary backend member into one statement", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    await createStoreWithSchema(graph, fixture.backend);
    const params: InsertNodeParams = {
      graphId: graph.id,
      kind: "Document",
      id: "ordinary-fused-node",
      props: { title: "ordinary fused statement" },
    };
    const fulltext: NodeFulltextSync = {
      graphId: graph.id,
      nodeKind: "Document",
      nodeId: params.id,
      action: "upsert",
      content: "ordinary fused statement",
      language: "english",
    };

    fixture.reset();
    await fixture.backend.transaction(async (tx) => {
      await requireDefined(tx.insertNodeWithProjections)(
        params,
        ordinaryPlan(fulltext),
      );
    });

    expect(fixture.statements).toHaveLength(1);
    const statement = requireDefined(fixture.statements[0], "fused statement");
    expect(hasSchemaFence(statement.query)).toBe(false);
    expect(hasNodeInsert(statement.query)).toBe(true);
    expect(hasFulltextWrite(statement.query)).toBe(true);
  });

  it("keeps caller-supplied IDs on the portable node and sidecar path", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const [store] = await createStoreWithSchema(graph, fixture.backend);

    fixture.reset();
    await store.nodes.Document.create(
      { title: "caller supplied identity" },
      { id: "caller-supplied-node" },
    );

    const entityStatements = fixture.statements.filter(
      (statement) =>
        hasNodeInsert(statement.query) || hasFulltextWrite(statement.query),
    );
    expect(entityStatements).toHaveLength(2);
    expect(
      entityStatements.some(
        (statement) =>
          hasNodeInsert(statement.query) && hasFulltextWrite(statement.query),
      ),
    ).toBe(false);
  });

  it("uses schema-fenced fusion without requiring the ordinary fused member", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    let fusedCallCount = 0;
    const schemaOnlyBackend: GraphBackend = deriveBackend(fixture.backend, {
      async transaction<T>(
        fn: (tx: TransactionBackend) => Promise<T>,
        options?: Parameters<NonNullable<GraphBackend["transaction"]>>[1],
      ): Promise<T> {
        return fixture.backend.transaction((tx) => {
          const insert = requireDefined(tx.insertNodeWithProjections);
          return fn(
            deriveBackend(tx, {
              async insertNodeWithProjections(
                params: InsertNodeParams,
                plan: NodeInsertPlan,
              ) {
                fusedCallCount += 1;
                expect(plan.mode.kind).toBe("schema-fenced");
                return insert(params, plan);
              },
            }),
          );
        }, options);
      },
    });
    const [store] = await createStoreWithSchema(graph, schemaOnlyBackend);

    await store.nodes.Document.create({ title: "schema member independently" });

    expect(fusedCallCount).toBe(1);
  });

  it("makes non-empty content searchable after the fused write", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const [store] = await createStoreWithSchema(graph, fixture.backend);

    await store.nodes.Document.create({
      title: "cross region latency",
      body: "the indexed body",
    });

    const hits = await store.search.fulltext("Document", {
      query: "indexed",
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect((hits[0]?.node as { title: string } | undefined)?.title).toBe(
      "cross region latency",
    );
  });

  it("does not emit a second delete for empty optional searchable content", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const [store] = await createStoreWithSchema(graph, fixture.backend);

    fixture.reset();
    await store.transaction(async (tx) =>
      tx.nodes.Document.create({ title: "" }),
    );

    expect(fixture.statements).toHaveLength(1);
    expect(fixture.statements[0]?.query).toMatch(/delete\s+from/iu);
    expect(fixture.statements[0]?.query).toMatch(/typegraph_node_fulltext/iu);
    const hits = await store.search.fulltext("Document", {
      query: "title only",
      limit: 10,
    });
    expect(hits).toHaveLength(0);
  });

  it("rolls back a duplicate fused insert without leaking a fulltext row", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const [store] = await createStoreWithSchema(graph, fixture.backend);
    const existing = await store.nodes.Document.create(
      { title: "already present" },
      { id: "duplicate-node" },
    );
    const params: InsertNodeParams = {
      graphId: graph.id,
      kind: "Document",
      id: existing.id,
      props: { title: "replacement" },
    };
    const fulltext: NodeFulltextSync = {
      graphId: graph.id,
      nodeKind: "Document",
      nodeId: existing.id,
      action: "upsert",
      content: "replacement",
      language: "english",
    };

    await expect(
      fixture.backend.transaction(async (tx) => {
        await requireDefined(tx.insertNodeWithProjections)(
          params,
          ordinaryPlan(fulltext),
        );
      }),
    ).rejects.toThrow();

    const hits = await store.search.fulltext("Document", {
      query: "replacement",
      limit: 10,
    });
    expect(hits).toHaveLength(0);
    const existingHits = await store.search.fulltext("Document", {
      query: "already present",
      limit: 10,
    });
    expect(existingHits.map((hit) => (hit.node as { id: string }).id)).toEqual([
      existing.id,
    ]);
  });

  it("rolls back the node when the fused fulltext side effect fails", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const [store] = await createStoreWithSchema(graph, fixture.backend);
    const params: InsertNodeParams = {
      graphId: graph.id,
      kind: "Document",
      id: "sidecar-error-node",
      props: { title: "should roll back" },
    };
    const fulltext: NodeFulltextSync = {
      graphId: graph.id,
      nodeKind: "Document",
      nodeId: params.id,
      action: "upsert",
      content: "should roll back",
      language: "not_a_real_regconfig",
    };

    await expect(
      fixture.backend.transaction(async (tx) => {
        await requireDefined(tx.insertNodeWithProjections)(
          params,
          ordinaryPlan(fulltext),
        );
      }),
    ).rejects.toThrow();

    expect(await fixture.backend.getNode(graph.id, "Document", params.id)).toBe(
      undefined,
    );
    expect(
      await store.search.fulltext("Document", {
        query: "should roll back",
        limit: 10,
      }),
    ).toHaveLength(0);
  });

  it("refuses a projection plan whose schema fence targets another graph", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    await createStoreWithSchema(graph, fixture.backend);
    const params: InsertNodeParams = {
      graphId: graph.id,
      kind: "Document",
      id: "correlated-node",
      props: { title: "correlated content" },
    };
    const projection: NodeFulltextSync = {
      graphId: graph.id,
      nodeKind: "Document",
      nodeId: params.id,
      action: "upsert",
      content: "correlated content",
      language: "english",
    };

    await fixture.backend.transaction(async (tx) => {
      await expect(
        requireDefined(tx.insertNodeWithProjections)(
          params,
          schemaFencedPlan(projection, {
            graphId: "different-graph",
            expectedVersion: 1,
          }),
        ),
      ).rejects.toMatchObject({ code: "COMPILER_INVARIANT_ERROR" });
    });

    expect(await fixture.backend.getNode(graph.id, "Document", params.id)).toBe(
      undefined,
    );
    expect(
      await fixture.store.search.fulltext("Document", {
        query: "correlated",
        limit: 10,
      }),
    ).toHaveLength(0);
  });

  it("captures the fused node row under recorded history", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const [schemaStore] = await createStoreWithSchema(graph, fixture.backend);
    const historyStore = createStore(graph, fixture.backend, { history: true });

    const created = await historyStore.nodes.Document.create({
      title: "recorded fused content",
    });
    const schema = createSqlSchema(fixture.backend.tableNames);
    const rows = await fixture.backend.execute<{ total: number }>(
      asCompiledRowsSql(sql`
        SELECT COUNT(*) AS total
        FROM ${schema.recordedNodesTable}
        WHERE graph_id = ${graph.id} AND id = ${created.id}
      `),
    );

    expect(rows[0]?.total).toBe(1);
    expect(
      await schemaStore.search.fulltext("Document", {
        query: "recorded",
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  it("advances the revision exactly once for a fused node write", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const [schemaStore] = await createStoreWithSchema(graph, fixture.backend);
    const revisionStore = createStore(graph, fixture.backend, {
      revisionTracking: true,
    });
    await revisionStore.nodes.Document.create({ title: "revision baseline" });
    const before = await revisionStore.revisionNow();

    await revisionStore.nodes.Document.create({ title: "one fused revision" });

    expect(revisionsAdvanced(before, await revisionStore.revisionNow())).toBe(
      1,
    );
    expect(
      await schemaStore.search.fulltext("Document", {
        query: "fused",
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  it("falls back to separate node and fulltext statements when the member is projected away", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const projected: GraphBackend = deriveBackend(fixture.backend, {
      async transaction<T>(
        fn: (tx: TransactionBackend) => Promise<T>,
        options?: Parameters<NonNullable<GraphBackend["transaction"]>>[1],
      ): Promise<T> {
        return fixture.backend.transaction(
          (tx) => fn(projectBackendWithout(tx, ["insertNodeWithProjections"])),
          options,
        );
      },
    });
    const [store] = await createStoreWithSchema(graph, projected);

    fixture.reset();
    await store.nodes.Document.create({ title: "fallback path" });

    const queries = fixture.statements.map((statement) => statement.query);
    expect(queries.some((query) => hasNodeInsert(query))).toBe(true);
    expect(queries.some((query) => hasFulltextWrite(query))).toBe(true);
    expect(
      queries.some((query) => hasNodeInsert(query) && hasFulltextWrite(query)),
    ).toBe(false);
  });

  it("keeps SQLite on its ordinary sidecar path", async () => {
    const database = createTestDatabase();
    const backend = createSqliteBackend(database);
    expect(backend.insertNodeWithProjections).toBeUndefined();

    const [store] = await createStoreWithSchema(graph, backend);
    const node = await store.nodes.Document.create({ title: "sqlite" });
    expect((node as unknown as { title: string }).title).toBe("sqlite");
    const hits = await store.search.fulltext("Document", {
      query: "sqlite",
      limit: 10,
    });
    expect(hits).toHaveLength(1);
  });
});
