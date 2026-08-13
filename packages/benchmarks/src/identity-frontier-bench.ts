/**
 * Bounded #396-shape timing lane: a single identity-expanded hop from one
 * frontier row, against a fixture sized so the CURRENT-coordinate cost stays
 * bounded on the fixed compiler path and only degrades when the identity
 * frontier expansion is seeded back to its pre-317f73d shape (see
 * `src/regression/proof/seeds.ts`, `packages/benchmarks/etc/seeds/
 * identity-frontier-396.patch`).
 *
 * Modeled on `identity-bench.ts`'s private `createResources` pattern —
 * duplicated here rather than extracted, per that file's own precedent
 * (three sibling bench scripts already carry their own copy).
 *
 * Run:
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:identity-frontier
 *   POSTGRES_URL=... pnpm --filter @nicia-ai/typegraph-benchmarks bench:identity-frontier:postgres
 */
import { performance } from "node:perf_hooks";

import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type Store,
} from "@nicia-ai/typegraph";
import {
  createPostgresBackend,
  createPostgresTables,
  generatePostgresMigrationSQL,
} from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createSqliteTables } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";

import { parseCliOptions } from "./cli";
import { getPostgresUrl, type PerfBackend } from "./config";
import { appendHistoryLine } from "./history";
import { resolveGitRefName, resolveGitSha } from "./git";
import { formatMs, median, percentile } from "./utils";

const WARMUP_ITERATIONS = 2;
const SAMPLE_ITERATIONS = 5;
const HOP_OPS = 5;

/** Identity classes the frontier row's own class shares nothing with. */
const UNRELATED_CLASS_COUNT = 9;
/** Members per unrelated class. */
const UNRELATED_CLASS_SIZE = 200;

const FrontierPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const link = defineEdge("link", { schema: z.object({}) });

function buildFrontierGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: { Person: { type: FrontierPerson } },
    edges: {
      link: { type: link, from: [FrontierPerson], to: [FrontierPerson] },
    },
    identity: { sameIdAcrossKinds: "ignore" },
  });
}

type FrontierGraph = ReturnType<typeof buildFrontierGraph>;

type Resources = Readonly<{
  backend: GraphBackend;
  close: () => Promise<void>;
}>;

const POSTGRES_RESET_DDL = `
  DO $$
  DECLARE tbl text;
  BEGIN
    FOR tbl IN
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'typegraph_%'
    LOOP
      EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', tbl);
    END LOOP;
  END $$;
`;

async function createResources(backendName: PerfBackend): Promise<Resources> {
  if (backendName === "sqlite") {
    const tables = createSqliteTables({});
    const { backend } = createLocalSqliteBackend({ tables });
    return { backend, close: async () => backend.close() };
  }

  const pool = new Pool({ connectionString: getPostgresUrl() });
  await pool.query(POSTGRES_RESET_DDL);
  const tables = createPostgresTables({});
  await pool.query(generatePostgresMigrationSQL(tables));
  const backend = createPostgresBackend(drizzleNodePostgres(pool), { tables });
  return {
    backend,
    close: async () => {
      await backend.close();
      await pool.end();
    },
  };
}

type Sample = Readonly<{
  median: number;
  p95: number;
  samples: readonly number[];
  opsPerSample: number;
}>;

async function measure(
  opsPerSample: number,
  run: () => Promise<void>,
): Promise<Sample> {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    await run();
  }
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_ITERATIONS; index += 1) {
    const startedAt = performance.now();
    await run();
    samples.push((performance.now() - startedAt) / opsPerSample);
  }
  return {
    median: median(samples),
    p95: percentile(samples, 0.95),
    samples,
    opsPerSample,
  };
}

function printSample(label: string, sample: Sample): void {
  console.log(
    `${label.padEnd(38)} ${formatMs(sample.median).padStart(8)}/op  p95 ${formatMs(sample.p95).padStart(8)}/op  (${sample.opsPerSample} ops/sample)`,
  );
}

/**
 * Seeds one frontier row (`start`) with two identity peers, one of which
 * (`start-peer`) carries the only outgoing `link` edge to `target` — so
 * nothing is reachable without identity expansion widening the frontier to
 * the peer first — plus `UNRELATED_CLASS_COUNT` identity classes of
 * `UNRELATED_CLASS_SIZE` members each that the frontier never touches. This
 * is the same shape `tests/perf/explain/identity-frontier-expansion.test.ts`
 * pins deterministically; this lane measures its wall-clock cost instead.
 */
