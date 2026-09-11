/**
 * Issue #610, acceptance criterion 4: target-side edge cardinality under
 * GENUINE contention on a real PostgreSQL server.
 *
 * `tests/backends/postgres/concurrent-constraint-fence.test.ts` already pins
 * this for the SOURCE axis ("admits exactly one of two concurrent
 * cardinality-one creates") — two writers racing `reportsTo.create(alice,
 * bob)` / `reportsTo.create(alice, carol)`, same source, different targets.
 * This file is the mirror case the source-only suite cannot exercise: two
 * writers racing a DIFFERENT source against the SAME target, on a
 * `targetCardinality: "one"` kind. `checkEdgeCardinalityConstraints`'s
 * per-graph advisory lock is what makes this decidable at all — without it,
 * both writers' `countEdgesAtEndpoint` probes read zero and both commit.
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
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

/** Each concurrent pair: one writer holds the fence while the other waits. */
const CONTENTION_TIMEOUT_MS = 20_000;

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
 * TWO pools, not one with a larger `max` — see
 * `concurrent-constraint-fence.test.ts` for why a shared pool would let the
 * loser's wait queue behind the winner's own connection, turning a product
 * result into a self-deadlock of the harness.
 */
let firstPool: Pool | undefined;
let secondPool: Pool | undefined;
let firstDb: NodePgDatabase | undefined;
let secondDb: NodePgDatabase | undefined;
let isPostgresAvailable = false;

function requirePostgres(): Readonly<{
  first: NodePgDatabase;
  second: NodePgDatabase;
}> {
  if (!isPostgresAvailable || firstDb === undefined || secondDb === undefined) {
    throw new Error(
      "concurrent-target-cardinality-claim: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { first: firstDb, second: secondDb };
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
    "concurrent-target-cardinality-claim",
    [first, second],
    async () => {
      await first.query("SELECT 1");
      await second.query("SELECT 1");
      await first.query(generatePostgresMigrationSQL());
      firstPool = first;
      secondPool = second;
      firstDb = drizzle(first);
      secondDb = drizzle(second);
      isPostgresAvailable = true;
    },
  );
});

afterAll(async () => {
  if (firstPool !== undefined) await firstPool.end();
  if (secondPool !== undefined) await secondPool.end();
});

beforeEach(async () => {
  if (firstPool === undefined) return;
  await firstPool.query(
    "TRUNCATE typegraph_edge_claims, typegraph_edges, typegraph_nodes",
  );
});

type Settled<T> = Readonly<{
  fulfilled: readonly T[];
  rejected: readonly unknown[];
}>;

/**
 * Splits a settled pair into winners and losers. The assertions are always
 * about the COUNTS and the loser's error TYPE — never about which of the two
 * stores won, which is arbitrary and would make the case flaky.
 */
function partitionSettled<T>(
  results: readonly PromiseSettledResult<T>[],
): Settled<T> {
  return {
    fulfilled: results
      .filter((result): result is PromiseFulfilledResult<T> => {
        return result.status === "fulfilled";
      })
      .map((result) => result.value),
    rejected: results
      .filter((result): result is PromiseRejectedResult => {
        return result.status === "rejected";
      })
      .map((result): unknown => result.reason),
  };
}

describe.runIf(process.env["POSTGRES_URL"])(
  "target-side edge cardinality under genuine contention (PostgreSQL)",
  () => {
    it(
      "admits exactly one of two concurrent creates from different sources onto the same target",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.first));
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

        const storeA = createStore(graph, createPostgresBackend(live.first));
        const storeB = createStore(graph, createPostgresBackend(live.second));

        // Different sources, same target: `targetCardinality: "one"` allows
        // at most one edge of this kind INTO `target`, so the two are in
        // direct conflict on the axis this suite exists to fence.
        const { fulfilled, rejected } = partitionSettled(
          await Promise.allSettled([
            storeA.edges.ctcAssignedTo.create(alice, target, {}),
            storeB.edges.ctcAssignedTo.create(bob, target, {}),
          ]),
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toBeInstanceOf(CardinalityError);
        expect((rejected[0] as CardinalityError).details.direction).toBe(
          "target",
        );
        expect(await setup.edges.ctcAssignedTo.findTo(target)).toHaveLength(1);
      },
    );
    // REVERT CHECK (write-only — not runnable in this sandbox; the lead runs
    // `pnpm test:postgres`): drop the `"target"` arm from
    // `edgeCardinalityAxisReferences` (`src/store/claims/edge-claims.ts`).
    // Both concurrent creates should then commit and `fulfilled` should read
    // 2 instead of 1. Also worth running once with the target claim issued
    // AFTER the row insert (rather than before) to confirm the pre-insert
    // placement — not just the claim's existence — is what fences the race:
    // a post-insert claim still lets both rows land before either claim can
    // refuse the other.

    it(
      "leaves the winner's row intact when the loser conflicts on a two-axis kind",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.first));
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

        const storeA = createStore(graph, createPostgresBackend(live.first));
        const storeB = createStore(graph, createPostgresBackend(live.second));

        // Both axes constrained: alice and bob are different sources, but
        // both race for the SAME target — the target axis is what decides
        // this pair, same as the single-axis case above.
        const { fulfilled, rejected } = partitionSettled(
          await Promise.allSettled([
            storeA.edges.ctcOwnsBoth.create(alice, target, {}),
            storeB.edges.ctcOwnsBoth.create(bob, target, {}),
          ]),
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toBeInstanceOf(CardinalityError);

        // The winner's row is intact — not just present, but the ONLY row,
        // and the loser left no residue (a half-claimed source axis, a
        // dangling row) behind its refusal.
        const survivors = await setup.edges.ctcOwnsBoth.findTo(target);
        expect(survivors).toHaveLength(1);
        const winner = survivors[0];
        expect(winner).toBeDefined();
        if (winner === undefined) throw new Error("Expected a surviving edge");
        expect([alice.id, bob.id]).toContain(winner.fromId);
        // The loser's own source axis is free again: a fresh, otherwise-valid
        // create from the SAME loser source still succeeds.
        const loserSourceId = winner.fromId === alice.id ? bob.id : alice.id;
        const otherTarget = await setup.nodes.CtcTarget.create(
          { name: "Other Target" },
          { id: "other-target-both" },
        );
        await expect(
          setup.edges.ctcOwnsBoth.create(
            { kind: "CtcPerson", id: loserSourceId },
            otherTarget,
            {},
          ),
        ).resolves.toBeDefined();
      },
    );
  },
);
