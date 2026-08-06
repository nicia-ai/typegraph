/**
 * Scaling fixture for identity-expanded traversal at the **current** read
 * coordinate (typegraph#270).
 *
 * The measurement is the acceptance criterion for #270, so the fixture lives in
 * the repository rather than in a scratch script. It is opt-in — set
 * `TYPEGRAPH_PERF=1` — because it provisions graphs up to a hundred thousand
 * edges and reports timings rather than asserting behavior.
 *
 * ```bash
 * TYPEGRAPH_PERF=1 pnpm vitest run tests/perf/identity-current-traversal-scaling.test.ts
 * # PostgreSQL (a reduced case list):
 * POSTGRES_URL=... TYPEGRAPH_PERF=1 pnpm vitest run tests/perf/identity-current-traversal-scaling.test.ts
 * ```
 *
 * The cost #270 removes is a product of two independent numbers, so both are
 * varied rather than one composite size:
 *
 * - **source rows** — how many frontier rows the hop expands from. The
 *   correlated membership predicate is evaluated per (source row, candidate
 *   edge) pair, so this is the multiplier the equi-join removes.
 * - **fan-out** — candidate `link` edges per source. Growing it alone grows the
 *   candidate set the old predicate rescanned for every source row.
 *
 * The last case is the one the issue asks for: 100k matching edges over a
 * frontier wide enough that the per-source rescan is the dominant term.
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

/** One measured shape: `sources` frontier rows, `fanOut` candidate edges each. */
type Case = Readonly<{ fanOut: number; sources: number }>;

const SQLITE_CASES: readonly Case[] = [
  { fanOut: 1, sources: 250 },
  { fanOut: 1, sources: 500 },
  { fanOut: 1, sources: 1000 },
  { fanOut: 1, sources: 2000 },
  { fanOut: 8, sources: 250 },
  { fanOut: 8, sources: 500 },
  { fanOut: 8, sources: 1000 },
  { fanOut: 200, sources: 500 },
];

const POSTGRES_CASES: readonly Case[] = [
  { fanOut: 1, sources: 250 },
  { fanOut: 1, sources: 500 },
  { fanOut: 8, sources: 250 },
  { fanOut: 200, sources: 500 },
];

/**
 * Graph sizes for the single-start-row hop: the frontier is one row, so what
 * these vary is the size of the identity population the class relation covers.
 */
const SINGLE_SOURCE_CASES: readonly Case[] = [
  { fanOut: 1, sources: 1000 },
  { fanOut: 1, sources: 10_000 },
  { fanOut: 1, sources: 50_000 },
];

const PerfPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const PerfCompany = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const PerfAlias = defineNode("Alias", {
  schema: z.object({ name: z.string() }),
});
const perfLink = defineEdge("link", { schema: z.object({}) });

const perfGraph = defineGraph({
  id: "identity_current_scaling",
  nodes: {
    Alias: { type: PerfAlias },
    Company: { type: PerfCompany },
    Person: { type: PerfPerson },
  },
  edges: {
    link: {
      type: perfLink,
      from: [PerfPerson, PerfCompany, PerfAlias],
      to: [PerfPerson],
    },
  },
  identity: { sameIdAcrossKinds: "fold" },
});

/**
 * Builds the fixture: `sources` Person nodes, all of which act as source rows,
 * plus a Company and an Alias peer per Person sharing its id. Under `"fold"`
 * that is a three-member identity class per source — multi-member classes are
 * what make the closure self-join non-trivial, and an all-distinct-id graph
 * would fold nothing and measure an empty relation.
 *
 * Every `link` edge leaves the *Company* peer, so reaching any target at all
 * requires the identity expansion: no row is reachable through the plain edge
 * join, and the visible-member filter has to admit the Company peer for the hop
 * to return anything.
 *
 * Planner statistics are refreshed explicitly so every case is measured against
 * fresh statistics; otherwise the bulk-write auto-ANALYZE threshold kicks in
 * partway up the scale and the plan changes between measurements.
 */
