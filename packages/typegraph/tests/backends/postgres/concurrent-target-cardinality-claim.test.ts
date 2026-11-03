/**
 * Issue #610: target-side edge cardinality under
 * GENUINE contention on a real PostgreSQL server.
 *
 * `tests/backends/postgres/concurrent-constraint-fence.test.ts` already pins
 * this for the SOURCE axis ("refuses the second of two cardinality-one
 * creates") — two writers racing `reportsTo.create(alice, bob)` /
 * `reportsTo.create(alice, carol)`, same source, different targets. This file
 * is the mirror case the source-only suite cannot exercise: two writers racing
 * a DIFFERENT source against the SAME target, on a `targetCardinality: "one"`
 * kind. The target-axis claim (`edgeCardinalityAxisReferences`'s `"target"`
 * arm) is what makes this decidable at all — without it, both writers'
 * `countEdgesAtEndpoint` probes read zero and both commit.
 *
 * The interleaving is forced by hold-and-gate (`./held-transaction-race.ts`):
 * the holder writes inside a transaction it keeps open, and the contender must
 * be observed parked on a lock the holder took before the holder commits.
 *
 * Store built with history and revision tracking DISABLED (`createStore`
 * with no options), as the issue requires: the fence must hold on the
 * DEFAULT store shape, not only the history-tracked one.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CardinalityError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { expectOnlyClaimsOf, readEdgeClaimRows } from "../../edge-claim-rows";
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

const HOLDER_APPLICATION = "concurrent-target-cardinality-claim:holder";
const CONTENDER_APPLICATION = "concurrent-target-cardinality-claim:contender";

const Person = defineNode("CtcPerson", {
  schema: z.object({ name: z.string() }),
});
const Target = defineNode("CtcTarget", {
  schema: z.object({ name: z.string() }),
});

/** Target-only constrained: no source-side bound at all. */
const assignedTo = defineEdge("ctcAssignedTo", { schema: z.object({}) });
/** Both axes constrained, for the residue case. */
const ownsBoth = defineEdge("ctcOwnsBoth", { schema: z.object({}) });

const graph = defineGraph({
  id: "concurrent-target-cardinality-claim",
  nodes: {
    CtcPerson: { type: Person },
    CtcTarget: { type: Target },
  },
  edges: {
    ctcAssignedTo: {
      type: assignedTo,
      from: [Person],
      to: [Target],
      targetCardinality: "one",
    },
    ctcOwnsBoth: {
      type: ownsBoth,
      from: [Person],
      to: [Target],
      cardinality: "one",
      targetCardinality: "one",
    },
  },
});

/**
 * Separate pools, not one with a larger `max` — see
 * `concurrent-constraint-fence.test.ts` for why a shared pool would let the
 * contender's wait queue behind the holder's own connection, turning a product
 * result into a self-deadlock of the harness. The probe pool observes the
 * wait.
 */
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
      "concurrent-target-cardinality-claim: PostgreSQL connections are unavailable after setup reported success.",
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
    "concurrent-target-cardinality-claim",
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

describe.runIf(process.env["POSTGRES_URL"])(
  "target-side edge cardinality under genuine contention (PostgreSQL)",
  () => {
    // MUTATION CHECK: drop the `"target"` arm from
    // `edgeCardinalityAxisReferences` (`src/store/claims/edge-claims.ts`).
    // The target-only case then takes no claim and no fence, so the contender
    // commits while the holder is still open (`contenderState: "settled"`,
    // two edges into the target). The two-axis case still waits on its
    // source-axis fence, but nothing refuses the second target edge.
    it(
      "refuses the second of two creates from different sources onto the same target",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.holder));
        const alice = await setup.nodes.CtcPerson.create(
          { name: "Alice" },
          { id: "alice" },
        );
        const bob = await setup.nodes.CtcPerson.create(
          { name: "Bob" },
          { id: "bob" },
        );
        const target = await setup.nodes.CtcTarget.create(
          { name: "Target" },
          { id: "target" },
        );

        const holderStore = createStore(
          graph,
          createPostgresBackend(live.holder),
        );
        const contenderStore = createStore(
          graph,
          createPostgresBackend(live.contender),
        );

        // Different sources, same target: `targetCardinality: "one"` allows
        // at most one edge of this kind INTO `target`, so the two are in
        // direct conflict on the axis this suite exists to fence.
        const race = await raceAgainstHeldTransaction({
          probe: live.probe,
          holderApplication: HOLDER_APPLICATION,
          contenderApplication: CONTENDER_APPLICATION,
          holder: (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.edges.ctcAssignedTo.create(alice, target, {});
              await holdOpen();
            }),
          contender: () =>
            contenderStore.edges.ctcAssignedTo.create(bob, target, {}),
        });

        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: CardinalityError.name,
        });
        const refusal = requireError(race.contender);
        expect(refusal).toBeInstanceOf(CardinalityError);
        expect((refusal as CardinalityError).details.direction).toBe("target");

        const survivors = await setup.edges.ctcAssignedTo.findTo(target);
        expect(survivors.map((edge) => edge.fromId)).toEqual([alice.id]);
      },
    );

    it(
      "leaves the holder's row intact when the contender conflicts on a two-axis kind",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const setupBackend = createPostgresBackend(live.holder);
        const setup = createStore(graph, setupBackend);
        const alice = await setup.nodes.CtcPerson.create(
          { name: "Alice" },
          { id: "alice-both" },
        );
        const bob = await setup.nodes.CtcPerson.create(
          { name: "Bob" },
          { id: "bob-both" },
        );
        const target = await setup.nodes.CtcTarget.create(
          { name: "Target Both" },
          { id: "target-both" },
        );

        const holderStore = createStore(
          graph,
          createPostgresBackend(live.holder),
        );
        const contenderStore = createStore(
          graph,
          createPostgresBackend(live.contender),
        );

        // Both axes constrained: alice and bob are different sources, but
        // both race for the SAME target — the target axis is what decides
        // this pair, same as the single-axis case above.
        const race = await raceAgainstHeldTransaction({
          probe: live.probe,
          holderApplication: HOLDER_APPLICATION,
          contenderApplication: CONTENDER_APPLICATION,
          holder: (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.edges.ctcOwnsBoth.create(alice, target, {});
              await holdOpen();
            }),
          contender: () =>
            contenderStore.edges.ctcOwnsBoth.create(bob, target, {}),
        });

        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: CardinalityError.name,
        });

        // The holder's row is intact — not just present, but the ONLY row,
        // and the contender left no residue (a half-claimed source axis, a
        // dangling row) behind its refusal.
        const survivors = await setup.edges.ctcOwnsBoth.findTo(target);
        expect(survivors.map((edge) => edge.fromId)).toEqual([alice.id]);
        // The claim relation holds exactly the holder's two axis rows: the
        // contender's source axis is not left claimed.
        expectOnlyClaimsOf(
          await readEdgeClaimRows(setupBackend, graph.id),
          graph.id,
          { cardinality: "one", targetCardinality: "one" },
          survivors,
        );
        // The contender's own source axis is free again: a fresh,
        // otherwise-valid create from bob still succeeds.
        const otherTarget = await setup.nodes.CtcTarget.create(
          { name: "Other Target" },
          { id: "other-target-both" },
        );
        await expect(
          setup.edges.ctcOwnsBoth.create(bob, otherTarget, {}),
        ).resolves.toBeDefined();
      },
    );
  },
);
