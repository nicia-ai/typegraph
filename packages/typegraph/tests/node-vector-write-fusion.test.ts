import { PGlite } from "@electric-sql/pglite";
import { vector as pgvectorExtension } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, embedding, searchable } from "../src";
import { markBundledRootAutocommitEligible } from "../src/backend/capabilities/autocommit-single-statement";
import { generatePostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { createSqliteBackend } from "../src/backend/sqlite";
import {
  ContributionUnavailableError,
  EmbeddingDimensionChangedError,
} from "../src/errors";
import { createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";
import { createTestDatabase } from "./test-utils";

const SingleVectorDocument = defineNode("SingleVectorDocument", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(3),
  }),
});

const MultiVectorDocument = defineNode("MultiVectorDocument", {
  schema: z.object({
    title: z.string(),
    titleEmbedding: embedding(3),
    bodyEmbedding: embedding(2),
  }),
});

const OptionalVectorDocument = defineNode("OptionalVectorDocument", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(3).optional(),
  }),
});

const SearchableVectorDocument = defineNode("SearchableVectorDocument", {
  schema: z.object({
    title: searchable(),
    embedding: embedding(3),
  }),
});

const SearchableMultiVectorDocument = defineNode(
  "SearchableMultiVectorDocument",
  {
    schema: z.object({
      title: searchable(),
      titleEmbedding: embedding(3),
      bodyEmbedding: embedding(2),
    }),
  },
);

const singleGraph = defineGraph({
  id: "node_vector_single",
  nodes: { SingleVectorDocument: { type: SingleVectorDocument } },
  edges: {},
});

const multiGraph = defineGraph({
  id: "node_vector_multi",
  nodes: { MultiVectorDocument: { type: MultiVectorDocument } },
  edges: {},
});

const optionalGraph = defineGraph({
  id: "node_vector_optional",
  nodes: { OptionalVectorDocument: { type: OptionalVectorDocument } },
  edges: {},
});

const searchableGraph = defineGraph({
  id: "node_vector_searchable",
  nodes: { SearchableVectorDocument: { type: SearchableVectorDocument } },
  edges: {},
});

const searchableMultiGraph = defineGraph({
  id: "node_vector_searchable_multi",
  nodes: {
    SearchableMultiVectorDocument: { type: SearchableMultiVectorDocument },
  },
  edges: {},
});

const callerIdGraph = defineGraph({
  id: "node_vector_caller_id",
  nodes: { SingleVectorDocument: { type: SingleVectorDocument } },
  edges: {},
});

const sqliteGraph = defineGraph({
  id: "node_vector_sqlite",
  nodes: { SingleVectorDocument: { type: SingleVectorDocument } },
  edges: {},
});

type RecordedVectorPostgres = Readonly<{
  backend: ReturnType<typeof createPostgresBackend>;
  client: PGlite;
  statements: string[];
  reset: () => void;
}>;

const cleanupClients: Readonly<{
  client: PGlite;
  restore: () => void;
}>[] = [];

afterEach(async () => {
  const clients = cleanupClients.splice(0);
  for (const { client, restore } of clients.toReversed()) {
    restore();
    await client.close();
  }
});

/**
 * The ordinary recorder disables vector support. This fixture deliberately
 * uses the PGlite factory so pgvector is loaded, then records the Drizzle
 * session's SQL just like the existing PostgreSQL statement recorder.
 */
async function createRecordedVectorPostgres(): Promise<RecordedVectorPostgres> {
  const client = await PGlite.create({
    extensions: { vector: pgvectorExtension },
  });
  await client.exec(generatePostgresMigrationSQL());
  const statements: string[] = [];
  const query = client.query.bind(client);
  const querySpy = vi.spyOn(client, "query").mockImplementation((...args) => {
    if (typeof args[0] === "string") statements.push(args[0]);
    return query(...args);
  });
  const backend = markBundledRootAutocommitEligible(
    createPostgresBackend(
      drizzle(client, {
        logger: {
          logQuery(queryText: string): void {
            statements.push(queryText);
          },
        },
      }),
    ),
  );
  cleanupClients.push({
    client,
    restore: () => {
      querySpy.mockRestore();
    },
  });
  return {
    backend,
    client,
    statements,
    reset: () => statements.splice(0),
  };
}

function hasNodeInsert(statement: string): boolean {
  return /insert\s+into\s+"typegraph_nodes"/iu.test(statement);
}

function hasVectorWrite(statement: string): boolean {
  return /(?:insert\s+into|delete\s+from)\s+"tg_vec_/iu.test(statement);
}

function hasFulltextWrite(statement: string): boolean {
  return /(?:insert\s+into|delete\s+from)\s+"typegraph_node_fulltext"/iu.test(
    statement,
  );
}

