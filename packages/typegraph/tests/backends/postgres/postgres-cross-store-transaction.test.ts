/**
 * #134: cross-store atomicity on PostgreSQL — a TypeGraph store and a
 * caller-owned node-postgres Drizzle connection sharing ONE Postgres
 * transaction via `store.withTransaction(externalTx)`.
 *
 * This is the canonical Direction-A shape from the issue: the caller
 * owns `db.transaction(async (sqlTx) => …)`, writes a relational row,
 * then enlists a TypeGraph node on the *same* connection. SQLite mirror
 * at `tests/cross-store-transaction.test.ts`.
 *
 * Skipped unless `POSTGRES_URL` is set (or `scripts/test-postgres.sh`).
 */
import { getTableName } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createAdapterStore,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
  StoreNotInitializedError,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import type { AnyPgTransaction } from "../../../src/backend/drizzle/execution";
import {
  createPostgresBackend,
  tables as defaultTables,
} from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

let pool: Pool | undefined;
let db: NodePgDatabase | undefined;
let postgresAvailable = false;

// The caller's own relational table (Drizzle-owned, NOT a TypeGraph
// table). Distinct name so this suite does not collide with others
// sharing the test database.
const connectors = pgTable("cross_store_connectors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

const ArtifactSource = defineNode("ArtifactSource", {
  schema: z.object({
    connectorId: z.number().int(),
    label: z.string(),
  }),
});

const PlainGraph = defineGraph({
  id: "pg_cross_store_plain",
  nodes: { ArtifactSource: { type: ArtifactSource } },
  edges: {},
});

const Document = defineNode("Doc", {
  schema: z.object({
    connectorId: z.number().int(),
    title: searchable({ language: "english" }),
  }),
});

const FtGraph = defineGraph({
  id: "pg_cross_store_fulltext",
  nodes: { Doc: { type: Document } },
  edges: {},
});

const CONTRIB_MAT_TABLE = getTableName(
  defaultTables.contributionMaterializations,
);

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  try {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query("SELECT 1");
    await pool.query(generatePostgresMigrationSQL());
    await pool.query(
      `CREATE TABLE IF NOT EXISTS cross_store_connectors (
         id SERIAL PRIMARY KEY, name TEXT NOT NULL)`,
    );
    db = drizzle(pool);
    postgresAvailable = true;
  } catch {
    postgresAvailable = false;
  }
});