async function seedFrontier(store: Store<FrontierGraph>): Promise<void> {
  const nodes = [
    { id: "start", props: { name: "start" } },
    { id: "start-peer", props: { name: "start-peer" } },
    { id: "start-peer-two", props: { name: "start-peer-two" } },
    { id: "target", props: { name: "target" } },
    ...Array.from(
      { length: UNRELATED_CLASS_COUNT * UNRELATED_CLASS_SIZE },
      (unused, index) => ({
        id: `unrelated-${index}`,
        props: { name: `unrelated-${index}` },
      }),
    ),
  ];
  await store.nodes.Person.bulkCreate(nodes);
  await store.edges.link.bulkCreate([
    {
      from: { id: "start-peer", kind: "Person" as const },
      id: "link-peer-target",
      props: {},
      to: { id: "target", kind: "Person" as const },
    },
  ]);
  const pairs = [
    {
      a: { id: "start", kind: "Person" as const },
      b: { id: "start-peer", kind: "Person" as const },
    },
    {
      a: { id: "start", kind: "Person" as const },
      b: { id: "start-peer-two", kind: "Person" as const },
    },
  ];
  for (
    let classIndex = 0;
    classIndex < UNRELATED_CLASS_COUNT;
    classIndex += 1
  ) {
    const first = classIndex * UNRELATED_CLASS_SIZE;
    for (let member = 1; member < UNRELATED_CLASS_SIZE; member += 1) {
      pairs.push({
        a: { id: `unrelated-${first}`, kind: "Person" as const },
        b: { id: `unrelated-${first + member}`, kind: "Person" as const },
      });
    }
  }
  await store.identity.bulkAssertSame(pairs);
}

function frontierHop(store: Store<FrontierGraph>) {
  return store
    .query()
    .from("Person", "person")
    .whereNode("person", (node) => node.id.eq("start"))
    .traverse("link", "edge", {
      expand: "none",
      includeIdentityMembers: true,
    })
    .to("Person", "friend")
    .select((context) => context.friend.id);
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseCliOptions(argv);
  const resources = await createResources(options.backend);
  console.log(
    `TypeGraph identity-frontier bench (backend=${options.backend}, ` +
      `warmup=${WARMUP_ITERATIONS}, samples=${SAMPLE_ITERATIONS}, ` +
      `hopOps=${HOP_OPS}, unrelatedClasses=${UNRELATED_CLASS_COUNT}x${UNRELATED_CLASS_SIZE})`,
  );

  try {
    const graph = buildFrontierGraph("bench_identity_frontier");
    const [store] = await createStoreWithSchema(graph, resources.backend);
    await seedFrontier(store);
    await store.refreshStatistics();

    const rows = await frontierHop(store).execute();
    if (rows.length !== 1 || rows[0] !== "target") {
      throw new Error(
        `Frontier hop returned ${JSON.stringify(rows)}, expected ["target"]`,
      );
    }

    const results = new Map<string, Sample>();

    const currentQuery = frontierHop(store);
    const currentSample = await measure(HOP_OPS, async () => {
      for (let index = 0; index < HOP_OPS; index += 1) {
        await currentQuery.execute();
      }
    });
    results.set("identity-frontier:current-hop", currentSample);
    printSample("identity-frontier:current-hop", currentSample);

    // Control: the SAME hop, pinned to a valid-time coordinate after seeding.
    // The seed only reverts the CURRENT-coordinate compilation path, so this
    // label must not move under the seed — reported, not gated, since
    // gating a control on noise is brittle.
    const historicalInstant = new Date().toISOString();
    const historicalQuery = store
      .asOf(historicalInstant)
      .query()
      .from("Person", "person")
      .whereNode("person", (node) => node.id.eq("start"))
      .traverse("link", "edge", {
        expand: "none",
        includeIdentityMembers: true,
      })
      .to("Person", "friend")
      .select((context) => context.friend.id);
    const historicalRows = await historicalQuery.execute();
    if (historicalRows.length !== 1 || historicalRows[0] !== "target") {
      throw new Error(
        `Historical frontier hop returned ${JSON.stringify(historicalRows)}, expected ["target"]`,
      );
    }
    const historicalSample = await measure(HOP_OPS, async () => {
      for (let index = 0; index < HOP_OPS; index += 1) {
        await historicalQuery.execute();
      }
    });
    results.set("identity-frontier:historical-hop", historicalSample);
    printSample("identity-frontier:historical-hop", historicalSample);

    const measurements = Object.fromEntries(
      [...results].map(([label, sample]) => [
        label,
        {
          median: Number(sample.median.toFixed(6)),
          p95: Number(sample.p95.toFixed(6)),
          samples: sample.samples.map((value) => Number(value.toFixed(6))),
          opsPerSample: sample.opsPerSample,
        },
      ]),
    );
    const historyPath = appendHistoryLine({
      timestamp: new Date().toISOString(),
      gitSha: resolveGitSha(),
      gitRefName: resolveGitRefName(),
      lane: "identity-frontier",
      backend: options.backend,
      warmupIterations: WARMUP_ITERATIONS,
      sampleIterations: SAMPLE_ITERATIONS,
      seedRowsPerKind: UNRELATED_CLASS_COUNT * UNRELATED_CLASS_SIZE,
      measurements,
    });
    console.log(`\nappended run to ${historyPath}`);
  } finally {
    await resources.close();
  }
}

await main(process.argv.slice(2));
