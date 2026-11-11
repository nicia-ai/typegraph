/**
 * The composition window decision under GENUINE contention on a real
 * PostgreSQL server: two connections each write an ENDED history row for the
 * same `oneActive` part, and the two windows overlap.
 *
 * A row born ended takes no composition claim — the claim row holds the
 * part's one OPEN attachment — so no key stops both writers. What does is the
 * per-graph write fence every composition edge write takes, held to commit:
 * the decision (`assertCompositionWindowsDisjoint`) reads the part's stored
 * windows under it, so the contender parks until the holder commits and then
 * reads the holder's row. Under a snapshot isolation that read could predate
 * the holder's commit, so the decision first advances the graph's fence row
 * (`fenceLockOnlyDecision`) and the stale snapshot fails with a serialization
 * failure instead.
 *
 * MUTATION CHECK: make `assertCompositionWindowsDisjoint`
 * (src/store/claims/composition-windows.ts) return before its plan — the
 * read-committed contender then commits its overlapping row after the wait,
 * and the audit reports `compositionWindowOverlap`.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CompositionError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  TransactionConflictError,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import {
  poolApplicationName,
  raceAgainstHeldTransaction,
  requireError,
  summarizeRace,
} from "./held-transaction-race";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CASE_TIMEOUT_MS = 20_000;
const HOLDER_APPLICATION = "concurrent-composition-window:holder";
const CONTENDER_APPLICATION = "concurrent-composition-window:contender";

const Reel = defineNode("Reel", { schema: z.object({}) });
const Cut = defineNode("Cut", { schema: z.object({}) });
const cutOf = defineEdge("cutOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "concurrent-composition-window-overlap",
  nodes: { Reel: { type: Reel }, Cut: { type: Cut } },
  edges: {
    cutOf: { type: cutOf, from: [Cut], to: [Reel], cardinality: "oneActive" },
  },
  ontology: [partOf(Cut, Reel, { via: cutOf })],
});

const SINCE = "2018-01-01T00:00:00.000Z";
const HOLDER_WINDOW = {
  validFrom: "2020-01-01T00:00:00.000Z",
  validTo: "2022-01-01T00:00:00.000Z",
};
const CONTENDER_WINDOW = {
  validFrom: "2021-01-01T00:00:00.000Z",
  validTo: "2023-01-01T00:00:00.000Z",
};

let holderPool: Pool | undefined;
let contenderPool: Pool | undefined;
let probePool: Pool | undefined;
let holderDb: NodePgDatabase | undefined;
let contenderDb: NodePgDatabase | undefined;

function requirePostgres(): Readonly<{
  holder: NodePgDatabase;
  contender: NodePgDatabase;
  probe: Pool;
}> {
  if (
    holderDb === undefined ||
    contenderDb === undefined ||
    probePool === undefined
  ) {
    throw new Error(
      "concurrent-composition-window-overlap: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { holder: holderDb, contender: contenderDb, probe: probePool };
}

function createPool(applicationName?: string): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
    ...(applicationName === undefined ?
      {}
    : poolApplicationName(applicationName)),
  });
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const pools = [
    createPool(HOLDER_APPLICATION),
    createPool(CONTENDER_APPLICATION),
    createPool(),
  ] as const;
  await runServerSuiteSetup(
    "concurrent-composition-window-overlap",
    pools,
    async () => {
      const [holder, contender, probe] = pools;
      await holder.query("SELECT 1");
      await contender.query("SELECT 1");
      await probe.query(generatePostgresMigrationSQL());
      holderPool = holder;
      contenderPool = contender;
      probePool = probe;
      holderDb = drizzle(holder);
      contenderDb = drizzle(contender);
    },
  );
});

afterAll(async () => {
  for (const pool of [holderPool, contenderPool, probePool]) {
    if (pool !== undefined) await pool.end();
  }
});

beforeEach(async () => {
  if (probePool === undefined) return;
  await probePool.query(
    "TRUNCATE typegraph_edge_claims, typegraph_edges, typegraph_nodes",
  );
});

async function seed(live: ReturnType<typeof requirePostgres>) {
  const setup = createStore(graph, createPostgresBackend(live.holder));
  const reelA = await setup.nodes.Reel.create({}, { validFrom: SINCE });
  const reelB = await setup.nodes.Reel.create({}, { validFrom: SINCE });
  const cut = await setup.nodes.Cut.create({}, { validFrom: SINCE });
  return {
    setup,
    reelA,
    reelB,
    cut,
    holderStore: createStore(graph, createPostgresBackend(live.holder)),
    contenderStore: createStore(graph, createPostgresBackend(live.contender)),
  };
}

describe.runIf(process.env["POSTGRES_URL"])(
  "composition window overlap under genuine contention (PostgreSQL)",
  () => {
    it(
      "refuses the second of two concurrent ended rows whose windows overlap, after it waits on the fence",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const { setup, reelA, reelB, cut, holderStore, contenderStore } =
          await seed(live);

        const race = await raceAgainstHeldTransaction({
          probe: live.probe,
          holderApplication: HOLDER_APPLICATION,
          contenderApplication: CONTENDER_APPLICATION,
          holder: (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.edges.cutOf.create(cut, reelA, {}, HOLDER_WINDOW);
              await holdOpen();
            }),
          contender: () =>
            contenderStore.edges.cutOf.create(cut, reelB, {}, CONTENDER_WINDOW),
        });

        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: CompositionError.name,
        });
        expect(requireError(race.contender)).toMatchObject({
          code: "COMPOSITION_WINDOW_OVERLAP",
        });
        expect(
          await setup.edges.cutOf.find({}, { temporalMode: "includeEnded" }),
        ).toHaveLength(1);
        expect(await setup.verifyConstraintFences()).toEqual([]);
      },
    );

    for (const isolationLevel of ["repeatable_read", "serializable"] as const) {
      it(
        `fails a ${isolationLevel} contender whose snapshot predates the holder's commit`,
        { timeout: CASE_TIMEOUT_MS },
        async () => {
          const live = requirePostgres();
          const { setup, reelA, reelB, cut, holderStore, contenderStore } =
            await seed(live);

          const race = await raceAgainstHeldTransaction({
            probe: live.probe,
            holderApplication: HOLDER_APPLICATION,
            contenderApplication: CONTENDER_APPLICATION,
            holder: (holdOpen) =>
              holderStore.transaction(async (tx) => {
                await tx.edges.cutOf.create(cut, reelA, {}, HOLDER_WINDOW);
                await holdOpen();
              }),
            contender: () =>
              contenderStore.transaction(
                async (tx) => {
                  // Pins the snapshot while the holder is still open.
                  await tx.nodes.Cut.getById(cut.id);
                  await tx.edges.cutOf.create(cut, reelB, {}, CONTENDER_WINDOW);
                },
                { isolationLevel },
              ),
          });

          expect(summarizeRace(race)).toEqual({
            contenderState: "blocked",
            holder: "ok",
            contender: TransactionConflictError.name,
          });
          expect(
            await setup.edges.cutOf.find({}, { temporalMode: "includeEnded" }),
          ).toHaveLength(1);
          expect(await setup.verifyConstraintFences()).toEqual([]);
        },
      );
    }

    // MUTATION CHECK: make `edgeWindowEndNeedsConstraintFence`
    // (src/store/constraints.ts) answer only the detach fence — an optional
    // part's window widening then takes no fence, its decision reads before
    // the holder commits, and the contender settles with the overlap written.
    it(
      "refuses a concurrent update that widens an ended window over the holder's row",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const { setup, reelA, reelB, cut, holderStore, contenderStore } =
          await seed(live);
        const early = await setup.edges.cutOf.create(
          cut,
          reelB,
          {},
          {
            validFrom: "2019-01-01T00:00:00.000Z",
            validTo: HOLDER_WINDOW.validFrom,
          },
        );

        const race = await raceAgainstHeldTransaction({
          probe: live.probe,
          holderApplication: HOLDER_APPLICATION,
          contenderApplication: CONTENDER_APPLICATION,
          holder: (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.edges.cutOf.create(cut, reelA, {}, HOLDER_WINDOW);
              await holdOpen();
            }),
          contender: () =>
            contenderStore.edges.cutOf.update(
              early.id,
              {},
              {
                validTo: CONTENDER_WINDOW.validFrom,
              },
            ),
        });

        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: CompositionError.name,
        });
        expect(await setup.verifyConstraintFences()).toEqual([]);
      },
    );

    it(
      "lets two concurrent ended rows that abut both commit",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const { setup, reelA, reelB, cut, holderStore, contenderStore } =
          await seed(live);

        const race = await raceAgainstHeldTransaction({
          probe: live.probe,
          holderApplication: HOLDER_APPLICATION,
          contenderApplication: CONTENDER_APPLICATION,
          holder: (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.edges.cutOf.create(cut, reelA, {}, HOLDER_WINDOW);
              await holdOpen();
            }),
          contender: () =>
            contenderStore.edges.cutOf.create(
              cut,
              reelB,
              {},
              {
                validFrom: HOLDER_WINDOW.validTo,
                validTo: CONTENDER_WINDOW.validTo,
              },
            ),
        });

        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: "ok",
        });
        expect(await setup.verifyConstraintFences()).toEqual([]);
      },
    );
  },
);
