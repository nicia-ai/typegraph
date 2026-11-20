/**
 * A hard delete releases only the claims of the rows it actually removed,
 * under genuine contention on a real PostgreSQL server.
 *
 * Every edge hard delete resolves its target first and then issues a DELETE
 * that asserts the kind it resolved. On a default store (no history, no
 * revision tracking) an edge kind constrained only by cardinality takes no
 * per-graph write fence, so at READ COMMITTED a second session can, between
 * the resolve and the DELETE, remove the edge and commit a replacement of
 * ANOTHER constrained kind under the same id. The kind-asserting DELETE then
 * matches zero rows and the replacement survives — but a claim release keyed
 * by graph and id alone would strip the replacement's claim, leaving a live
 * constrained edge that no claim row fences.
 *
 * The interleaving is forced, not hoped for: the deleting session is paused on
 * a gate after its resolve and before its DELETE (a wrapper around the
 * transaction target's delete member), the other session runs to commit on
 * its own pool, then the gate opens. Each case runs the single `hardDelete`,
 * the batched `bulkHardDelete` and its per-edge fallback (no batch port).
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import {
  type DeleteEdgesBatchParams,
  type GraphBackend,
  type HardDeleteEdgeParams,
  type TransactionBackend,
} from "../../../src/backend/types";
import { requireDefined } from "../../../src/utils/presence";
import { readEdgeClaimRows } from "../../edge-claim-rows";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CASE_TIMEOUT_MS = 20_000;

const Person = defineNode("EhdPerson", {
  schema: z.object({ name: z.string() }),
});
/** The kind the deleting session resolves and asserts. */
const mentors = defineEdge("ehdMentors", { schema: z.object({}) });
/** The other constrained kind the concurrent session re-points the id at. */
const coaches = defineEdge("ehdCoaches", { schema: z.object({}) });

const graph = defineGraph({
  id: "concurrent-edge-hard-delete-claim",
  nodes: { EhdPerson: { type: Person } },
  edges: {
    ehdMentors: {
      type: mentors,
      from: [Person],
      to: [Person],
      cardinality: "one",
    },
    ehdCoaches: {
      type: coaches,
      from: [Person],
      to: [Person],
      cardinality: "one",
    },
  },
});

/** Separate pools so the concurrent session never queues behind the paused one. */
let deleterPool: Pool | undefined;
let replacerPool: Pool | undefined;
let deleterDb: NodePgDatabase | undefined;
let replacerDb: NodePgDatabase | undefined;

function requirePostgres(): Readonly<{
  deleter: NodePgDatabase;
  replacer: NodePgDatabase;
}> {
  if (deleterDb === undefined || replacerDb === undefined) {
    throw new Error(
      "concurrent-edge-hard-delete-claim: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { deleter: deleterDb, replacer: replacerDb };
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
    "concurrent-edge-hard-delete-claim",
    pools,
    async () => {
      const [deleter, replacer] = pools;
      await deleter.query(generatePostgresMigrationSQL());
      await replacer.query("SELECT 1");
      deleterPool = deleter;
      replacerPool = replacer;
      deleterDb = drizzle(deleter);
      replacerDb = drizzle(replacer);
    },
  );
});

afterAll(async () => {
  for (const pool of [deleterPool, replacerPool]) {
    if (pool !== undefined) await pool.end();
  }
});

beforeEach(async () => {
  if (deleterPool === undefined) return;
  await deleterPool.query(
    "TRUNCATE typegraph_edge_claims, typegraph_edges, typegraph_nodes",
  );
});

type Gate = Readonly<{
  /** Resolves once the deleting session has reached its DELETE. */
  reached: Promise<void>;
  open: () => void;
}>;

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

function deferred(): Deferred {
  const handle: { resolve?: () => void } = {};
  const promise = new Promise<void>((settle) => {
    handle.resolve = settle;
  });
  return {
    promise,
    resolve: () => {
      requireDefined(handle.resolve)();
    },
  };
}

