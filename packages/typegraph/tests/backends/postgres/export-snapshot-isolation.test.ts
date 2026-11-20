/**
 * The export snapshot, demonstrated against a concurrent writer on a real
 * PostgreSQL server (#432) — the other half of the pair whose SQLite side is
 * `tests/backends/sqlite/export-snapshot-isolation.test.ts`.
 *
 * Postgres is where the `isolationLevel: "repeatable_read"` half of the
 * export's transaction options is load-bearing. SQLite has no isolation levels:
 * its snapshot comes entirely from framing the read as a deferred `BEGIN`, so
 * mutating `repeatable_read` to `read_committed` cannot change what a SQLite
 * export sees, and only `accessMode` mutations show up there. Here the level is
 * the whole mechanism — under `read committed` each statement would take a
 * fresh snapshot and a mid-stream commit would appear in the export's later
 * pages.
 *
 * The concurrent writer is a SECOND connection pool. That is not incidental: a
 * write through the connection the export's transaction is holding would be
 * serialized behind it rather than race it, and on a single-connection driver
 * it is refused outright by the interchange stream lease. PGlite is exactly
 * that single-connection case and cannot express this test at all, which is why
 * the Postgres half lives in the server lane instead of the PGlite one.
 *
 * Skipped unless `POSTGRES_URL` is set (`pnpm test:postgres`).
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStore,
  defineGraph,
  defineNode,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import {
  exportGraphStream,
  type GraphInterchangeChunk,
  type InterchangeNode,
} from "../../../src/interchange";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "pg_export_snapshot_isolation",
  nodes: { Person: { type: Person } },
  edges: {},
});

/**
 * Ids are exported in `ORDER BY id`, so zero-padding makes "which page is this
 * row on" a property of the test: with `batchSize: 2`, `person-05` is on the
 * third page and is still unread when the concurrent write commits.
 */
const SEEDED_IDS = [
  "person-01",
  "person-02",
  "person-03",
  "person-04",
  "person-05",
  "person-06",
] as const;

const LATE_PAGE_ID = "person-05";
const INSERTED_ID = "person-99";

/** The export's connection. */
let readerPool: Pool | undefined;
/** The concurrent writer's connection — independent of the export's. */
let writerPool: Pool | undefined;
let readerDb: NodePgDatabase | undefined;
let writerDb: NodePgDatabase | undefined;
let postgresAvailable = false;

function exportedNodes(
  chunks: readonly GraphInterchangeChunk[],
): InterchangeNode[] {
  return chunks.flatMap((chunk) =>
    chunk.type === "nodes" ? [...chunk.nodes] : [],
  );
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  try {
    readerPool = new Pool({ connectionString: TEST_DATABASE_URL });
    writerPool = new Pool({ connectionString: TEST_DATABASE_URL });
    await readerPool.query("SELECT 1");
    await writerPool.query("SELECT 1");
    await readerPool.query(generatePostgresMigrationSQL());
    readerDb = drizzle(readerPool);
    writerDb = drizzle(writerPool);
    postgresAvailable = true;
  } catch {
    postgresAvailable = false;
  }
});

afterAll(async () => {
  if (readerPool) await readerPool.end();
  if (writerPool) await writerPool.end();
});

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL export snapshot isolation against a concurrent writer",
  () => {
    beforeEach(async () => {
      if (!postgresAvailable || !readerPool) return;
      await readerPool.query(
        "TRUNCATE typegraph_nodes, typegraph_edges, typegraph_node_uniques, typegraph_schema_versions CASCADE",
      );
    });

    it("keeps a mid-stream commit out of the pages the export has not read yet", async () => {
      const reader = createAdapterStore(
        graph,
        createPostgresBackend(requireDefined(readerDb)),
      );
      const writer = createAdapterStore(
        graph,
        createPostgresBackend(requireDefined(writerDb)),
      );
      for (const id of SEEDED_IDS) {
        await reader.nodes.Person.create({ name: `original ${id}` }, { id });
      }

      const iterator = exportGraphStream(reader, {
        batchSize: 2,
      })[Symbol.asyncIterator]();
      const delivered: GraphInterchangeChunk[] = [];
      // Header + the first page: the repeatable-read snapshot is established by
      // the transaction's first statement, so it exists before the write below.
      const header = await iterator.next();
      expect(header.value).toMatchObject({ type: "header" });
      const firstPage = await iterator.next();
      expect(firstPage.value).toMatchObject({ type: "nodes" });
      delivered.push(firstPage.value as GraphInterchangeChunk);

      // Both kinds of change the snapshot has to hide, committed on the OTHER
      // connection while the export's transaction is open.
      await writer.nodes.Person.update(asNodeId(LATE_PAGE_ID), {
        name: "MUTATED",
      });
      await writer.nodes.Person.create(
        { name: "inserted mid-export" },
        { id: INSERTED_ID },
      );
      const rewritten = await writer.nodes.Person.getById(
        asNodeId(LATE_PAGE_ID),
      );
      expect(rewritten?.name).toBe("MUTATED");

      for (;;) {
        const next = await iterator.next();
        if (next.done === true) break;
        delivered.push(next.value);
      }

      const nodes = exportedNodes(delivered);
      expect(nodes.map((node) => node.id)).toEqual([...SEEDED_IDS]);
      expect(
        nodes.find((node) => node.id === LATE_PAGE_ID)?.properties["name"],
      ).toBe(`original ${LATE_PAGE_ID}`);
    });
  },
);
