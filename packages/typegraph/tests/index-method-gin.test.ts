/**
 * GIN-family index methods (`method: "gin" | "trigram"`).
 *
 * These are PostgreSQL expression GINs serving the predicate shapes a
 * btree can never serve — array containment (`jsonb_path_ops`) and
 * substring / case-insensitive matches (`gin_trgm_ops`). This file covers
 * the engine-independent surface: declaration validation and
 * canonicalization, generated DDL (which must reuse the dialect's own
 * extraction expressions so Postgres matches them structurally against
 * compiled predicates), serialization, the SQLite `skipped` contract, and
 * the bulkFindByIndex guard. Postgres materialization and behavior live
 * in `tests/backends/postgres/materialize-indexes.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { ConfigurationError } from "../src/errors";
import { defineEdgeIndex, defineNodeIndex } from "../src/indexes";
import { generateIndexDDL } from "../src/indexes/ddl";
import { serializeSchema } from "../src/schema/serializer";
import { requireDefined } from "../src/utils/presence";

const Document = defineNode("Doc", {
  schema: z.object({
    title: z.string(),
    tags: z.array(z.string()),
    views: z.number(),
    attributes: z.object({ source: z.string() }),
  }),
});

describe("defineNodeIndex method validation", () => {
  it("canonicalizes btree (explicit or default) to an absent method", () => {
    const explicit = defineNodeIndex(Document, {
      fields: ["title"],
      method: "btree",
    });
    const implicit = defineNodeIndex(Document, { fields: ["title"] });

    expect(explicit.method).toBeUndefined();
    expect(implicit.method).toBeUndefined();
    expect(Object.keys(explicit)).not.toContain("method");
  });

  it("carries gin/trigram onto the declaration with a method name suffix", () => {
    const gin = defineNodeIndex(Document, { fields: ["tags"], method: "gin" });
    const trigram = defineNodeIndex(Document, {
      fields: ["title"],
      method: "trigram",
    });

    expect(gin.method).toBe("gin");
    expect(gin.name.endsWith("_gin")).toBe(true);
    expect(trigram.method).toBe("trigram");
    expect(trigram.name.endsWith("_trigram")).toBe(true);
  });

  it("enforces the field-type contract each method advertises", () => {
    // gin serves array containment; trigram serves string substring
    // matching. Any other field type would materialize an index no
    // documented predicate can use.
    expect(() =>
      defineNodeIndex(Document, { fields: ["title"], method: "gin" }),
    ).toThrow(/use method: "trigram"/);
    expect(() =>
      defineNodeIndex(Document, { fields: ["attributes"], method: "gin" }),
    ).toThrow(/requires an array field/);
    expect(() =>
      defineNodeIndex(Document, { fields: ["views"], method: "trigram" }),
    ).toThrow(/requires a string field/);
    expect(() =>
      defineNodeIndex(Document, { fields: ["tags"], method: "trigram" }),
    ).toThrow(/use method: "gin"/);
  });

  it("rejects multi-field, covering, unique, and partial variants", () => {
    expect(() =>
      defineNodeIndex(Document, { fields: ["title", "tags"], method: "gin" }),
    ).toThrow(/exactly one field/);
    expect(() =>
      defineNodeIndex(Document, {
        fields: ["tags"],
        coveringFields: ["title"],
        method: "gin",
      }),
    ).toThrow(/coveringFields/);
    expect(() =>
      defineNodeIndex(Document, {
        fields: ["title"],
        unique: true,
        method: "trigram",
      }),
    ).toThrow(/unique/);
    expect(() =>
      defineNodeIndex(Document, {
        fields: ["title"],
        method: "trigram",
        where: (row) => row.title.isNotNull(),
      }),
    ).toThrow(/where/);
  });
});

describe("GIN-family index DDL", () => {
  const gin = defineNodeIndex(Document, {
    fields: ["tags"],
    method: "gin",
    name: "doc_tags_gin",
  });
  const trigram = defineNodeIndex(Document, {
    fields: ["title"],
    method: "trigram",
    name: "doc_title_trgm",
  });

  it("emits a jsonb_path_ops expression GIN aligned with dialect.jsonExtract", () => {
    expect(generateIndexDDL(gin, "postgres")).toBe(
      `CREATE INDEX IF NOT EXISTS "doc_tags_gin" ON "typegraph_nodes" USING GIN (("props" #> ARRAY['tags']) jsonb_path_ops);`,
    );
  });

  it("emits a gin_trgm_ops expression GIN aligned with dialect.jsonExtractText", () => {
    expect(generateIndexDDL(trigram, "postgres")).toBe(
      `CREATE INDEX IF NOT EXISTS "doc_title_trgm" ON "typegraph_nodes" USING GIN (("props" #>> ARRAY['title']) gin_trgm_ops);`,
    );
  });

  it("supports CONCURRENTLY for the materialize path", () => {
    expect(generateIndexDDL(gin, "postgres", { concurrent: true })).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS",
    );
  });

  it("refuses to generate SQLite DDL", () => {
    expect(() => generateIndexDDL(gin, "sqlite")).toThrow(
      /requires PostgreSQL/,
    );
  });
});

describe("serialization", () => {
  it("emits method only when present", () => {
    const graph = defineGraph({
      id: "gin-serialize",
      nodes: { Doc: { type: Document } },
      edges: {},
      indexes: [
        defineNodeIndex(Document, { fields: ["title"] }),
        defineNodeIndex(Document, { fields: ["tags"], method: "gin" }),
      ],
    });

    const serialized = serializeSchema(graph, 1);
    const indexes = serialized.indexes ?? [];
    const byMethod = new Map(
      indexes.map((declaration) => [
        "method" in declaration ? declaration.method : undefined,
        declaration,
      ]),
    );

    expect(byMethod.has("gin")).toBe(true);
    // The btree declaration must not carry a `method` key at all, so
    // pre-existing stored schema docs and materialization signatures stay
    // byte-identical.
    const btree = indexes.find((declaration) => !("method" in declaration));
    expect(btree).toBeDefined();
    expect(Object.keys(requireDefined(btree))).not.toContain("method");
  });
});

describe("SQLite behavior", () => {
  it("materializes gin/trigram declarations as skipped with a reason", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = defineGraph({
        id: "gin-sqlite-skip",
        nodes: { Doc: { type: Document } },
        edges: {},
        indexes: [
          defineNodeIndex(Document, { fields: ["tags"], method: "gin" }),
          defineNodeIndex(Document, { fields: ["title"], method: "trigram" }),
          defineNodeIndex(Document, { fields: ["title"] }),
        ],
      });
      const [store] = await createStoreWithSchema(graph, backend);

      const result = await store.materializeIndexes();
      const byStatus = new Map(
        result.results.map((entry) => [entry.indexName, entry]),
      );

      const statuses = result.results.map((entry) => entry.status);
      expect(statuses.filter((status) => status === "skipped")).toHaveLength(2);
      expect(statuses.filter((status) => status === "created")).toHaveLength(1);
      const skipped = [...byStatus.values()].find(
        (entry) => entry.status === "skipped",
      );
      expect(skipped?.reason).toMatch(/requires PostgreSQL/);
    } finally {
      await backend.close();
    }
  });

  it("rejects bulkFindByIndex probes against gin and trigram indexes", async () => {
    // bulkFindByIndex compiles equality probes, which a GIN-family index can
    // never serve (it indexes one expression for containment/substring, not
    // ordered key columns). The guard fires in resolveNodeIndex — before any
    // query runs — so it is backend-independent; SQLite just supplies a store.
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = defineGraph({
        id: "gin-bulk-probe",
        nodes: { Doc: { type: Document } },
        edges: {},
        indexes: [
          defineNodeIndex(Document, {
            fields: ["tags"],
            method: "gin",
            name: "doc_tags_gin_probe",
          }),
          defineNodeIndex(Document, {
            fields: ["title"],
            method: "trigram",
            name: "doc_title_trgm_probe",
          }),
        ],
      });
      const [store] = await createStoreWithSchema(graph, backend);

      const ginError = await store.nodes.Doc.bulkFindByIndex(
        "doc_tags_gin_probe",
        [{ props: { tags: ["x"] } }],
      ).catch((error: unknown) => error);
      expectMethodProbeRejection(ginError, "doc_tags_gin_probe", "gin");

      const trigramError = await store.nodes.Doc.bulkFindByIndex(
        "doc_title_trgm_probe",
        [{ props: { title: "x" } }],
      ).catch((error: unknown) => error);
      expectMethodProbeRejection(
        trigramError,
        "doc_title_trgm_probe",
        "trigram",
      );
    } finally {
      await backend.close();
    }
  });
});

/**
 * Asserts the exact ConfigurationError bulkFindByIndex raises when pointed at
 * a GIN-family index: type, code, message, and structured details (the
 * `Document` node in this file is declared with kind `"Doc"`).
 */
