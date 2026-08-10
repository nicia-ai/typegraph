/**
 * PostgreSQL parity for the inverted-validity-window repair (design §C, T7).
 *
 * The predicate text is identical on both dialects; the *semantics* are not,
 * and that is why this suite exists rather than a shared cross-backend one:
 *
 * - SQLite stores the bounds as `TEXT` and compares them lexicographically, so
 *   the repair carries a canonicality `GLOB` guard and counts the rows it could
 *   not classify.
 * - PostgreSQL stores `timestamptz`, where `>` is always a chronological
 *   compare. A scanned relation therefore reports `nonCanonical: 0` — never
 *   `undefined`, which stays reserved for "not scanned" on both dialects — and
 *   `apply` has nothing to refuse.
 * - `report` opens a `READ ONLY` transaction, which only this engine can be
 *   asked to confirm (`SHOW transaction_read_only`). That makes "report writes
 *   nothing" enforced here rather than merely compiled; the SQLite suite pins
 *   the same decision at the seam, where `BEGIN` vs `BEGIN IMMEDIATE` is not
 *   observable from a single connection.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { repairInvertedValidityWindows } from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import type {
  GraphBackend,
  TransactionBackend,
  TransactionOptions,
} from "../../../src/backend/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const GRAPH_ID = "pg_repair_windows";
const EARLY = "2020-01-01T00:00:00.000Z";
const MIDDLE = "2022-01-01T00:00:00.000Z";
const LATE = "2024-01-01T00:00:00.000Z";

let pool: Pool | undefined;

/**
 * The suite is gated on `POSTGRES_URL` and its setup fails rather than skips,
 * so an unpublished handle means setup reported success without publishing one.
 */
function requirePool(): Pool {
  if (pool === undefined) {
    throw new Error(
      "repair-validity-windows: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return pool;
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
  });
  await runServerSuiteSetup(
    "repair-validity-windows",
    [candidate],
    async () => {
      await candidate.query("SELECT 1");
      await candidate.query(generatePostgresMigrationSQL());
      pool = candidate;
    },
  );
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  if (pool === undefined) return;
  await pool.query(
    "TRUNCATE typegraph_recorded_nodes, typegraph_edges, typegraph_nodes",
  );
});

/**
 * Rows written straight into the relation: the store API can no longer produce
 * an inverted window, which is the whole reason the repair exists.
 */
async function seedRows(target: Pool): Promise<void> {
  await target.query(
    `INSERT INTO typegraph_nodes (
       graph_id, kind, id, props, version, valid_from, valid_to,
       created_at, updated_at
     ) VALUES
       ($1, 'Person', 'inverted',  '{"name":"inverted"}',  1, $4, $2, $2, $2),
       ($1, 'Person', 'zeroWidth', '{"name":"zeroWidth"}', 1, $3, $3, $2, $2),
       ($1, 'Person', 'ordered',   '{"name":"ordered"}',   1, $2, $4, $2, $2),
       ($1, 'Person', 'openLeft',  '{"name":"openLeft"}',  1, NULL, $4, $2, $2)`,
    [GRAPH_ID, EARLY, MIDDLE, LATE],
  );
  await target.query(
    `INSERT INTO typegraph_recorded_nodes (
       history_id, graph_id, kind, id, props, version, valid_from, valid_to,
       created_at, updated_at, recorded_from, recorded_to, op, meta
     ) VALUES
       ('h1', $1, 'Person', 'inverted', '{"name":"inverted"}', 1, $3, $2,
        $2, $2, 1, 2, 'create', '{}')`,
    [GRAPH_ID, EARLY, LATE],
  );
}

type StoredWindow = Readonly<{
  validFrom: string | undefined;
  validTo: string | undefined;
}>;

/** `timestamptz` reaches the driver as a `Date`; compare instants, not renderings. */
function instant(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? new Date(value).toISOString() : undefined;
}

async function readWindow(
  target: Pool,
  table: string,
  id: string,
): Promise<StoredWindow> {
  const result = await target.query<Readonly<Record<string, unknown>>>(
    `SELECT valid_from, valid_to FROM ${table} WHERE id = $1`,
    [id],
  );
  const row = result.rows[0] ?? {};
  return {
    validFrom: instant(row["valid_from"]),
    validTo: instant(row["valid_to"]),
  };
}

function backendFor(target: Pool): GraphBackend {
  return createPostgresBackend(drizzle(target));
}