afterAll(async () => {
  if (pool && postgresAvailable) {
    await pool.query(generatePostgresMigrationSQL());
  }
  if (pool) await pool.end();
});

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL cross-store atomicity (#134)",
  () => {
    beforeEach(async () => {
      if (!postgresAvailable || !pool) return;
      await pool.query("TRUNCATE cross_store_connectors RESTART IDENTITY");
      await pool.query(
        `TRUNCATE typegraph_nodes, typegraph_edges,
                  typegraph_node_uniques, typegraph_node_fulltext,
                  typegraph_schema_versions CASCADE`,
      );
      await pool.query(`DELETE FROM ${CONTRIB_MAT_TABLE} WHERE graph_id = $1`, [
        FtGraph.id,
      ]);
    });

    it("commits a relational row and a graph node in one transaction", async () => {
      const backend = createPostgresBackend(requireDefined(db));
      const store = createAdapterStore(PlainGraph, backend);

      const sourceId = await requireDefined(db).transaction(async (sqlTx) => {
        const insertedConnectors = await sqlTx
          .insert(connectors)
          .values({ name: "github" })
          .returning({ id: connectors.id });
        const connectorId = requireDefined(insertedConnectors[0]).id;
        const txStore = store.withTransaction(sqlTx);
        const source = await txStore.nodes.ArtifactSource.create({
          connectorId,
          label: "primary",
        });
        return source.id;
      });

      const rows = await requireDefined(db).select().from(connectors);
      expect(rows).toEqual([{ id: 1, name: "github" }]);
      const fetched = await store.nodes.ArtifactSource.getById(sourceId);
      expect(fetched?.connectorId).toBe(1);
    });

    it("rolls back BOTH layers when the caller's transaction throws", async () => {
      const backend = createPostgresBackend(requireDefined(db));
      const store = createAdapterStore(PlainGraph, backend);

      await expect(
        requireDefined(db).transaction(async (sqlTx) => {
          await sqlTx.insert(connectors).values({ name: "orphan" });
          const txStore = store.withTransaction(sqlTx);
          await txStore.nodes.ArtifactSource.create({
            connectorId: 999,
            label: "doomed",
          });
          throw new Error("business failure after both writes");
        }),
      ).rejects.toThrow("business failure after both writes");

      expect(await requireDefined(db).select().from(connectors)).toEqual([]);
      expect(await store.nodes.ArtifactSource.find()).toEqual([]);
    });

    it("commits a fulltext write with a relational row when the store is booted", async () => {
      const [store] = await createAdapterStoreWithSchema(
        FtGraph,
        createPostgresBackend(requireDefined(db)),
      );

      const documentId = await requireDefined(db).transaction(async (sqlTx) => {
        const insertedConnectors = await sqlTx
          .insert(connectors)
          .values({ name: "drive" })
          .returning({ id: connectors.id });
        const connectorId = requireDefined(insertedConnectors[0]).id;
        const txStore = store.withTransaction(sqlTx);
        const document = await txStore.nodes.Doc.create({
          connectorId,
          title: "quarterly revenue report",
        });
        return document.id;
      });

      expect(await requireDefined(db).select().from(connectors)).toHaveLength(
        1,
      );
      const hits = await store.search.fulltext("Doc", {
        query: "revenue",
        limit: 10,
      });
      expect(hits.map((hit) => hit.node.id)).toEqual([documentId]);
    });

    it("refuses loudly (and rolls back the relational write) when the store is not booted", async () => {
      // Strategy-owned fulltext table dropped + no durable marker: the
      // exact uninitialized state the gate must refuse on.
      await requireDefined(pool).query(
        `DROP TABLE IF EXISTS ${defaultTables.fulltextTableName}`,
      );
      const backend = createPostgresBackend(requireDefined(db));
      const store = createAdapterStore(FtGraph, backend);

      await expect(
        requireDefined(db).transaction(async (sqlTx) => {
          await sqlTx.insert(connectors).values({ name: "premature" });
          const txStore = store.withTransaction(sqlTx);
          await txStore.nodes.Doc.create({
            connectorId: 1,
            title: "should not persist",
          });
        }),
      ).rejects.toBeInstanceOf(StoreNotInitializedError);

      // The caller's relational write rolled back with the refusal.
      expect(await requireDefined(db).select().from(connectors)).toEqual([]);
      // Restore the shared fulltext table for downstream suites.
      await requireDefined(pool).query(generatePostgresMigrationSQL());
    });

    it("exposes adoptTransaction with transactions capability", () => {
      const backend = createPostgresBackend(requireDefined(db));
      expect(backend.capabilities.transactions).toBe(true);
      expect(backend.adoptTransaction).toBeTypeOf("function");
    });

    it("rejects a root database passed as an adopted transaction", () => {
      const backend = createPostgresBackend(requireDefined(db));

      expect(() =>
        backend.adoptTransaction(
          requireDefined(db) as unknown as AnyPgTransaction,
        ),
      ).toThrow(ConfigurationError);
      expect(() =>
        backend.adoptTransaction(
          requireDefined(db) as unknown as AnyPgTransaction,
        ),
      ).toThrow(/not a Postgres Drizzle transaction/);
    });

    it("rejects withTransaction when the backend cannot adopt a transaction", () => {
      // A backend whose driver reports no transaction support must not
      // silently degrade — the relational write would still commit.
      const backend = createPostgresBackend(requireDefined(db), {
        capabilities: { transactions: false },
      });
      const store = createAdapterStore(PlainGraph, backend);
      const rootDatabaseAsTransaction = requireDefined(
        db,
      ) as unknown as AnyPgTransaction;
      expect(() => store.withTransaction(rootDatabaseAsTransaction)).toThrow(
        ConfigurationError,
      );
      expect(() => store.withTransaction(rootDatabaseAsTransaction)).toThrow(
        /Cross-store atomicity is unavailable/,
      );
    });

    // #140 — graph-owned: TypeGraph opens the tx, `tx.sql` is
    // the bound pg transaction handle. Using the outer `db` instead
    // would write on a different connection and escape the tx, so
    // `tx.sql` is a correctness requirement here.
    it("commits a graph node and a tx.sql relational row in one store.transaction", async () => {
      const backend = createPostgresBackend(requireDefined(db));
      const store = createAdapterStore(PlainGraph, backend);

      const source = await store.transaction(async (tx) => {
        const sqlTx = requireDefined(tx.sql);
        const inserted = await sqlTx
          .insert(connectors)
          .values({ name: "github" })
          .returning({ id: connectors.id });
        return tx.nodes.ArtifactSource.create({
          connectorId: requireDefined(inserted[0]).id,
          label: "primary",
        });
      });

      expect(await requireDefined(db).select().from(connectors)).toEqual([
        { id: 1, name: "github" },
      ]);
      const fetched = await store.nodes.ArtifactSource.getById(source.id);
      expect(fetched?.connectorId).toBe(1);
    });

    it("rolls back BOTH the graph node and the tx.sql relational row when the callback throws", async () => {
      const backend = createPostgresBackend(requireDefined(db));
      const store = createAdapterStore(PlainGraph, backend);

      await expect(
        store.transaction(async (tx) => {
          const sqlTx = requireDefined(tx.sql);
          await sqlTx.insert(connectors).values({ name: "orphan" });
          await tx.nodes.ArtifactSource.create({
            connectorId: 999,
            label: "doomed",
          });
          throw new Error("phase2-pg-rollback");
        }),
      ).rejects.toThrow("phase2-pg-rollback");

      expect(await requireDefined(db).select().from(connectors)).toEqual([]);
      expect(await store.nodes.ArtifactSource.find()).toEqual([]);
    });
  },
);
