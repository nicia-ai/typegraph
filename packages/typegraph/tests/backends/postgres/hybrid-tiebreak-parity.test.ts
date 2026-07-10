/**
 * Collation-independent node_id tiebreaks in hybrid search.
 *
 * `buildHybridSearchStatement` forces `node_id COLLATE "C"` on Postgres so the
 * single-statement path breaks tied fused scores — and the per-source
 * `ROW_NUMBER()` ranks that produce them — by byte order, the same order
 * SQLite's BINARY collation and the store's JS fusion fallback
 * (`compareCodePoints`) use. Left bare, a linguistic default collation like
 * `en_US.utf8` sorts `a < A < b < B`, diverging from every other path.
 *
 * The corpus below is adversarial: four nodes with IDENTICAL title text and an
 * IDENTICAL embedding vector, whose ids differ only by letter case
 * ("A", "B", "a", "b"). Every score ties, so the ranking is decided entirely
 * by the node_id tiebreak — the exact seam the fix touches.
 *
 * Skipped unless `POSTGRES_URL` is set, and skipped (never silently passed) on
 * a `C`/`POSIX`-collated database, where the fix and its absence are
 * indistinguishable.
 */
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { type GraphBackend } from "../../../src/backend/types";
import { embedding } from "../../../src/core/embedding";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

const EMBEDDING_DIMENSIONS = 3;
const TIED_EMBEDDING: readonly number[] = [1, 0, 0];
const TIED_TITLE = "signal";
// Ids that differ only by letter case: `C`/byte order is A < B < a < b; a
// linguistic collation (en_US) is a < A < b < B.
const NODE_IDS = ["A", "B", "a", "b"] as const;

const TiebreakItem = defineNode("TiebreakItem", {
  schema: z.object({
    title: searchable({ language: "english" }),
    embedding: embedding(EMBEDDING_DIMENSIONS),
  }),
});

const TiebreakGraph = defineGraph({
  id: "pg_hybrid_tiebreak",
  nodes: { TiebreakItem: { type: TiebreakItem } },
  edges: {},
});

const HYBRID_OPTIONS = {
  vector: { fieldPath: "embedding", queryEmbedding: TIED_EMBEDDING },
  fulltext: { query: TIED_TITLE },
  limit: 2,
} as const;

let pool: Pool | undefined;
let postgresAvailable = false;
let observedCollation: string | undefined;
let collationIsC = false;

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) return;
  try {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query("SELECT 1");
    await pool.query(generatePostgresMigrationSQL());
    const collation = await pool.query<{
      datcollate: string;
      datlocprovider: string;
    }>(
      "SELECT datcollate, datlocprovider FROM pg_database WHERE datname = current_database()",
    );
    observedCollation = collation.rows[0]?.datcollate;
    // A `C`/`POSIX` default already orders by byte order, so the forced-`C`
    // path and the database default would agree and the test could not
    // distinguish the fix from its absence.
    collationIsC = observedCollation === "C" || observedCollation === "POSIX";
    postgresAvailable = true;
  } catch {
    postgresAvailable = false;
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

async function seedTiedCorpus(backend: GraphBackend) {
  const [store] = await createStoreWithSchema(TiebreakGraph, backend);
  // Identical title AND identical embedding for every node: both search legs
  // tie on score for all four, so each per-source ROW_NUMBER() rank — and thus
  // every fused score — is decided purely by the node_id tiebreak.
  for (const id of NODE_IDS) {
    await store.nodes.TiebreakItem.create(
      { title: TIED_TITLE, embedding: [...TIED_EMBEDDING] },
      { id },
    );
  }
  return store;
}

describe.runIf(process.env.POSTGRES_URL)(
  'PostgreSQL hybrid node_id tiebreak (COLLATE "C")',
  () => {
    beforeEach(async () => {
      if (!postgresAvailable || !pool) return;
      await pool.query(
        `TRUNCATE typegraph_nodes, typegraph_edges, typegraph_node_uniques,
                  typegraph_node_fulltext, typegraph_schema_versions CASCADE`,
      );
      // Drop the per-(kind,field) pgvector tables so each run rebuilds them.
      const perField = await pool.query<{ tablename: string }>(
        String.raw`SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
      );
      for (const { tablename } of perField.rows) {
        await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
      }
    });

    it("both paths sort tied node_ids by code point, not the DB default collation", async (ctx) => {
      if (!postgresAvailable || !pool) {
        ctx.skip();
        return;
      }
      if (collationIsC) {
        // Not a silent pass: announce why the discriminating case is absent.
        console.warn(
          `[hybrid-tiebreak-parity] skipped: database default collation is ` +
            `"${observedCollation}" (byte order). This test needs a linguistic ` +
            `default (e.g. en_US.utf8) to distinguish COLLATE "C" from it.`,
        );
        ctx.skip();
        return;
      }

      const backend = createPostgresBackend(drizzleNodePostgres(pool));
      const store = await seedTiedCorpus(backend);

      // Fast path: backend.hybridSearch composes both legs, RRF fusion, and
      // hydration into the single COLLATE "C" statement.
      const native = await store.search.hybrid("TiebreakItem", HYBRID_OPTIONS);
      const nativeIds = native.map((hit) => hit.node.id);

      // Fallback path: hide backend.hybridSearch so the store runs the two
      // standalone searches and fuses their ranks in JS (multi-statement path).
      const fallbackBackend = new Proxy(backend, {
        get(target, property, receiver) {
          if (property === "hybridSearch") return;
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      const [fallbackStore] = await createStoreWithSchema(
        TiebreakGraph,
        fallbackBackend,
      );
      const fallback = await fallbackStore.search.hybrid(
        "TiebreakItem",
        HYBRID_OPTIONS,
      );
      const fallbackIds = fallback.map((hit) => hit.node.id);

      // Every tiebreak in the single-statement path renders
      // `node_id COLLATE "C"`, so the all-tied page ranks in code-point order
      // A < B < a < b and returns ["A", "B"] — matching SQLite's BINARY
      // collation. Without COLLATE "C" this database's en_US.utf8 default
      // (a < A < b < B) makes the same statement return ["a", "A"].
      expect(nativeIds).toEqual(["A", "B"]);

      // And the fallback agrees. Two things get it here, and both are load
      // bearing: the standalone fulltext search's ORDER BY is C-collated too,
      // and the store re-ranks each leg's rows with `compareCodePoints` before
      // assigning ranks rather than trusting the source SQL's arrival order —
      // the vector source breaks a distance tie arbitrarily, so its order is
      // no basis for a rank. Ranks decide the fused scores, so a divergence
      // here would survive the final tiebreak entirely.
      expect(fallbackIds).toEqual(["A", "B"]);
      expect(fallbackIds).toEqual(nativeIds);

      // Parity is not just the page: the sub-result ranks agree too.
      expect(fallback.map((hit) => hit.vector?.rank)).toEqual(
        native.map((hit) => hit.vector?.rank),
      );
      expect(fallback.map((hit) => hit.fulltext?.rank)).toEqual(
        native.map((hit) => hit.fulltext?.rank),
      );
    });
  },
);
