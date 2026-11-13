/**
 * A required part's restore verdict holds against a concurrent detach however
 * the restoring frame's plan was named, on a second, genuinely concurrent
 * PostgreSQL connection.
 *
 * A frame fenced for another constraint (a shared-scope unique) takes the
 * per-graph write fence without advancing the graph's fence row. At
 * `REPEATABLE READ`, a restore whose snapshot was pinned before a detach
 * committed must still fail at the fence rather than restore the part from
 * the stale view of its edge.
 *
 * The fixture part is tombstoned directly while their composition edges to
 * the live whole survive, as a write outside the store's write path (or a
 * provenance currency close) leaves it.
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
  subClassOf,
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
const Clip = defineNode("Clip", { schema: z.object({ name: z.string() }) });
const SpecialClip = defineNode("SpecialClip", {
  schema: z.object({ name: z.string() }),
});
const clipOf = defineEdge("clipOf", { schema: z.object({}) });

/** Spans `Clip` and `SpecialClip`, so a `Clip` update names `nodeUniquenessScope`. */
const CLIP_NAME_UNIQUE = {
  name: "clip_name",
  fields: ["name"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const graph = defineGraph({
  id: "concurrent-composition-restore-fence",
  nodes: {
    Show: { type: Show },
    Clip: { type: Clip, unique: [CLIP_NAME_UNIQUE] },
    SpecialClip: { type: SpecialClip, unique: [CLIP_NAME_UNIQUE] },
  },
  edges: {
    clipOf: {
      type: clipOf,
      from: [Clip],
      to: [Show],
      cardinality: "oneActive",
    },
  },
  ontology: [
    subClassOf(SpecialClip, Clip),
    partOf(Clip, Show, { via: clipOf, existence: "required" }),
  ],
});

type GraphStore = Store<typeof graph>;
type WriteSurface = Pick<TransactionContext<typeof graph>, "nodes">;

const show = { kind: "Show", id: "show" } as const;

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
      "concurrent-composition-restore-fence: PostgreSQL connections are unavailable after setup reported success.",
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
    "concurrent-composition-restore-fence",
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
  await restorePool.query(
    "TRUNCATE typegraph_edge_claims, typegraph_node_uniques, typegraph_edges, typegraph_nodes",
  );
  await requireLive().restoreStore.nodes.Show.create({}, { id: show.id });
});

/**
 * Creates parts attached to the show, renames each part's composition edge to
 * `<id>-of`, then tombstones the parts (and releases their unique entries)
 * while the edges stay live.
 */
async function seedTombstonedParts(
  create: (id: string) => Promise<unknown>,
  ids: readonly string[],
): Promise<void> {
  const { observer } = requireLive();
  for (const id of ids) {
    await create(id);
    await observer.query(
      "UPDATE typegraph_edges SET id = $1 || '-of' WHERE from_id = $1",
      [id],
    );
  }
  const tombstoned = await observer.query(
    "UPDATE typegraph_nodes SET deleted_at = now() WHERE id = ANY($1)",
    [ids],
  );
  // A soft delete releases the node's unique entries with it.
  await observer.query(
    "UPDATE typegraph_node_uniques SET deleted_at = now() WHERE node_id = ANY($1)",
    [ids],
  );
  if (tombstoned.rowCount !== ids.length) {
    throw new Error(
      "concurrent-composition-restore-fence: the tombstoned-part fixture did not apply.",
    );
  }
}

const SCOPED_RESTORES: readonly Readonly<{
  name: string;
  run: (surface: WriteSurface) => Promise<unknown>;
}>[] = [
  {
    name: "upsertById",
    run: (surface) => surface.nodes.Clip.upsertById("clip", { name: "back" }),
  },
  {
    name: "bulkUpsertById",
    run: (surface) =>
      surface.nodes.Clip.bulkUpsertById([
        { id: "clip", props: { name: "back" } },
      ]),
  },
  {
    name: "bulkReplaceById",
    run: (surface) =>
      surface.nodes.Clip.bulkReplaceById([
        { id: "clip", props: { name: "back" } },
      ]),
  },
];

describe.runIf(process.env["POSTGRES_URL"])(
  "a required part's restore against a concurrent detach (PostgreSQL)",
  () => {
    // MUTATION CHECK: drop the `fenceCompositionExistenceDecision` call from
    // `assertRestoredRequiredPartsAttached`
    // (src/store/operations/composition-create.ts) AND list the update probe
    // before the restore probe in `nodeUpdateConstraintProbes`
    // (src/store/operations/node-operations.ts) — every case then commits the
    // restore from its stale snapshot and leaves the clip with no live whole.
    for (const restore of SCOPED_RESTORES) {
      it(
        `${restore.name} of a part whose kind declares a shared-scope unique fails a repeatable_read snapshot that predates the detach`,
        async () => {
          const live = requireLive();
          await seedTombstonedParts(
            (id) =>
              live.restoreStore.nodes.Clip.create(
                { name: "c" },
                { id, partOf: { whole: show } },
              ),
            ["clip"],
          );

          const outcome = await live.restoreStore
            .transaction(
              async (tx) => {
                // Pins the snapshot before the detach commits.
                await tx.nodes.Show.getById(show.id as never);
                await live.detachStore.edges.clipOf.delete(
                  asEdgeId<typeof clipOf>("clip-of"),
                );
                await restore.run(tx);
              },
              { isolationLevel: "repeatable_read" },
            )
            .then(
              () => "committed" as const,
              (error: unknown) => error,
            );

          expect(outcome).toBeInstanceOf(TransactionConflictError);
          expect(
            await live.restoreStore.nodes.Clip.getById("clip" as never),
          ).toBeUndefined();
          expect(await live.restoreStore.verifyConstraintFences()).toEqual([]);
        },
        CASE_TIMEOUT_MS,
      );
    }
  },
);
