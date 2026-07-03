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

import { createStoreWithSchema, defineGraph, defineNode } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { ConfigurationError } from "../src/errors";
import { defineNodeIndex } from "../src/indexes";
import { generateIndexDDL } from "../src/indexes/ddl";
import { serializeSchema } from "../src/schema/serializer";

const Document = defineNode("Doc", {
  schema: z.object({
    title: z.string(),
    tags: z.array(z.string()),
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
    expect(Object.keys(btree!)).not.toContain("method");
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

  it("rejects bulkFindByIndex probes against a gin index", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const ginIndex = defineNodeIndex(Document, {
        fields: ["tags"],
        method: "gin",
        name: "doc_tags_gin_probe",
      });
      const graph = defineGraph({
        id: "gin-bulk-probe",
        nodes: { Doc: { type: Document } },
        edges: {},
        indexes: [ginIndex],
      });
      const [store] = await createStoreWithSchema(graph, backend);

      await expect(
        store.nodes.Doc.bulkFindByIndex("doc_tags_gin_probe", [
          { tags: ["x"] },
        ] as never),
      ).rejects.toThrow(ConfigurationError);
    } finally {
      await backend.close();
    }
  });
});
