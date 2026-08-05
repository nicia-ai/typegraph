/**
 * Scaling fixture for identity-expanded traversal under a historical
 * coordinate (typegraph#310).
 *
 * The measurement is the acceptance criterion for #310, so the fixture lives in
 * the repository rather than in a scratch script. It is opt-in — set
 * `TYPEGRAPH_PERF=1` — because it provisions graphs up to a few thousand nodes
 * and reports timings rather than asserting behavior.
 *
 * ```bash
 * TYPEGRAPH_PERF=1 pnpm vitest run tests/perf/identity-historical-traversal-scaling.test.ts
 * # PostgreSQL spot-check (two sizes):
 * POSTGRES_URL=... TYPEGRAPH_PERF=1 pnpm vitest run tests/perf/identity-historical-traversal-scaling.test.ts
 * ```
 *
 * Two edge shapes are measured separately so the historical-reconstruction cost
 * this issue removes is not conflated with the correlated candidate-edge scan
 * tracked in typegraph#270:
 *
 * - **narrow** — fan-out 1: exactly one candidate `link` edge per source row.
 *   The per-source candidate-edge scan is trivial, so the wall time isolates the
 *   identity-reconstruction term. This is the fixture whose quadratic scaling
 *   #310 reports.
 * - **broad** — fan-out {@link BROAD_FAN_OUT}: the correlated candidate-edge
 *   scan of #270 dominates and is expected to remain after this fix.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../../src";
import { generatePostgresMigrationSQL } from "../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../src/backend/postgres";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import { provisionPostgresTestDatabase } from "../postgres-test-database";

const PERF_ENABLED = process.env["TYPEGRAPH_PERF"] === "1";
const NARROW_SIZES = [250, 500, 1000, 2000] as const;
const BROAD_SIZES = [250, 500, 1000] as const;
const POSTGRES_NARROW_SIZES = [250, 500] as const;
const POSTGRES_BROAD_SIZES = [125, 250] as const;
const BROAD_FAN_OUT = 8;

const PerfPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const PerfCompany = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const perfLink = defineEdge("link", { schema: z.object({}) });

const perfGraph = defineGraph({
  id: "identity_historical_scaling",
  nodes: { Company: { type: PerfCompany }, Person: { type: PerfPerson } },
  edges: {
    link: {
      type: perfLink,
      from: [PerfPerson, PerfCompany],
      to: [PerfPerson, PerfCompany],
    },
  },
  identity: { sameIdAcrossKinds: "fold" },
});

type EdgeShape = "broad" | "narrow";

/**
 * Builds the fixture: `size` Person nodes, all of which act as source rows, plus
 * a Company peer per Person sharing its id so the `"fold"` structural same-id
 * relation actually spans the graph (an all-distinct-id graph folds nothing and
 * would measure an empty relation).
 *
 * Every `link` edge leaves the *Company* peer, so reaching any target at all
 * requires the identity expansion — no row is reachable through the plain edge
 * join. Fan-out is 1 for the narrow shape and {@link BROAD_FAN_OUT} for the
 * broad shape.
 *
 * Planner statistics are refreshed explicitly so every size is measured against
 * fresh statistics; otherwise the bulk-write auto-ANALYZE threshold kicks in
 * partway up the scale and the plan changes between measurements.
 */
async function provisionFixture(
  backend: GraphBackend,
  size: number,
  shape: EdgeShape,
): Promise<{ asOf: string; store: Awaited<ReturnType<typeof openStore>> }> {
  const store = await openStore(backend);
  await store.nodes.Person.bulkCreate(
    Array.from({ length: size }, (unused, index) => ({
      id: `node-${index}`,
      props: { name: `Person ${index}` },
    })),
  );
  await store.nodes.Company.bulkCreate(
    Array.from({ length: size }, (unused, index) => ({
      id: `node-${index}`,
      props: { name: `Company ${index}` },
    })),
  );
  const fanOut = shape === "narrow" ? 1 : BROAD_FAN_OUT;
  await store.edges.link.bulkCreate(
    Array.from({ length: size * fanOut }, (unused, index) => {
      const source = Math.floor(index / fanOut);
      return {
        from: { id: `node-${source}`, kind: "Company" as const },
        id: `link-${index}`,
        props: {},
        to: { id: `node-${(index + 1) % size}`, kind: "Person" as const },
      };
    }),
  );
  await store.refreshStatistics();
  return { asOf: new Date().toISOString(), store };
}

async function openStore(backend: GraphBackend) {
  const [store] = await createStoreWithSchema(perfGraph, backend);
  return store;
}

async function measure(
  store: Awaited<ReturnType<typeof openStore>>,
  asOf: string,
): Promise<{ milliseconds: number; rows: number }> {
  const started = performance.now();
  const rows = await store
    .asOf(asOf)
    .query()
    .from("Person", "person")
    .traverse("link", "edge", {
      expand: "none",
      includeIdentityMembers: true,
    })
    .to("Person", "friend")
    .select((queryContext) => queryContext.friend.id)
    .execute();
  return { milliseconds: performance.now() - started, rows: rows.length };
}

function reportRow(
  label: string,
  size: number,
  result: Readonly<{ milliseconds: number; rows: number }>,
): void {
  console.log(
    `${label} n=${String(size).padStart(5)} ` +
      `time=${result.milliseconds.toFixed(0).padStart(6)}ms ` +
      `rows=${result.rows}`,
  );
}

describe.runIf(PERF_ENABLED)("historical identity traversal scaling", () => {
  describe("sqlite", () => {
    for (const shape of ["narrow", "broad"] satisfies EdgeShape[]) {
      it(`${shape} edges`, async () => {
        for (const size of shape === "narrow" ? NARROW_SIZES : BROAD_SIZES) {
          const { backend } = createLocalSqliteBackend();
          try {
            const fixture = await provisionFixture(backend, size, shape);
            reportRow(
              `sqlite ${shape.padEnd(6)}`,
              size,
              await measure(fixture.store, fixture.asOf),
            );
          } finally {
            await backend.close();
          }
        }
      }, 600_000);
    }
  });

  describe("postgres", () => {
    const databaseUrl = process.env["POSTGRES_URL"];
    let pool: Pool | undefined;

    beforeAll(async () => {
      if (databaseUrl === undefined) return;
      const url = await provisionPostgresTestDatabase(import.meta.url);
      const candidate = new Pool({
        connectionString: url,
        connectionTimeoutMillis: 5000,
      });
      await candidate.query("SELECT 1");
      await candidate.query(generatePostgresMigrationSQL());
      pool = candidate;
    }, 120_000);

    afterAll(async () => {
      if (pool !== undefined) await pool.end();
    });

    for (const shape of ["narrow", "broad"] satisfies EdgeShape[]) {
      it.runIf(databaseUrl !== undefined)(
        `${shape} edges`,
        async () => {
          const activePool = pool;
          if (activePool === undefined) return;
          const sizes =
            shape === "narrow" ? POSTGRES_NARROW_SIZES : POSTGRES_BROAD_SIZES;
          for (const size of sizes) {
            const backend = createPostgresBackend(drizzle(activePool));
            const fixture = await provisionFixture(backend, size, shape);
            reportRow(
              `postgres ${shape.padEnd(6)}`,
              size,
              await measure(fixture.store, fixture.asOf),
            );
            await activePool.query(
              "TRUNCATE typegraph_nodes, typegraph_edges, typegraph_identity_assertions, typegraph_identity_closure",
            );
          }
        },
        600_000,
      );
    }
  });
});