describe.runIf(process.env["POSTGRES_URL"])(
  "repairInvertedValidityWindows on PostgreSQL",
  () => {
    it("reports without writing, and never reports a scanned relation as unclassified", async () => {
      const target = requirePool();
      await seedRows(target);
      const backend = backendFor(target);

      const report = await repairInvertedValidityWindows({
        backend,
        graphId: GRAPH_ID,
        relations: "live-and-recorded",
        mode: "report",
      });

      expect(report.counts.nodes).toBe(1);
      expect(report.counts.recordedNodes).toBe(1);
      expect(report.atomic).toBe(true);
      // timestamptz: every stored value compares chronologically, so a scanned
      // relation is classified in full. `undefined` stays reserved for "not
      // scanned" — which is what `edges` would be under `relations: "live"`.
      expect(report.nonCanonical).toEqual({
        nodes: 0,
        edges: 0,
        recordedNodes: 0,
        recordedEdges: 0,
      });
      expect(await readWindow(target, "typegraph_nodes", "inverted")).toEqual({
        validFrom: LATE,
        validTo: EARLY,
      });
    });

    it("scans inside a READ ONLY transaction and applies inside a writing one", async () => {
      const target = requirePool();
      await seedRows(target);
      const raw = backendFor(target);
      const engineVerdicts: (string | undefined)[] = [];
      // The engine's own answer, not the library's. `report` writes nothing
      // because PostgreSQL would refuse to let it, which is a stronger claim
      // than "no UPDATE was compiled" — and it is the reason the docs let an
      // operator diagnose against a live store without quiescing writers.
      const backend: GraphBackend = deriveBackend(raw, {
        transaction: async <T>(
          fn: (tx: TransactionBackend) => Promise<T>,
          options?: TransactionOptions,
        ): Promise<T> =>
          raw.transaction(async (tx) => {
            const rows = await tx.execute<
              Readonly<{ transaction_read_only: unknown }>
            >(asCompiledRowsSql(sql`SHOW transaction_read_only`));
            engineVerdicts.push(rows[0]?.transaction_read_only as string);
            return fn(tx);
          }, options),
      });

      await repairInvertedValidityWindows({
        backend,
        graphId: GRAPH_ID,
        relations: "live",
        mode: "report",
      });
      await repairInvertedValidityWindows({
        backend,
        graphId: GRAPH_ID,
        relations: "live",
        mode: "apply",
      });

      expect(engineVerdicts).toEqual(["on", "off"]);
    });

    it("repairs only inverted rows, on both axes, and converges", async () => {
      const target = requirePool();
      await seedRows(target);
      const backend = backendFor(target);

      const applied = await repairInvertedValidityWindows({
        backend,
        graphId: GRAPH_ID,
        relations: "live-and-recorded",
        mode: "apply",
      });
      expect(applied.counts.nodes).toBe(1);
      expect(applied.counts.recordedNodes).toBe(1);

      expect(await readWindow(target, "typegraph_nodes", "inverted")).toEqual({
        validFrom: undefined,
        validTo: EARLY,
      });
      expect(
        await readWindow(target, "typegraph_recorded_nodes", "inverted"),
      ).toEqual({ validFrom: undefined, validTo: EARLY });
      // A stated zero-width window is legal; the repair does not second-guess it.
      expect(await readWindow(target, "typegraph_nodes", "zeroWidth")).toEqual({
        validFrom: MIDDLE,
        validTo: MIDDLE,
      });
      expect(await readWindow(target, "typegraph_nodes", "ordered")).toEqual({
        validFrom: EARLY,
        validTo: LATE,
      });

      const second = await repairInvertedValidityWindows({
        backend,
        graphId: GRAPH_ID,
        relations: "live-and-recorded",
        mode: "apply",
      });
      expect(second.counts).toEqual({
        nodes: 0,
        edges: 0,
        recordedNodes: 0,
        recordedEdges: 0,
      });
    });

    it("scopes to one graph", async () => {
      const target = requirePool();
      await seedRows(target);
      const backend = backendFor(target);

      const report = await repairInvertedValidityWindows({
        backend,
        graphId: "another_graph",
        relations: "live",
        mode: "apply",
      });
      expect(report.counts.nodes).toBe(0);
      expect(await readWindow(target, "typegraph_nodes", "inverted")).toEqual({
        validFrom: LATE,
        validTo: EARLY,
      });
    });
  },
);
