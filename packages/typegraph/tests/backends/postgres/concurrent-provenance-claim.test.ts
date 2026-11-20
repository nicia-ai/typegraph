/**
 * The merge-provenance sidecar claim under GENUINE contention with a raw,
 * schema-less writer, on a real PostgreSQL server.
 *
 * The claim decides whether a graph id is free by probing for rows, then writes
 * its ownership marker — both inside one `schemaWriteTransaction`. That fence
 * excludes every writer that takes the per-graph advisory lock (other claims,
 * schema commits) or the graph's active schema row (`FOR SHARE` on every
 * schema-managed Store write). It does NOT reach a schema-LESS `createStore`
 * writer or a direct `backend.insertNode`: those take neither. At read committed
 * such an INSERT can therefore commit between the probe's statement snapshot and
 * the claim's commit, and the claim marks a graph id it saw empty and an
 * application saw as its own.
 *
 * ## Why this suite exists alongside the in-process one
 *
 * `tests/graph-merge/provenance-store.test.ts` pins the MECHANISM on SQLite and
 * PGlite — that `LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE` is issued inside the
 * claim's fence, before the re-inspection it authorizes, on Postgres only, and
 * not at all when an already-owned sidecar opens. It cannot pin the outcome:
 * PGlite is single-connection and serial, so a writer can never actually overlap
 * a claim there. This suite is the other half. It runs two independent
 * connections against one database and asserts only the OUTCOME — that the
 * application's graph id was not claimed out from under it.
 *
 * The interleaving is arranged rather than hoped for: the application's INSERT is
 * executed and held open in an uncommitted transaction, so it is invisible to any
 * probe while holding the row lock the claim's relation lock must wait for. The
 * claim therefore reaches its ownership decision with the row still uncommitted —
 * exactly the window the lock closes. With the lock the claim waits for that
 * transaction, re-reads under exclusion, sees the application row and REFUSES;
 * without it the probe sees an empty id and the marker lands beside the
 * application's row.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import {
  openProvenanceStore,
  provenanceGraphId,
} from "../../../src/graph-merge/provenance-store";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

/**
 * The claim parks in `LOCK TABLE` while the application's transaction is held
 * open, so a lock-order regression would stall the run rather than report; the
 * timeout turns a hang into a failure.
 */
const CONTENTION_TIMEOUT_MS = 20_000;

/**
 * How long the claim is given to reach its ownership decision while the
 * application's INSERT is uncommitted. Generous, and only a lower bound on the
 * strength of the interleaving: if the claim had not got that far, its probe
 * would run after the commit and see the row anyway, so a slow machine weakens
 * this test rather than making it flaky.
 */
const CLAIM_HEADSTART_MS = 750;

/** The merge target whose sidecar id the application happens to occupy. */
const TARGET_GRAPH_ID = "concurrent-provenance-claim-target";
const SIDECAR_GRAPH_ID = provenanceGraphId(TARGET_GRAPH_ID);

/**
 * TWO pools, not one with a larger `max`. The claim parks inside `LOCK TABLE`
 * while holding its connection, and that wait must not sit behind the
 * application's own connection in a shared checkout queue — that would be a
 * self-deadlock of the harness rather than a product result.
 */
let claimPool: Pool | undefined;
let writerPool: Pool | undefined;
let claimDb: NodePgDatabase | undefined;
let isPostgresAvailable = false;

/**
 * The suite is gated on `POSTGRES_URL`, and its setup now FAILS rather than
 * skipping (see ./server-suite-setup.ts), so an unpublished handle here means
 * setup reported success without publishing one. Throwing keeps that a
 * failure: a `ctx.skip()` would turn the same state back into the green skip
 * the setup fix exists to remove.
 */