describe("fresh node + vector write fusion", () => {
  it("maps a missing warmed vector table and leaves no node row", async () => {
    const fixture = await createRecordedVectorPostgres();
    const [store] = await createStoreWithSchema(singleGraph, fixture.backend);
    const strategy = requireDefined(fixture.backend.vectorStrategy);
    const physicalName = strategy.tableName(
      singleGraph.id,
      "SingleVectorDocument",
      "embedding",
    );
    await fixture.client.exec(`DROP TABLE "${physicalName}"`);

    await expect(
      store.nodes.SingleVectorDocument.create({
        title: "missing vector storage",
        embedding: [1, 0, 0],
      }),
    ).rejects.toBeInstanceOf(ContributionUnavailableError);
    await expect(store.nodes.SingleVectorDocument.find()).resolves.toHaveLength(
      0,
    );
  });

  it("maps a missing vector table in a mixed projection and leaves no node row", async () => {
    const fixture = await createRecordedVectorPostgres();
    const [store] = await createStoreWithSchema(
      searchableGraph,
      fixture.backend,
    );
    const strategy = requireDefined(fixture.backend.vectorStrategy);
    const physicalName = strategy.tableName(
      searchableGraph.id,
      "SearchableVectorDocument",
      "embedding",
    );
    await fixture.client.exec(`DROP TABLE "${physicalName}"`);

    await expect(
      store.nodes.SearchableVectorDocument.create({
        title: "mixed missing vector storage",
        embedding: [1, 0, 0],
      }),
    ).rejects.toBeInstanceOf(ContributionUnavailableError);
    await expect(
      store.nodes.SearchableVectorDocument.find(),
    ).resolves.toHaveLength(0);
  });

  it("preserves dimension errors from a malformed vector projection", async () => {
    const fixture = await createRecordedVectorPostgres();
    await createStoreWithSchema(singleGraph, fixture.backend);

    await expect(
      fixture.backend.transaction(async (tx) =>
        requireDefined(tx.insertNodeWithProjections)(
          {
            graphId: singleGraph.id,
            kind: "SingleVectorDocument",
            id: "malformed-vector-node",
            props: { title: "bad vector", embedding: [1, 0] },
          },
          {
            mode: { kind: "ordinary" },
            claims: [],
            projections: [
              {
                kind: "embedding",
                fieldPath: "embedding",
                embedding: [1, 0],
                dimensions: 3,
                metric: "cosine",
                indexType: "hnsw",
              },
            ],
          },
        ),
      ),
    ).rejects.toBeInstanceOf(EmbeddingDimensionChangedError);
    await expect(
      fixture.backend.getNode(
        singleGraph.id,
        "SingleVectorDocument",
        "malformed-vector-node",
      ),
    ).resolves.toBeUndefined();
  });

  it("writes one generated vector node in one root statement", async () => {
    const fixture = await createRecordedVectorPostgres();
    const [store] = await createStoreWithSchema(singleGraph, fixture.backend);
    const transactionSpy = vi.spyOn(fixture.backend, "transaction");

    fixture.reset();
    const node = await store.nodes.SingleVectorDocument.create({
      title: "Neon round trip",
      embedding: [1, 0, 0],
    });

    expect(fixture.statements).toHaveLength(1);
    const statement = fixture.statements[0] ?? "";
    expect(hasNodeInsert(statement)).toBe(true);
    expect(hasVectorWrite(statement)).toBe(true);
    expect(statement).toMatch(/typegraph_schema_versions/iu);
    expect(statement).toMatch(/inserted_node/iu);
    expect(statement).not.toMatch(/\b(?:begin|commit)\b/iu);
    expect(transactionSpy).not.toHaveBeenCalled();
    transactionSpy.mockRestore();

    const hits = await store.search.vector("SingleVectorDocument", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0],
      limit: 10,
    });
    expect(hits.map((hit) => hit.node.id)).toEqual([node.id]);
  });

  it("writes multiple vector fields in the same generated-node statement", async () => {
    const fixture = await createRecordedVectorPostgres();
    const [store] = await createStoreWithSchema(multiGraph, fixture.backend);

    fixture.reset();
    const node = await store.nodes.MultiVectorDocument.create({
      title: "two sidecars",
      titleEmbedding: [1, 0, 0],
      bodyEmbedding: [1, 0],
    });

    expect(fixture.statements).toHaveLength(1);
    const statement = fixture.statements[0] ?? "";
    expect(hasNodeInsert(statement)).toBe(true);
    expect(statement).toMatch(/typegraph_schema_versions/iu);
    expect(statement.match(/insert\s+into\s+"tg_vec_/giu)).toHaveLength(2);

    const titleHits = await store.search.vector("MultiVectorDocument", {
      fieldPath: "titleEmbedding",
      queryEmbedding: [1, 0, 0],
      limit: 10,
    });
    const bodyHits = await store.search.vector("MultiVectorDocument", {
      fieldPath: "bodyEmbedding",
      queryEmbedding: [1, 0],
      limit: 10,
    });
    expect(titleHits.map((hit) => hit.node.id)).toEqual([node.id]);
    expect(bodyHits.map((hit) => hit.node.id)).toEqual([node.id]);
  });

  it("does not create a vector row for an omitted optional embedding", async () => {
    const fixture = await createRecordedVectorPostgres();
    const [store] = await createStoreWithSchema(optionalGraph, fixture.backend);

    fixture.reset();
    const node = await store.nodes.OptionalVectorDocument.create({
      title: "no vector supplied",
    });

    expect(
      await store.search.vector("OptionalVectorDocument", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0],
        limit: 10,
      }),
    ).toHaveLength(0);
    expect(
      await store.nodes.OptionalVectorDocument.getById(node.id),
    ).toBeDefined();
  });

  it("fuses searchable plus vector writes in one projection statement", async () => {
    const fixture = await createRecordedVectorPostgres();
    const [store] = await createStoreWithSchema(
      searchableGraph,
      fixture.backend,
    );

    fixture.reset();
    const node = await store.nodes.SearchableVectorDocument.create({
      title: "searchable vector content",
      embedding: [1, 0, 0],
    });

    expect(fixture.statements).toHaveLength(1);
    const statement = fixture.statements[0] ?? "";
    expect(hasNodeInsert(statement)).toBe(true);
    expect(hasFulltextWrite(statement)).toBe(true);
    expect(hasVectorWrite(statement)).toBe(true);

    const vectorHits = await store.search.vector("SearchableVectorDocument", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0],
      limit: 10,
    });
    const fulltextHits = await store.search.fulltext(
      "SearchableVectorDocument",
      { query: "content", limit: 10 },
    );
    expect(vectorHits.map((hit) => hit.node.id)).toEqual([node.id]);
    expect(fulltextHits.map((hit) => hit.node.id)).toEqual([node.id]);
  });

  it("fuses fulltext and multiple vector sidecars when the backend supports it", async () => {
    const fixture = await createRecordedVectorPostgres();
    const [store] = await createStoreWithSchema(
      searchableMultiGraph,
      fixture.backend,
    );

    fixture.reset();
    const node = await store.nodes.SearchableMultiVectorDocument.create({
      title: searchableMultiGraph.id,
      titleEmbedding: [1, 0, 0],
      bodyEmbedding: [1, 0],
    });

    expect(fixture.statements).toHaveLength(1);
    const statement = fixture.statements[0] ?? "";
    expect(hasNodeInsert(statement)).toBe(true);
    expect(hasFulltextWrite(statement)).toBe(true);
    expect(statement).toMatch(/typegraph_schema_versions/iu);
    expect(statement.match(/insert\s+into\s+"tg_vec_/giu)).toHaveLength(2);

    const titleHits = await store.search.vector(
      "SearchableMultiVectorDocument",
      {
        fieldPath: "titleEmbedding",
        queryEmbedding: [1, 0, 0],
        limit: 10,
      },
    );
    const bodyHits = await store.search.vector(
      "SearchableMultiVectorDocument",
      {
        fieldPath: "bodyEmbedding",
        queryEmbedding: [1, 0],
        limit: 10,
      },
    );
    const fulltextHits = await store.search.fulltext(
      "SearchableMultiVectorDocument",
      { query: searchableMultiGraph.id, limit: 10 },
    );
    expect(titleHits.map((hit) => hit.node.id)).toEqual([node.id]);
    expect(bodyHits.map((hit) => hit.node.id)).toEqual([node.id]);
    expect(fulltextHits.map((hit) => hit.node.id)).toEqual([node.id]);
  });

  it("keeps caller-supplied IDs on the portable node plus vector path", async () => {
    const fixture = await createRecordedVectorPostgres();
    const [store] = await createStoreWithSchema(callerIdGraph, fixture.backend);

    fixture.reset();
    const node = await store.nodes.SingleVectorDocument.create(
      { title: "caller id", embedding: [1, 0, 0] },
      { id: "caller-supplied-vector-node" },
    );

    const entityStatements = fixture.statements.filter(
      (statement) => hasNodeInsert(statement) || hasVectorWrite(statement),
    );
    expect(entityStatements).toHaveLength(2);
    expect(
      entityStatements.some(
        (statement) => hasNodeInsert(statement) && hasVectorWrite(statement),
      ),
    ).toBe(false);
    expect(node.id).toBe("caller-supplied-vector-node");
  });

  it("keeps SQLite on the ordinary path", async () => {
    const database = createTestDatabase();
    const backend = createSqliteBackend(database);
    const [store] = await createStoreWithSchema(sqliteGraph, backend);

    expect(backend.capabilities.vector).toBeUndefined();
    const node = await store.nodes.SingleVectorDocument.create({
      title: "sqlite fallback",
      embedding: [1, 0, 0],
    });
    expect(node.id).toBeDefined();
  });
});
