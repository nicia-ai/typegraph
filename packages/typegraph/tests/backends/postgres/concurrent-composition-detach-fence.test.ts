/**
 * A detach's "is this required part still live" verdict holds against a
 * concurrent restore, on a second, genuinely concurrent PostgreSQL connection.
 *
 * The verdict reads the part row, which no claim row records, so it is a
 * lock-only decision. At `REPEATABLE READ` and `SERIALIZABLE`, a detach whose
 * snapshot was pinned before a restore committed would otherwise read the part
 * as still tombstoned and separate it from its whole; it must fail at the
 * fence instead.
 *
 * On this backend the detach plan's own first statement takes the per-graph
 * fence and advances the graph's fence row, so the stale snapshot fails right
 * there. The verdict's own freshness gate only decides on a port whose fence
 * advances no fence row (`composition-existence-fresh-snapshot-pglite.test.ts`).
 *
 * The fixture part is tombstoned directly while its composition edge to the
 * live whole survives, as a write outside the store's write path leaves it.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  type Store,
  TransactionConflictError,
  type TransactionContext,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CASE_TIMEOUT_MS = 20_000;

const Show = defineNode("Show", { schema: z.object({}) });
const Clip = defineNode("Clip", { schema: z.object({}) });
const clipOf = defineEdge("clipOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "concurrent-composition-detach-fence",
  nodes: { Show: { type: Show }, Clip: { type: Clip } },
  edges: {
    // `oneActive`, so ending the window is a detach too.
    clipOf: {
      type: clipOf,
      from: [Clip],
      to: [Show],
      cardinality: "oneActive",
    },
  },
  ontology: [partOf(Clip, Show, { via: clipOf, existence: "required" })],
});

type GraphStore = Store<typeof graph>;
type WriteSurface = Pick<TransactionContext<typeof graph>, "edges">;

const SHOW = "show";
const CLIP = "clip";
const edgeId = asEdgeId<typeof clipOf>("clip-of");

const DETACHES: readonly Readonly<{
  name: string;
  run: (surface: WriteSurface) => Promise<unknown>;
}>[] = [
  {
    name: "edge delete",
    run: (surface) => surface.edges.clipOf.delete(edgeId),
  },
  {
    name: "edge hardDelete",
    run: (surface) => surface.edges.clipOf.hardDelete(edgeId),
  },
  {
    name: "edge bulkDelete",
    run: (surface) => surface.edges.clipOf.bulkDelete([edgeId]),
  },
  {
    name: "edge window end",
    run: (surface) =>
      surface.edges.clipOf.update(
        edgeId,
        {},
        { validTo: new Date().toISOString() },
      ),
  },
];

const ISOLATION_LEVELS = ["repeatable_read", "serializable"] as const;

let restorePool: Pool | undefined;
let detachPool: Pool | undefined;
let stores:
  Readonly<{ restoreStore: GraphStore; detachStore: GraphStore }> | undefined;

function requireLive(): Readonly<{
  restoreStore: GraphStore;
  detachStore: GraphStore;
  observer: Pool;
}> {
  if (stores === undefined || restorePool === undefined) {
    throw new Error(
      "concurrent-composition-detach-fence: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { ...stores, observer: restorePool };
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
  const pools = [createPool(), createPool()] as const;
  await runServerSuiteSetup(
    "concurrent-composition-detach-fence",
    pools,
    async () => {
      const [first, second] = pools;
      await first.query(generatePostgresMigrationSQL());
      restorePool = first;
      detachPool = second;
      const [restoreStore] = await createStoreWithSchema(
        graph,
        createPostgresBackend(drizzle(first)),
      );
      const [detachStore] = await createStoreWithSchema(
        graph,
        createPostgresBackend(drizzle(second)),
      );
      stores = { restoreStore, detachStore };
    },
  );
});

afterAll(async () => {
  for (const pool of [restorePool, detachPool]) {
    if (pool !== undefined) await pool.end();
  }
});

beforeEach(async () => {
  if (restorePool === undefined) return;
  const { restoreStore, observer } = requireLive();
  await observer.query(
    "TRUNCATE typegraph_edge_claims, typegraph_node_uniques, typegraph_edges, typegraph_nodes",
  );
  await restoreStore.nodes.Show.create({}, { id: SHOW });
  await restoreStore.nodes.Clip.create(
    {},
    { id: CLIP, partOf: { whole: { kind: "Show", id: SHOW } } },
  );
  const renamed = await observer.query(
    "UPDATE typegraph_edges SET id = $1 WHERE kind = 'clipOf' AND from_id = $2",
    [edgeId, CLIP],
  );
  const tombstoned = await observer.query(
    "UPDATE typegraph_nodes SET deleted_at = now() WHERE kind = 'Clip' AND id = $1",
    [CLIP],
  );
  if (renamed.rowCount !== 1 || tombstoned.rowCount !== 1) {
    throw new Error(
      "concurrent-composition-detach-fence: the tombstoned-part fixture did not apply.",
    );
  }
});

describe.runIf(process.env["POSTGRES_URL"])(
  "a required part's detach against a concurrent restore (PostgreSQL)",
  () => {
    // MUTATION CHECK: make `edgeDetachNeedsConstraintFence`
    // (src/store/constraints.ts) answer `undefined` — every detach then
    // commits from its stale snapshot and leaves the restored clip with no
    // whole.
    for (const isolationLevel of ISOLATION_LEVELS) {
      for (const detach of DETACHES) {
        it(
          `${detach.name} fails a ${isolationLevel} snapshot that predates the restore`,
          async () => {
            const live = requireLive();
            const outcome = await live.detachStore
              .transaction(
                async (tx) => {
                  // Pins the snapshot before the restore commits.
                  await tx.nodes.Show.getById(SHOW as never);
                  await live.restoreStore.nodes.Clip.upsertById(CLIP, {});
                  await detach.run(tx);
                },
                { isolationLevel },
              )
              .then(
                () => "committed" as const,
                (error: unknown) => error,
              );

            expect(outcome).toBeInstanceOf(TransactionConflictError);
            expect(
              await live.restoreStore.nodes.Clip.getById(CLIP as never),
            ).toBeDefined();
            expect(
              await live.restoreStore.edges.clipOf.getById(edgeId),
            ).toMatchObject({ id: edgeId });
            expect(await live.restoreStore.verifyConstraintFences()).toEqual(
              [],
            );
          },
          CASE_TIMEOUT_MS,
        );
      }
    }
  },
);