function requirePostgres(): Readonly<{
  claim: NodePgDatabase;
  writer: Pool;
}> {
  if (
    !isPostgresAvailable ||
    claimDb === undefined ||
    writerPool === undefined
  ) {
    throw new Error(
      "concurrent-provenance-claim: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { claim: claimDb, writer: writerPool };
}

function createPool(): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
  });
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const first = createPool();
  const second = createPool();
  await runServerSuiteSetup(
    "concurrent-provenance-claim",
    [first, second],
    async () => {
      await first.query("SELECT 1");
      await second.query("SELECT 1");
      await first.query(generatePostgresMigrationSQL());
      claimPool = first;
      writerPool = second;
      claimDb = drizzle(first);
      isPostgresAvailable = true;
    },
  );
});

afterAll(async () => {
  if (claimPool !== undefined) await claimPool.end();
  if (writerPool !== undefined) await writerPool.end();
});

beforeEach(async () => {
  if (claimPool === undefined) return;
  await claimPool.query(
    "TRUNCATE typegraph_node_uniques, typegraph_edges, typegraph_nodes, " +
      "typegraph_schema_versions",
  );
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The ownership marker rows the claim would have written, read raw. */
async function markerCount(pool: Pool): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS marker_count FROM typegraph_nodes
      WHERE graph_id = $1 AND kind = 'ProvenanceOwner'`,
    [SIDECAR_GRAPH_ID],
  );
  return (result.rows[0] as Readonly<{ marker_count: number }>).marker_count;
}

describe.runIf(process.env["POSTGRES_URL"])(
  "provenance sidecar claim under genuine contention (PostgreSQL)",
  () => {
    it(
      "does not claim a graph id whose first row commits while it decides",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const backend = createPostgresBackend(live.claim);

        // A schema-less application row: no schema row, no advisory lock, no
        // `FOR SHARE` on anything — the one writer class the per-graph fence
        // cannot see. Executed but NOT committed, so it is invisible to the
        // claim's probe while holding the row lock the relation lock waits for.
        const writerClient = await live.writer.connect();
        await writerClient.query("BEGIN");
        await writerClient.query(
          `INSERT INTO typegraph_nodes
             (graph_id, kind, id, props, version, created_at, updated_at, valid_from)
           VALUES ($1, 'Patient', 'app-row', '{"name":"Existing"}', 1, now(), now(), now())`,
          [SIDECAR_GRAPH_ID],
        );

        // Start the claim and give it time to reach its ownership decision while
        // the application's row is still uncommitted.
        const claim = openProvenanceStore(backend, TARGET_GRAPH_ID).then(
          () => "claimed" as const,
          (error: unknown) => error,
        );
        await delay(CLAIM_HEADSTART_MS);
        await writerClient.query("COMMIT");
        writerClient.release();

        // The outcome, and the only thing asserted: the application's graph id
        // was not taken. Which of the two went first is arbitrary — either the
        // claim saw the committed row, or it waited for the lock and then saw it
        // — and both orders satisfy the invariant.
        const outcome = await claim;
        expect(outcome).toMatchObject({
          name: "ConfigurationError",
          details: {
            code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
            reason: "application-graph",
          },
        });
        await expect(markerCount(live.writer)).resolves.toBe(0);
        await expect(
          live.writer
            .query("SELECT id FROM typegraph_nodes WHERE graph_id = $1", [
              SIDECAR_GRAPH_ID,
            ])
            .then((result) => result.rowCount),
        ).resolves.toBe(1);
      },
    );

    it(
      "still claims a genuinely free graph id under the same lock",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        // The lock excludes writers; it must not exclude the claim itself. With
        // no contention the same path claims the id and writes exactly one
        // marker, so the drain is a wait, never a refusal of its own.
        const live = requirePostgres();
        const backend = createPostgresBackend(live.claim);

        await expect(
          openProvenanceStore(backend, TARGET_GRAPH_ID),
        ).resolves.toBeDefined();

        await expect(markerCount(live.writer)).resolves.toBe(1);
      },
    );
  },
);
