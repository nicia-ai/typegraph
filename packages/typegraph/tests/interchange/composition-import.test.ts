/**
 * Validating import and the composition claim (item E).
 *
 * `importEdgeInsertWork` (`src/interchange/import.ts`) is the ONE owner of an
 * imported edge's insert unit, and it now calls `edgeInsertClaims` — the same
 * function every store write calls — instead of `edgeCardinalityClaims`
 * directly. This pins that a batch binding one part to two wholes surfaces
 * the SAME `CompositionError` a store write does, per row, without aborting
 * the rest of the slice: import's existing catch-per-row recovery (each row
 * commits inside its own savepoint) is untouched by adding a second claim to
 * the row's insert unit.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CompositionError,
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../src";
import { generateSqliteDDL } from "../../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../../src/backend/drizzle/sqlite";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import type { GraphBackend } from "../../src/backend/types";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../../src/interchange";

const CiChapter = defineNode("CiChapter", { schema: z.object({}) });
const CiBook = defineNode("CiBook", { schema: z.object({}) });
const CiAnthology = defineNode("CiAnthology", { schema: z.object({}) });

const ciChapterOf = defineEdge("ciChapterOf", { schema: z.object({}) });
const ciIncludedIn = defineEdge("ciIncludedIn", { schema: z.object({}) });

function buildGraph() {
  return defineGraph({
    id: "composition-import",
    nodes: {
      CiChapter: { type: CiChapter },
      CiBook: { type: CiBook },
      CiAnthology: { type: CiAnthology },
    },
    edges: {
      ciChapterOf: {
        type: ciChapterOf,
        from: [CiChapter],
        to: [CiBook],
        cardinality: "one",
      },
      ciIncludedIn: {
        type: ciIncludedIn,
        from: [CiChapter],
        to: [CiAnthology],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(CiChapter, CiBook, { via: ciChapterOf }),
      partOf(CiChapter, CiAnthology, { via: ciIncludedIn }),
    ],
  });
}

function payload(edges: GraphData["edges"]): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "composition-import test" },
    nodes: [],
    edges,
  };
}

describe("validating import: composition claim", () => {
  it("refuses the second edge binding one part to a second whole, committing the first (catch-per-row)", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(buildGraph(), backend);
      const chapter = await store.nodes.CiChapter.create({});
      const book = await store.nodes.CiBook.create({});
      const anthology = await store.nodes.CiAnthology.create({});

      const result = await importGraph(
        store,
        payload([
          {
            kind: "ciChapterOf",
            id: "e-chapter-of",
            from: { kind: "CiChapter", id: chapter.id },
            to: { kind: "CiBook", id: book.id },
            properties: {},
          },
          {
            kind: "ciIncludedIn",
            id: "e-included-in",
            from: { kind: "CiChapter", id: chapter.id },
            to: { kind: "CiAnthology", id: anthology.id },
            properties: {},
          },
        ]),
        { onConflict: "error", batchSize: 100 },
      );

      // The first row commits...
      expect(result.edges.created).toBe(1);
      expect(await store.edges.ciChapterOf.findFrom(chapter)).toHaveLength(1);
      // ...the second is refused per-row, not as a whole-batch abort.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.id).toBe("e-included-in");
      expect(result.errors[0]?.error).toMatch(/already has a whole/u);
      expect(await store.edges.ciIncludedIn.findFrom(chapter)).toHaveLength(0);
    } finally {
      await backend.close();
    }
  });
  // MUTATION CHECK: revert `importEdgeInsertWork`
  // (src/interchange/import.ts) to call `edgeCardinalityClaims` directly
  // instead of `edgeInsertClaims`. Both rows then satisfy their own,
  // independent cardinality axis (one edge per kind per chapter) and
  // `result.errors` is empty — the second `expect` above fails.

  it("refuses through the store the same way a validating import row does (same typed error)", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(buildGraph(), backend);
      const chapter = await store.nodes.CiChapter.create({});
      const book = await store.nodes.CiBook.create({});
      const anthology = await store.nodes.CiAnthology.create({});
      await store.edges.ciChapterOf.create(chapter, book, {});

      await expect(
        store.edges.ciIncludedIn.create(chapter, anthology, {}),
      ).rejects.toBeInstanceOf(CompositionError);
    } finally {
      await backend.close();
    }
  });
  // Companion to the import case above — proves a store write and a
  // validating-import row refuse with the SAME typed error rather than two
  // independent spellings of "the part already has a whole".

  it("refuses the whole import up front on a backend with no transactions, naming edgeComposition (E7)", async () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite);
      for (const statement of generateSqliteDDL()) sqlite.exec(statement);
      const backend: GraphBackend = createSqliteBackend(db, {
        executionProfile: { transactionMode: "none", isSync: true },
      });
      const store = createStore(buildGraph(), backend);

      // `graphOwesClaims` (src/store/constraints.ts) is asked directly here
      // — this graph declares no OTHER constrained edge kind, so a fold that
      // never reaches the composition arm would find nothing to refuse on
      // and let the import proceed unfenced.
      await expect(
        importGraph(
          store,
          payload([
            {
              kind: "ciChapterOf",
              id: "e-chapter-of",
              from: { kind: "CiChapter", id: "c1" },
              to: { kind: "CiBook", id: "b1" },
              properties: {},
            },
          ]),
          { onConflict: "error", batchSize: 100 },
        ),
      ).rejects.toMatchObject({
        details: {
          code: "CONSTRAINT_WRITE_FENCE_UNSUPPORTED",
          constraint: "edgeComposition",
        },
      });
    } finally {
      sqlite.close();
    }
  });
  // MUTATION CHECK: revert `graphOwesClaims`'s edge loop
  // (src/store/constraints.ts) to its pre-fix inline
  // `edgeCardinalityAxisReferences(registration).length > 0 ->
  // "edgeCardinality"` spelling. This graph's edge kinds are composition-only
  // (no plain `cardinality`/`targetCardinality` outside what composition
  // itself requires), so the reported `constraint` becomes `"edgeCardinality"`
  // instead of `"edgeComposition"` and the `toMatchObject` assertion above
  // fails (verified, reverted).
});
