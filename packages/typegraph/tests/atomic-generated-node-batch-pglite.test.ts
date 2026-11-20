import type { PGlite } from "@electric-sql/pglite";
import { type SQL, sql as drizzleSql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  resolveBundledRootAtomicMutationPrograms,
  withAtomicMutationProgramDispatchObserver,
} from "../src/backend/capabilities/atomic-mutation-program";
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
import {
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  searchable,
} from "../src/core";
import {
  ContributionUnavailableError,
  DisjointError,
  RestrictedDeleteError,
  StaleVersionError,
  UniquenessError,
} from "../src/errors";
import { disjointWith, subClassOf } from "../src/ontology";
import { vectorPhysicalName } from "../src/query/dialect/vector-strategy";
import { migrateSchema } from "../src/schema";
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
const SearchDocument = defineNode("SearchDocument", {
  schema: z.object({ title: searchable() }),
});
const projectionGraph = defineGraph({
  id: "atomic-node-projection-pglite",
  nodes: { SearchDocument: { type: SearchDocument } },
  edges: {},
});
const evolvedProjectionGraph = defineGraph({
  id: projectionGraph.id,
  nodes: {
    SearchDocument: {
      type: defineNode("SearchDocument", {
        schema: z.object({
          title: searchable(),
          subtitle: z.string().optional(),
        }),
      }),
    },
  },
  edges: {},
});
const VectorDocument = defineNode("VectorDocument", {
  schema: z.object({ vector: embedding(2).optional() }),
});
const vectorProjectionGraph = defineGraph({
  id: "atomic-node-vector-projection-pglite",
  nodes: { VectorDocument: { type: VectorDocument } },
  edges: {},
});
const ComposedDocument = defineNode("ComposedDocument", {
  schema: z.object({
    slug: z.string(),
    tenant: z.string(),
    title: searchable(),
  }),
});
const composedGraph = defineGraph({
  id: "atomic-node-composed-pglite",
  nodes: {
    ComposedDocument: {
      type: ComposedDocument,
      unique: [
        {
          name: "composed_slug",
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
        {
          name: "composed_tenant_title",
          fields: ["tenant", "title"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});
const replacementComposedGraph = defineGraph({
  id: `${composedGraph.id}-replacement`,
  nodes: composedGraph.nodes,
  edges: {},
});
const ScopedPerson = defineNode("ScopedPerson", {
  schema: z.object({ email: z.string() }),
});
const ScopedEmployee = defineNode("ScopedEmployee", {
  schema: z.object({ email: z.string() }),
});
const scopedGraph = defineGraph({
  id: "atomic-node-scoped-pglite",
  nodes: {
    ScopedPerson: {
      type: ScopedPerson,
      unique: [
        {
          name: "scoped_email",
          fields: ["email"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
    ScopedEmployee: {
      type: ScopedEmployee,
      unique: [
        {
          name: "scoped_email",
          fields: ["email"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
  ontology: [subClassOf(ScopedEmployee, ScopedPerson)],
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
  const claim = {
    axis: "UniquePerson",
    constraintName: "unique_person_name",
    key: computeUniqueKey({ name }, ["name"], "binary"),
    placement: "pre-insert",
    verdict: {
      kind: "uniqueness",
      probeAxes: ["UniquePerson"],
      fields: ["name"],
    },
  } as const;
  return {
    memberOrdinal: ordinal,
    claimOrdinal: 0,
    claim,
    entry: {
      idSource: "generated",
      params: {
        graphId: graph.id,
        kind: "UniquePerson",
        id,
        props: { name },
      },
      claims: [claim],
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
        key: entries[0]?.claim.key,
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
        key: entries[0]?.claim.key ?? "",
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

  it("commits projected node rows and fulltext sidecars in one PostgreSQL program", async () => {
    const directBackend = createPostgresBackend(backend.db, { vector: false });
    const [store] = await createStoreWithSchema(projectionGraph, directBackend);
    expect(
      resolveBundledRootAtomicMutationPrograms(directBackend)?.createNodes
        ?.projectionSupport,
    ).toEqual({ families: ["fulltext"] });

    await store.nodes.SearchDocument.bulkInsert([
      { id: "projected", props: { title: "Atomic projection" } },
    ]);

    await expect(
      store.search.fulltext("SearchDocument", {
        query: "projection",
        limit: 10,
      }),
    ).resolves.toHaveLength(1);

    await store.nodes.SearchDocument.update("projected" as never, {
      title: "",
    });

    await expect(
      store.search.fulltext("SearchDocument", {
        query: "projection",
        limit: 10,
      }),
    ).resolves.toHaveLength(0);
  });

  it("commits vector sidecars through the PostgreSQL atomic program", async () => {
    const vectorBackend = await createLocalPgliteBackend();
    try {
      const directBackend = createPostgresBackend(vectorBackend.db);
      const [store] = await createStoreWithSchema(
        vectorProjectionGraph,
        directBackend,
      );
      expect(
        resolveBundledRootAtomicMutationPrograms(directBackend)?.createNodes
          ?.projectionSupport,
      ).toEqual({ families: ["embedding", "fulltext"] });

      await store.nodes.VectorDocument.bulkInsert([
        { id: "vector-projected", props: { vector: [1, 0] } },
      ]);

      const hits = await store.search.vector("VectorDocument", {
        fieldPath: "vector",
        queryEmbedding: [1, 0],
        limit: 1,
      });
      expect(hits[0]?.node.id).toBe("vector-projected");

      const variants: string[] = [];
      await withAtomicMutationProgramDispatchObserver(
        directBackend,
        (variant) => variants.push(variant),
        () =>
          store.nodes.VectorDocument.update("vector-projected" as never, {
            vector: undefined,
          }),
      );
      expect(variants).toEqual(["updateNodes"]);
      await expect(
        store.nodes.VectorDocument.getById("vector-projected" as never),
      ).resolves.not.toHaveProperty("vector");
      const vectorRows = await vectorBackend.client.query(
        `SELECT node_id FROM "${vectorPhysicalName(
          "tg_vec",
          vectorProjectionGraph.id,
          "VectorDocument",
          "vector",
        )}"`,
      );
      expect(vectorRows.rows).toEqual([]);
      await expect(
        store.search.vector("VectorDocument", {
          fieldPath: "vector",
          queryEmbedding: [1, 0],
          limit: 1,
        }),
      ).resolves.toHaveLength(0);
    } finally {
      await vectorBackend.backend.close();
    }
  });

  it("composes multiple claims and fulltext in one PostgreSQL program", async () => {
    const directBackend = createPostgresBackend(backend.db, { vector: false });
    const [store] = await createStoreWithSchema(composedGraph, directBackend);

    await store.nodes.ComposedDocument.bulkInsert([
      {
        id: "incumbent",
        props: { slug: "incumbent", tenant: "tenant", title: "Held title" },
      },
    ]);
    await expect(
      store.search.fulltext("ComposedDocument", {
        query: "Held",
        limit: 10,
      }),
    ).resolves.toHaveLength(1);

    await expect(
      store.nodes.ComposedDocument.bulkInsert([
        {
          id: "sibling",
          props: { slug: "sibling", tenant: "tenant", title: "Sibling" },
        },
        {
          id: "conflict",
          props: { slug: "new", tenant: "tenant", title: "Held title" },
        },
      ]),
    ).rejects.toMatchObject({
      name: UniquenessError.name,
      details: { constraintName: "composed_tenant_title" },
    });
    await expect(store.nodes.ComposedDocument.count()).resolves.toBe(1);
    await expect(
      store.search.fulltext("ComposedDocument", {
        query: "Sibling",
        limit: 10,
      }),
    ).resolves.toHaveLength(0);
  });

  it("replaces claimed projected nodes through one PostgreSQL program", async () => {
    const directBackend = createPostgresBackend(backend.db, { vector: false });
    const [store] = await createStoreWithSchema(
      replacementComposedGraph,
      directBackend,
    );

    await store.nodes.ComposedDocument.bulkInsert([
      {
        id: "replace-a",
        props: { slug: "a", tenant: "tenant", title: "Before A" },
      },
      {
        id: "replace-b",
        props: { slug: "b", tenant: "tenant", title: "Before B" },
      },
    ]);

    const rows = await store.nodes.ComposedDocument.bulkReplaceById([
      {
        id: "replace-a",
        props: { slug: "released", tenant: "tenant", title: "Quasar A" },
      },
      {
        id: "replace-b",
        props: { slug: "a", tenant: "tenant", title: "Quasar B" },
      },
    ]);

    expect(rows.map((row) => [row.id, row.slug, row.title])).toEqual([
      ["replace-a", "released", "Quasar A"],
      ["replace-b", "a", "Quasar B"],
    ]);
    await expect(
      store.search.fulltext("ComposedDocument", {
        query: "Quasar",
        limit: 10,
      }),
    ).resolves.toHaveLength(2);
  });

  it("refuses a legacy cross-scope claim through the PostgreSQL program", async () => {
    const directBackend = createPostgresBackend(backend.db, { vector: false });
    const [store] = await createStoreWithSchema(scopedGraph, directBackend);
    const key = computeUniqueKey(
      { email: "legacy@example.com" },
      ["email"],
      "binary",
    );
    await directBackend.insertNode({
      graphId: scopedGraph.id,
      kind: ScopedPerson.kind,
      id: "legacy-owner",
      props: { email: "legacy@example.com" },
    });
    await directBackend.insertUnique({
      graphId: scopedGraph.id,
      nodeKind: ScopedPerson.kind,
      constraintName: "scoped_email",
      key,
      nodeId: "legacy-owner",
      concreteKind: ScopedPerson.kind,
    });

    await expect(
      store.nodes.ScopedEmployee.bulkInsert([
        { id: "sibling", props: { email: "sibling@example.com" } },
        { id: "conflict", props: { email: "legacy@example.com" } },
      ]),
    ).rejects.toMatchObject({
      name: UniquenessError.name,
      details: { existingId: "legacy-owner" },
    });
    await expect(store.nodes.ScopedEmployee.count()).resolves.toBe(0);
  });

  it("rolls projected PostgreSQL updates back behind a stale fence", async () => {
    const isolated = await createLocalPgliteBackend({ vector: false });
    try {
      const directBackend = createPostgresBackend(isolated.db, {
        vector: false,
      });
      const [store] = await createStoreWithSchema(
        projectionGraph,
        directBackend,
      );
      await store.nodes.SearchDocument.bulkInsert([
        { id: "stale-projected", props: { title: "Before" } },
      ]);
      await migrateSchema(directBackend, evolvedProjectionGraph, 1);

      await expect(
        store.nodes.SearchDocument.update("stale-projected" as never, {
          title: "After",
        }),
      ).rejects.toBeInstanceOf(StaleVersionError);
      await expect(
        store.search.fulltext("SearchDocument", {
          query: "After",
          limit: 10,
        }),
      ).resolves.toHaveLength(0);
    } finally {
      await isolated.backend.close();
    }
  });

  it("refuses missing PostgreSQL projection storage without persisting its node", async () => {
    const isolated = await createLocalPgliteBackend({ vector: false });
    try {
      const directBackend = createPostgresBackend(isolated.db, {
        vector: false,
      });
      const [store] = await createStoreWithSchema(
        projectionGraph,
        directBackend,
      );
      await isolated.client.exec(`DROP TABLE ${tables.fulltextTableName}`);

      await expect(
        store.nodes.SearchDocument.bulkInsert([
          { id: "missing-sidecar", props: { title: "Unavailable" } },
        ]),
      ).rejects.toBeInstanceOf(ContributionUnavailableError);
      await expect(store.nodes.SearchDocument.count()).resolves.toBe(0);
    } finally {
      await isolated.backend.close();
    }
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
        key: entries[0]?.claim.key ?? "",
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
        key: entries[0]?.claim.key ?? "",
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
        key: entries[0]?.claim.key ?? "",
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
        key: entries[0]?.claim.key ?? "",
      }),
    ).resolves.toBeUndefined();
  });
});
