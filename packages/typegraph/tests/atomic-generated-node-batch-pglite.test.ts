import type { PGlite } from "@electric-sql/pglite";
import { type SQL, sql as drizzleSql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { resolveBundledRootAtomicMutationPrograms } from "../src/backend/capabilities/atomic-mutation-program";
import {
  type AtomicNodeClaimEntry,
  buildAtomicNodeClaimCleanupWithSchemaFence,
  buildAtomicNodeClaimGatePredicateWithSchemaFence,
  buildAtomicNodeClaimUpsertWithSchemaFence,
} from "../src/backend/drizzle/operations/atomic-node-claims";
import { buildAtomicNodeBatchWithSchemaFence } from "../src/backend/drizzle/operations/nodes";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { tables } from "../src/backend/drizzle/schema/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import type { SchemaWriteFenceParams } from "../src/backend/types";
import { computeUniqueKey } from "../src/constraints";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { DisjointError, RestrictedDeleteError } from "../src/errors";
import { disjointWith } from "../src/ontology";
import { createStoreWithSchema } from "../src/store";

const UniquePerson = defineNode("UniquePerson", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "atomic-generated-node-batch-pglite",
  nodes: {
    UniquePerson: {
      type: UniquePerson,
      unique: [
        {
          name: "unique_person_name",
          fields: ["name"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

const PlainPerson = defineNode("PlainPerson", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });
const deleteGraph = defineGraph({
  id: "atomic-node-delete-pglite",
  nodes: { PlainPerson: { type: PlainPerson } },
  edges: {
    knows: {
      type: knows,
      from: [PlainPerson],
      to: [PlainPerson],
      cardinality: "many",
    },
  },
});
const Rival = defineNode("Rival", { schema: z.object({ name: z.string() }) });
const disjointGraph = defineGraph({
  id: "atomic-node-disjoint-pglite",
  nodes: { PlainPerson: { type: PlainPerson }, Rival: { type: Rival } },
  edges: {},
  ontology: [disjointWith(PlainPerson, Rival)],
});

const schemaFence = { graphId: graph.id, expectedVersion: 1 } as const;
const timestamp = "2026-08-26T00:00:00.000Z";
const dialect = new PgDialect();

type QueryResult = Readonly<{ rows: readonly Record<string, unknown>[] }>;

function compile(
  query: SQL,
): Readonly<{ sql: string; params: readonly unknown[] }> {
  return dialect.sqlToQuery(query);
}

function claimEntry(
  id: string,
  name: string,
  ordinal = 0,
): AtomicNodeClaimEntry {
  return {
    ordinal,
    entry: {
      idSource: "generated",
      params: {
        graphId: graph.id,
        kind: "UniquePerson",
        id,
        props: { name },
      },
      claim: {
        axis: "UniquePerson",
        constraintName: "unique_person_name",
        key: computeUniqueKey({ name }, ["name"], "binary"),
        placement: "pre-insert",
        verdict: {
          kind: "uniqueness",
          probeAxes: ["UniquePerson"],
          fields: ["name"],
        },
      },
    },
  };
}

function programStatements(
  entries: readonly AtomicNodeClaimEntry[],
  fence: SchemaWriteFenceParams = schemaFence,
): readonly Readonly<{ sql: string; params: readonly unknown[] }>[] {
  const lock = drizzleSql`FOR SHARE`;
  const claim = buildAtomicNodeClaimUpsertWithSchemaFence(
    tables,
    "postgres",
    entries,
    fence,
    lock,
  );
  const gate = buildAtomicNodeClaimGatePredicateWithSchemaFence(
    tables,
    entries,
    fence,
    lock,
  );
  const node = buildAtomicNodeBatchWithSchemaFence(
    tables,
    entries.map((item) => item.entry),
    timestamp,
    fence,
    lock,
    "rows",
    gate,
  );
  const cleanup = buildAtomicNodeClaimCleanupWithSchemaFence(
    tables,
    entries,
    fence,
    lock,
  );
  return [claim, node, cleanup].map((statement) => compile(statement));
}

async function runProgram(
  client: PGlite,
  statements: readonly Readonly<{ sql: string; params: readonly unknown[] }>[],
): Promise<readonly QueryResult[]> {
  await client.exec("BEGIN");
  try {
    const results: QueryResult[] = [];
    for (const statement of statements) {
      results.push(
        await client.query<Record<string, unknown>>(statement.sql, [
          ...statement.params,
        ]),
      );
    }
    await client.exec("COMMIT");
    return results;
  } catch (error) {
    await client.exec("ROLLBACK");
    throw error;
  }
}

describe("constrained generated-node atomic SQL on PGlite", () => {
  let backend: Awaited<ReturnType<typeof createLocalPgliteBackend>>;

  beforeAll(async () => {
    backend = await createLocalPgliteBackend({ vector: false });
    await createStoreWithSchema(graph, backend.backend);
  });

  afterAll(async () => {
    await backend.backend.close();
  });

  it("compiles the complete claim-gated program and inserts its generated node", async () => {
    const entries = [claimEntry("generated-success", "Alice")];
    const statements = programStatements(entries);
    const sqlText = statements.map((statement) => statement.sql).join("\n");

    expect(sqlText).toContain('INSERT INTO "typegraph_node_uniques"');
    expect(sqlText).toContain('INSERT INTO "typegraph_nodes"');
    expect(sqlText).toContain('DELETE FROM "typegraph_node_uniques"');
    expect(sqlText).toContain("FOR SHARE");

    const results = await runProgram(backend.client, statements);
    expect(results[0]?.rows).toEqual([
      {
        node_kind: "UniquePerson",
        constraint_name: "unique_person_name",
        key: entries[0]?.entry.claim?.key,
        node_id: "generated-success",
        concrete_kind: "UniquePerson",
      },
    ]);
    expect(results[1]?.rows).toHaveLength(1);
    await expect(
      backend.backend.getNode(graph.id, "UniquePerson", "generated-success"),
    ).resolves.toMatchObject({ id: "generated-success" });
    await expect(
      backend.backend.checkUnique({
        graphId: graph.id,
        nodeKind: "UniquePerson",
        constraintName: "unique_person_name",
        key: entries[0]?.entry.claim?.key ?? "",
      }),
    ).resolves.toMatchObject({ node_id: "generated-success" });
  });

  it("rolls back a plain node delete set when a connected edge restricts it", async () => {
    // The convenience factory returns a managed-close wrapper. Native mutation
    // programs are exact-root capabilities, so use the marked Drizzle root to
    // prove this test exercises the program rather than its fallback.
    const directBackend = createPostgresBackend(backend.db, { vector: false });
    const [store] = await createStoreWithSchema(deleteGraph, directBackend);
    const source = await store.nodes.PlainPerson.create({ name: "Source" });
    const connected = await store.nodes.PlainPerson.create({
      name: "Connected",
    });
    const isolated = await store.nodes.PlainPerson.create({ name: "Isolated" });
    await store.edges.knows.create(source, connected, {});

    await expect(
      store.nodes.PlainPerson.bulkDelete([isolated.id, connected.id]),
    ).rejects.toBeInstanceOf(RestrictedDeleteError);
    await expect(
      store.nodes.PlainPerson.getById(isolated.id),
    ).resolves.toBeDefined();
    await expect(
      store.nodes.PlainPerson.getById(connected.id),
    ).resolves.toBeDefined();
  });

  it("refuses a legacy disjoint row through the PostgreSQL atomic program", async () => {
    const directBackend = createPostgresBackend(backend.db, { vector: false });
    const [store] = await createStoreWithSchema(disjointGraph, directBackend);
    expect(
      resolveBundledRootAtomicMutationPrograms(directBackend)?.createNodes
        ?.claimSupport?.families,
    ).toContain("disjointness");
    await directBackend.insertNode({
      graphId: disjointGraph.id,
      kind: Rival.kind,
      id: "shared-id",
      props: { name: "Legacy rival" },
    });

    await expect(
      store.nodes.PlainPerson.bulkInsert([
        { id: "sibling", props: { name: "Sibling" } },
        { id: "shared-id", props: { name: "Conflict" } },
      ]),
    ).rejects.toBeInstanceOf(DisjointError);

    await expect(store.nodes.PlainPerson.count()).resolves.toBe(0);
    await expect(store.nodes.Rival.count()).resolves.toBe(1);
  });

  it("returns the incumbent owner and gates a conflicting generated node", async () => {
    const incumbent = await backend.backend.insertNode({
      graphId: graph.id,
      kind: "UniquePerson",
      id: "generated-incumbent",
      props: { name: "Conflict" },
    });
    expect(incumbent.id).toBe("generated-incumbent");
    await backend.backend.insertUnique({
      graphId: graph.id,
      nodeKind: "UniquePerson",
      constraintName: "unique_person_name",
      key: computeUniqueKey({ name: "Conflict" }, ["name"], "binary"),
      nodeId: "generated-incumbent",
      concreteKind: "UniquePerson",
    });

    const entries = [claimEntry("generated-refused", "Conflict")];
    const results = await runProgram(
      backend.client,
      programStatements(entries),
    );

    expect(results[0]?.rows).toMatchObject([
      {
        node_id: "generated-incumbent",
        concrete_kind: "UniquePerson",
      },
    ]);
    expect(results[1]?.rows).toEqual([]);
    await expect(
      backend.backend.getNode(graph.id, "UniquePerson", "generated-refused"),
    ).resolves.toBeUndefined();
    await expect(
      backend.backend.checkUnique({
        graphId: graph.id,
        nodeKind: "UniquePerson",
        constraintName: "unique_person_name",
        key: entries[0]?.entry.claim?.key ?? "",
      }),
    ).resolves.toMatchObject({ node_id: "generated-incumbent" });
  });

  it("cleans up an owned claim when its generated node is absent", async () => {
    const entries = [claimEntry("generated-cleanup", "Cleanup")];
    const claimStatement = compile(
      buildAtomicNodeClaimUpsertWithSchemaFence(
        tables,
        "postgres",
        entries,
        schemaFence,
        drizzleSql`FOR SHARE`,
      ),
    );
    await runProgram(backend.client, [claimStatement]);
    await expect(
      backend.backend.checkUnique({
        graphId: graph.id,
        nodeKind: "UniquePerson",
        constraintName: "unique_person_name",
        key: entries[0]?.entry.claim?.key ?? "",
      }),
    ).resolves.toBeDefined();

    const cleanupStatement = compile(
      buildAtomicNodeClaimCleanupWithSchemaFence(
        tables,
        entries,
        schemaFence,
        drizzleSql`FOR SHARE`,
      ),
    );
    await runProgram(backend.client, [cleanupStatement]);
    await expect(
      backend.backend.checkUnique({
        graphId: graph.id,
        nodeKind: "UniquePerson",
        constraintName: "unique_person_name",
        key: entries[0]?.entry.claim?.key ?? "",
      }),
    ).resolves.toBeUndefined();
  });

  it("makes every claim, gate, and cleanup statement a no-op for a stale fence", async () => {
    const entries = [claimEntry("generated-stale", "Stale")];
    const staleFence = { graphId: graph.id, expectedVersion: 99 } as const;
    const results = await runProgram(
      backend.client,
      programStatements(entries, staleFence),
    );

    expect(results.map((result) => result.rows)).toEqual([[], [], []]);
    await expect(
      backend.backend.getNode(graph.id, "UniquePerson", "generated-stale"),
    ).resolves.toBeUndefined();
    await expect(
      backend.backend.checkUnique({
        graphId: graph.id,
        nodeKind: "UniquePerson",
        constraintName: "unique_person_name",
        key: entries[0]?.entry.claim?.key ?? "",
      }),
    ).resolves.toBeUndefined();
  });
});
