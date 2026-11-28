/**
 * An unscored full-text match: one whose strategy's rank expression is NULL
 * (a custom strategy that cannot rank every match it admits).
 *
 * The query builder's top-k cut takes such a match after every scored one
 * (`compileRelevanceCandidateOrder`, NULLs last). `store.search.fulltext()`
 * and the full-text leg `store.search.hybrid()` ranks spell their own
 * `rank DESC`, under which PostgreSQL sorts a NULL first, so on PostgreSQL
 * the façades keep the unscored match ahead of a scored one: known defect
 * fix5-fulltext-null-rank, which main has too. A façade result carries a
 * numeric score, which an unscored match does not have, so
 * `store.search.fulltext()` refuses to return one; the builder returns it,
 * last.
 *
 * SQLite sorts a NULL last under `DESC`, so it holds the correct rows.
 */
import { afterEach, describe, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, embedding, searchable } from "../../../src";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import {
  fts5Strategy,
  type FulltextStrategy,
  tsvectorStrategy,
} from "../../../src/query/dialect/fulltext-strategy";
import { sql } from "../../../src/query/sql-fragment";
import { createStoreWithSchema } from "../../../src/store";
import { expectObservation } from "../../helpers/known-defect";

const DEFECT =
  "known defect fix5-fulltext-null-rank (the full-text façades sort a NULL rank first on PostgreSQL)";

const Note = defineNode("Note", {
  schema: z.object({
    title: searchable({ language: "english" }),
    embedding: embedding(2),
  }),
});
const graph = defineGraph({
  id: "fulltext_unscored",
  nodes: { Note: { type: Note } },
  edges: {},
});

/** `base`, except that the match of node `u` has no rank. */
function unrankingU(base: FulltextStrategy): FulltextStrategy {
  return {
    ...base,
    rankExpression: (tableName, query, mode, language) =>
      sql`CASE WHEN ${sql.identifier(tableName)}."node_id" = 'u' THEN NULL ELSE ${base.rankExpression(tableName, query, mode, language)} END`,
  };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function pgliteStore() {
  const { backend } = await createLocalPgliteBackend({
    fulltext: unrankingU(tsvectorStrategy),
  });
  closers.push(() => backend.close());
  const [store] = await createStoreWithSchema(graph, backend);
  return store;
}

async function sqliteStore() {
  const { backend } = createLocalSqliteBackend({
    fulltext: unrankingU(fts5Strategy),
  });
  closers.push(() => backend.close());
  const [store] = await createStoreWithSchema(graph, backend);
  return store;
}

type NoteStore = Awaited<ReturnType<typeof pgliteStore>>;

/** s (scored) and u (unscored) both match "climate"; u is nearer [1, 0]. */
async function seed(store: NoteStore): Promise<void> {
  await store.nodes.Note.create(
    { title: "climate report", embedding: [0.6, 0.8] },
    { id: "s" },
  );
  await store.nodes.Note.create(
    { title: "climate report", embedding: [1, 0] },
    { id: "u" },
  );
}

async function builderIds(store: NoteStore, k: number) {
  const rows = await store
    .query()
    .from("Note", "n")
    .whereNode("n", (n) => n.$fulltext.matches("climate", k))
    .select((row) => ({ id: row.n.id }))
    .execute();
  return rows.map((row) => String(row.id));
}

async function facadeIds(store: NoteStore, limit: number) {
  return store.search.fulltext("Note", { query: "climate", limit }).then(
    (hits) => hits.map((hit) => String(hit.node.id)),
    (error: unknown) =>
      error instanceof TypeError ? `TypeError: ${error.message}` : error,
  );
}

describe("an unscored full-text match", () => {
  for (const [dialect, open] of [
    ["postgres", pgliteStore],
    ["sqlite", sqliteStore],
  ] as const) {
    it(`${dialect}: every top-k cut takes it after every scored match, and store.search.fulltext() refuses to return it`, async () => {
      const store = await open();
      await seed(store);
      const refusal =
        "TypeError: Backend returned non-numeric fulltext score: null";
      const correct = {
        builder: [["s"], ["s", "u"]],
        facade: [["s"], refusal],
      };
      expectObservation({
        lane: { dialect },
        observed: {
          builder: [await builderIds(store, 1), await builderIds(store, 2)],
          facade: [await facadeIds(store, 1), await facadeIds(store, 2)],
        },
        correct,
        defects: [
          {
            label: DEFECT,
            on: { dialect: ["postgres"] },
            today: { ...correct, facade: [refusal, refusal] },
          },
        ],
      });
    });
  }

  it("postgres: store.search.hybrid() ranks it on the full-text leg after every scored match", async () => {
    const store = await pgliteStore();
    await seed(store);
    // u leads the vector leg; s leads the full-text leg once u ranks last
    // there, so the two tie on the fused score and the node id keeps s.
    const hits = await store.search.hybrid("Note", {
      limit: 1,
      vector: { fieldPath: "embedding", queryEmbedding: [1, 0] },
      fulltext: { query: "climate" },
    });
    expectObservation({
      lane: { dialect: "postgres" },
      observed: hits.map((hit) => String(hit.node.id)),
      correct: ["s"],
      defects: [{ label: DEFECT, on: { dialect: ["postgres"] }, today: ["u"] }],
    });
  });
});