function expectMethodProbeRejection(
  error: unknown,
  indexName: string,
  method: string,
): void {
  expect(error).toBeInstanceOf(ConfigurationError);
  const configError = error as ConfigurationError;
  expect(configError.code).toBe("CONFIGURATION_ERROR");
  expect(configError.message).toBe(
    `bulkFindByIndex cannot probe index "${indexName}" (method "${method}"): ` +
      "only btree indexes serve equality probes.",
  );
  expect(configError.details).toEqual({
    indexName,
    kind: "Doc",
    method,
  });
}

describe("defineEdgeIndex GIN-family methods", () => {
  const Tagged = defineEdge("tagged", {
    schema: z.object({
      labels: z.array(z.string()),
      note: z.string(),
    }),
  });

  it("carries gin/trigram onto an edge declaration with a method-name suffix", () => {
    // Exercises the edge `method` wiring: `allowJsonFields: method === "gin"`
    // lets the `labels` array field through the btree-only guard, and the
    // resolved method is stamped onto the declaration with a name suffix.
    const gin = defineEdgeIndex(Tagged, { fields: ["labels"], method: "gin" });
    const trigram = defineEdgeIndex(Tagged, {
      fields: ["note"],
      method: "trigram",
    });

    expect(gin.entity).toBe("edge");
    expect(gin.method).toBe("gin");
    expect(gin.name.endsWith("_gin")).toBe(true);
    expect(trigram.method).toBe("trigram");
    expect(trigram.name.endsWith("_trigram")).toBe(true);
  });

  it("enforces the field-type contract each method advertises on edges", () => {
    expect(() =>
      defineEdgeIndex(Tagged, { fields: ["note"], method: "gin" }),
    ).toThrow(/use method: "trigram"/);
    expect(() =>
      defineEdgeIndex(Tagged, { fields: ["labels"], method: "trigram" }),
    ).toThrow(/use method: "gin"/);
  });

  it("emits an expression GIN on typegraph_edges aligned with the dialect extraction", () => {
    const gin = defineEdgeIndex(Tagged, {
      fields: ["labels"],
      method: "gin",
      name: "tagged_labels_gin",
    });
    expect(generateIndexDDL(gin, "postgres")).toBe(
      `CREATE INDEX IF NOT EXISTS "tagged_labels_gin" ON "typegraph_edges" USING GIN (("props" #> ARRAY['labels']) jsonb_path_ops);`,
    );

    const trigram = defineEdgeIndex(Tagged, {
      fields: ["note"],
      method: "trigram",
      name: "tagged_note_trgm",
    });
    expect(generateIndexDDL(trigram, "postgres")).toBe(
      `CREATE INDEX IF NOT EXISTS "tagged_note_trgm" ON "typegraph_edges" USING GIN (("props" #>> ARRAY['note']) gin_trgm_ops);`,
    );
  });

  it("refuses to generate SQLite DDL for an edge gin index", () => {
    const gin = defineEdgeIndex(Tagged, {
      fields: ["labels"],
      method: "gin",
      name: "tagged_labels_gin",
    });
    expect(() => generateIndexDDL(gin, "sqlite")).toThrow(
      /requires PostgreSQL/,
    );
  });

  it("materializes edge gin/trigram declarations as skipped on SQLite", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const Item = defineNode("Item", {
        schema: z.object({ label: z.string() }),
      });
      const graph = defineGraph({
        id: "edge-gin-sqlite-skip",
        nodes: { Item: { type: Item } },
        edges: {
          tagged: {
            type: Tagged,
            from: [Item],
            to: [Item],
            cardinality: "many",
          },
        },
        indexes: [
          defineEdgeIndex(Tagged, { fields: ["labels"], method: "gin" }),
          defineEdgeIndex(Tagged, { fields: ["note"], method: "trigram" }),
        ],
      });
      const [store] = await createStoreWithSchema(graph, backend);

      const result = await store.materializeIndexes();

      expect(result.results).toHaveLength(2);
      for (const entry of result.results) {
        expect(entry.entity).toBe("edge");
        expect(entry.status).toBe("skipped");
        expect(entry.reason).toMatch(/requires PostgreSQL/);
      }
    } finally {
      await backend.close();
    }
  });
});