function createGate(): Gate & Readonly<{ arrive: () => Promise<void> }> {
  const reached = deferred();
  const opened = deferred();
  return {
    reached: reached.promise,
    open: () => {
      opened.resolve();
    },
    arrive: async () => {
      reached.resolve();
      await opened.promise;
    },
  };
}

type DeletePath = "hardDelete" | "bulkHardDelete" | "bulkHardDelete fallback";

/**
 * The deleting session's backend: every transaction target's edge hard-delete
 * members wait on `gate` before they run, and the fallback path also loses
 * `hardDeleteEdgesBatch`.
 */
function gatedBackend(
  base: GraphBackend,
  path: DeletePath,
  gate: ReturnType<typeof createGate>,
): GraphBackend {
  function gate_(target: TransactionBackend): TransactionBackend {
    const source =
      path === "bulkHardDelete fallback" ?
        (projectBackendWithout(target, [
          "hardDeleteEdgesBatch",
        ]) as TransactionBackend)
      : target;
    return deriveBackend(source, {
      hardDeleteEdge: async (params: HardDeleteEdgeParams) => {
        await gate.arrive();
        return target.hardDeleteEdge(params);
      },
      ...(path === "bulkHardDelete" ?
        {
          hardDeleteEdgesBatch: async (params: DeleteEdgesBatchParams) => {
            await gate.arrive();
            return target.hardDeleteEdgesBatch?.(params);
          },
        }
      : {}),
    } as never);
  }
  return deriveBackend(base, {
    transaction: (fn, options) =>
      base.transaction((tx) => fn(gate_(tx)), options),
  });
}

const PATHS: readonly DeletePath[] = [
  "hardDelete",
  "bulkHardDelete",
  "bulkHardDelete fallback",
];

describe.runIf(process.env["POSTGRES_URL"])(
  "edge hard delete under a concurrent same-id replacement (PostgreSQL)",
  () => {
    for (const path of PATHS) {
      // MUTATION CHECK: release claims for every resolved id instead of the
      // ids the DELETE reported removing — the replacement's claim row is
      // purged and the claim assertion fails on every path.
      it(
        `keeps the replacement's claim when the kind-asserting DELETE removes nothing (${path})`,
        { timeout: CASE_TIMEOUT_MS },
        async () => {
          const live = requirePostgres();
          const setupBackend = createPostgresBackend(live.deleter);
          const setup = createStore(graph, setupBackend);
          const alice = await setup.nodes.EhdPerson.create(
            { name: "Alice" },
            { id: "alice" },
          );
          const bob = await setup.nodes.EhdPerson.create(
            { name: "Bob" },
            { id: "bob" },
          );
          await setup.edges.ehdMentors.create(alice, bob, {}, { id: "e1" });

          const gate = createGate();
          const deleter = createStore(
            graph,
            gatedBackend(createPostgresBackend(live.deleter), path, gate),
          );
          const replacer = createStore(
            graph,
            createPostgresBackend(live.replacer),
          );

          const deletion =
            path === "hardDelete" ?
              deleter.edges.ehdMentors.hardDelete("e1" as never)
            : deleter.edges.ehdMentors.bulkHardDelete(["e1"] as never);
          const settled = deletion.then(
            () => "ok" as const,
            (error: unknown) => error,
          );
          await gate.reached;

          // The other session removes the resolved edge and commits a
          // constrained edge of another kind under the same id.
          await replacer.transaction(async (tx) => {
            await tx.edges.ehdMentors.hardDelete("e1" as never);
            await tx.edges.ehdCoaches.create(alice, bob, {}, { id: "e1" });
          });

          gate.open();
          expect(await settled).toBe("ok");

          const survivor = await setupBackend.getEdge(graph.id, "e1");
          expect(survivor?.kind).toBe("ehdCoaches");
          const claims = await readEdgeClaimRows(setupBackend, graph.id);
          expect(claims.map((claim) => claim.edge_id)).toEqual(["e1"]);
        },
      );
    }
  },
);
