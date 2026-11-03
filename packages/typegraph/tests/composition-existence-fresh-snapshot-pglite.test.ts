/**
 * A detach's "is this required part still live" verdict is a lock-only
 * decision: no claim row records it, so it is trustworthy only from a
 * snapshot taken after the per-graph fence. On a port whose fence advances no
 * fence row, a `REPEATABLE READ` or `SERIALIZABLE` snapshot cannot be shown
 * fresh, so the detach must refuse rather than decide from it.
 *
 * The bundled PostgreSQL backend never reaches this refusal: its detach plan
 * advances the graph's fence row in the plan's own first statement, so a
 * stale snapshot fails there (see
 * `backends/postgres/concurrent-composition-detach-fence.test.ts`). This port
 * is the one shape where the verdict's own gate is the only thing standing
 * between a stale read and an orphaned part.
 *
 * The part is tombstoned through the raw backend member with its composition
 * edge left live, so every detach below would otherwise be allowed.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { asEdgeId, defineEdge, defineGraph, defineNode, partOf } from "../src";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";
import { advisoryOnlyBackend } from "./advisory-only-backend";

const Show = defineNode("Show", { schema: z.object({}) });
const Clip = defineNode("Clip", { schema: z.object({}) });
const clipOf = defineEdge("clipOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition-existence-fresh-snapshot",
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

type GraphStore = Awaited<
  ReturnType<typeof createStoreWithSchema<typeof graph>>
>[0];

const DETACHES: readonly Readonly<{
  name: string;
  run: (store: GraphStore, edgeId: string) => Promise<unknown>;
}>[] = [
  {
    name: "edge delete",
    run: (store, edgeId) =>
      store.edges.clipOf.delete(asEdgeId<typeof clipOf>(edgeId)),
  },
  {
    name: "edge hardDelete",
    run: (store, edgeId) =>
      store.edges.clipOf.hardDelete(asEdgeId<typeof clipOf>(edgeId)),
  },
  {
    name: "edge bulkDelete",
    run: (store, edgeId) =>
      store.edges.clipOf.bulkDelete([asEdgeId<typeof clipOf>(edgeId)]),
  },
  {
    name: "edge window end",
    run: (store, edgeId) =>
      store.edges.clipOf.update(
        asEdgeId<typeof clipOf>(edgeId),
        {},
        { validTo: new Date().toISOString() },
      ),
  },
];

const SNAPSHOT_ISOLATION_LEVELS = [
  { setting: "repeatable read", isolation: "repeatable_read" },
  { setting: "serializable", isolation: "serializable" },
] as const;

async function withTombstonedPart(
  run: (
    fixture: Readonly<{
      store: GraphStore;
      edgeId: string;
      setIsolation: (setting: string) => Promise<void>;
    }>,
  ) => Promise<void>,
): Promise<void> {
  const local = await createLocalPgliteBackend({ vector: false });
  const backend = advisoryOnlyBackend(
    createPostgresBackend(local.db, { vector: false }),
  );
  try {
    const [store] = await createStoreWithSchema(graph, backend);
    const show = await store.nodes.Show.create({});
    const clip = await store.nodes.Clip.create({}, { partOf: { whole: show } });
    await backend.deleteNode({ graphId: graph.id, kind: "Clip", id: clip.id });
    const [edge] = await store.edges.clipOf.find({});
    await run({
      store,
      edgeId: requireDefined(edge).id,
      setIsolation: async (setting) => {
        await local.client.exec(
          `SET default_transaction_isolation = '${setting}'`,
        );
      },
    });
  } finally {
    await local.backend.close();
  }
}

describe("a required part's detach on a port whose fence advances no fence row", () => {
  // MUTATION CHECK: drop the `fenceCompositionExistenceDecision` call from
  // `assertCompositionExistencePreserved`
  // (src/store/operations/composition-create.ts) — every snapshot case then
  // decides from the unproven snapshot and the detach goes through.
  for (const { setting, isolation } of SNAPSHOT_ISOLATION_LEVELS) {
    for (const detach of DETACHES) {
      it(`${detach.name} refuses at ${isolation} and writes nothing`, async () => {
        await withTombstonedPart(async ({ store, edgeId, setIsolation }) => {
          await setIsolation(setting);
          const refusal = await detach
            .run(store, edgeId)
            .catch((error: unknown) => error);
          await setIsolation("read committed");

          expect(refusal).toMatchObject({
            details: {
              code: "COMPOSITION_EXISTENCE_REQUIRES_FRESH_SNAPSHOT",
              isolation,
              fenceRow: "none",
            },
          });
          const [edge] = await store.edges.clipOf.find({});
          expect(edge).toMatchObject({ id: edgeId });
          expect(edge?.meta.validTo).toBeUndefined();
        });
      });
    }
  }

  it.each(DETACHES)(
    "$name of the tombstoned part's edge goes through at read committed",
    async (detach) => {
      await withTombstonedPart(async ({ store, edgeId }) => {
        await detach.run(store, edgeId);
        const [edge] = await store.edges.clipOf.find({});
        expect(edge === undefined || edge.meta.validTo !== undefined).toBe(
          true,
        );
      });
    },
  );
});