async function provisionFixture(
  backend: GraphBackend,
  measuredCase: Case,
): Promise<Awaited<ReturnType<typeof openStore>>> {
  const store = await openStore(backend);
  const { fanOut, sources } = measuredCase;
  const rows = Array.from({ length: sources }, (unused, index) => ({
    id: `node-${index}`,
    props: { name: `Node ${index}` },
  }));
  await store.nodes.Person.bulkCreate(rows);
  await store.nodes.Company.bulkCreate(rows);
  await store.nodes.Alias.bulkCreate(rows);
  await store.edges.link.bulkCreate(
    Array.from({ length: sources * fanOut }, (unused, index) => {
      const source = Math.floor(index / fanOut);
      return {
        from: { id: `node-${source}`, kind: "Company" as const },
        id: `link-${index}`,
        props: {},
        to: { id: `node-${(index + 1) % sources}`, kind: "Person" as const },
      };
    }),
  );
  await store.refreshStatistics();
  return store;
}

async function openStore(backend: GraphBackend) {
  const [store] = await createStoreWithSchema(perfGraph, backend);
  return store;
}

async function measure(
  store: Awaited<ReturnType<typeof openStore>>,
): Promise<{ milliseconds: number; rows: number }> {
  const started = performance.now();
  const rows = await store
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

/**
 * The same hop from a single start row. The class relation is built for the whole
 * graph, so this is the shape that pays for it without benefiting from the
 * removed per-source rescan — the cost model's stated caveat, measured rather
 * than asserted.
 */
async function measureSingleSource(
  store: Awaited<ReturnType<typeof openStore>>,
): Promise<{ milliseconds: number; rows: number }> {
  const started = performance.now();
  const rows = await store
    .query()
    .from("Person", "person")
    .whereNode("person", (node) => node.id.eq("node-0"))
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
  measuredCase: Case,
  result: Readonly<{ milliseconds: number; rows: number }>,
): void {
  console.log(
    `${label} sources=${String(measuredCase.sources).padStart(5)} ` +
      `fanOut=${String(measuredCase.fanOut).padStart(3)} ` +
      `edges=${String(measuredCase.sources * measuredCase.fanOut).padStart(6)} ` +
      `time=${result.milliseconds.toFixed(0).padStart(7)}ms ` +
      `rows=${result.rows}`,
  );
}

describe.runIf(PERF_ENABLED)("current identity traversal scaling", () => {
  it("sqlite", async () => {
    for (const measuredCase of SQLITE_CASES) {
      const { backend } = createLocalSqliteBackend();
      try {
        const store = await provisionFixture(backend, measuredCase);
        reportRow("sqlite  ", measuredCase, await measure(store));
      } finally {
        await backend.close();
      }
    }
  }, 3_600_000);

  it("sqlite single source", async () => {
    for (const measuredCase of SINGLE_SOURCE_CASES) {
      const { backend } = createLocalSqliteBackend();
      try {
        const store = await provisionFixture(backend, measuredCase);
        reportRow("sqlite/1", measuredCase, await measureSingleSource(store));
      } finally {
        await backend.close();
      }
    }
  }, 3_600_000);

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

    it.runIf(databaseUrl !== undefined)(
      "postgres",
      async () => {
        const activePool = pool;
        if (activePool === undefined) return;
        for (const measuredCase of POSTGRES_CASES) {
          const backend = createPostgresBackend(drizzle(activePool));
          const store = await provisionFixture(backend, measuredCase);
          reportRow("postgres", measuredCase, await measure(store));
          await activePool.query(
            "TRUNCATE typegraph_nodes, typegraph_edges, typegraph_identity_assertions, typegraph_identity_closure",
          );
        }
        for (const measuredCase of SINGLE_SOURCE_CASES) {
          const backend = createPostgresBackend(drizzle(activePool));
          const store = await provisionFixture(backend, measuredCase);
          reportRow("pg/1    ", measuredCase, await measureSingleSource(store));
          await activePool.query(
            "TRUNCATE typegraph_nodes, typegraph_edges, typegraph_identity_assertions, typegraph_identity_closure",
          );
        }
      },
      3_600_000,
    );
  });
});
