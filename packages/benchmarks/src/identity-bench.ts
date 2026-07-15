/**
 * Operational Identity benchmark lane.
 *
 * Extends the shared benchmark history with enabled-path measurements and the
 * folding-probe experiment used to decide whether `(graph_id, id)` belongs in
 * the permanent nodes index set. The index is created only inside this bench.
 *
 * Run:
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:identity
 *   POSTGRES_URL=... pnpm --filter @nicia-ai/typegraph-benchmarks bench:identity:postgres
 */
import { performance } from "node:perf_hooks";

import { sql } from "drizzle-orm";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";
import {
  asCompiledRowsSql,
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "@nicia-ai/typegraph";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "@nicia-ai/typegraph/interchange";
import {
  createPostgresBackend,
  createPostgresTables,
  generatePostgresMigrationSQL,
} from "@nicia-ai/typegraph/postgres";
import { createSqliteTables } from "@nicia-ai/typegraph/sqlite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";

import { parseCliOptions } from "./cli";
import { getPostgresUrl, type PerfBackend } from "./config";
import { appendHistoryLine } from "./history";
import { resolveGitRefName, resolveGitSha } from "./git";
import { formatMs, median, percentile } from "./utils";

const WARMUP_ITERATIONS = 2;
const SAMPLE_ITERATIONS = 7;
const SEED_ROWS_PER_KIND = 100;
const WRITE_OPS = 20;
const READ_OPS = 50;
const HISTORICAL_READ_OPS = 10;

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Author = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});
const knows = defineEdge("knows");

function buildGraphFields(graphId: string) {
  return {
    id: graphId,
    nodes: { Person: { type: Person }, Author: { type: Author } },
    edges: {
      knows: {
        type: knows,
        from: [Person, Author],
        to: [Person, Author],
        cardinality: "many" as const,
      },
    },
  } as const;
}

function buildIdentityGraph(graphId: string) {
  return defineGraph({
    ...buildGraphFields(graphId),
    identity: { sameIdAcrossKinds: "fold" },
  });
}

function buildDisabledGraph(graphId: string) {
  return defineGraph(buildGraphFields(graphId));
}

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
  prepare: () => Promise<() => Promise<void>>,
): Promise<Sample> {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    await (
      await prepare()
    )();
  }
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_ITERATIONS; index += 1) {
    const run = await prepare();
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

function buildImportPayload(run: number): GraphData {
  const now = new Date().toISOString();
  const ids = Array.from(
    { length: 50 },
    (_, index) => `import-${run}-${index}`,
  );
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: now,
    source: { type: "external", description: "identity benchmark" },
    nodes: ids.flatMap((id) => [
      { kind: "Person", id: `person-${id}`, properties: { name: id } },
      { kind: "Author", id: `author-${id}`, properties: { penName: id } },
    ]),
    edges: [],
    identity: {
      profile: "typegraph-identity-v1",
      mode: "state",
      assertions: ids.map((id, index) => ({
        id: `assertion-${run}-${index}`,
        relation: "same" as const,
        a: { kind: "Author", id: `author-${id}` },
        b: { kind: "Person", id: `person-${id}` },
        validFrom: now,
      })),
    },
  };
}

async function seedIdentityStore(backend: GraphBackend) {
  const graph = buildIdentityGraph("perf_identity");
  const [store] = await createStoreWithSchema(graph, backend);
  await store.nodes.Person.bulkCreate(
    Array.from({ length: SEED_ROWS_PER_KIND }, (_, index) => ({
      props: { name: `person-${index}` },
      id: `person-${index}`,
    })),
  );
  await store.nodes.Author.bulkCreate(
    Array.from({ length: SEED_ROWS_PER_KIND }, (_, index) => ({
      props: { penName: `author-${index}` },
      id: `author-${index}`,
    })),
  );
  return { graph, store };
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseCliOptions(argv);
  const resources = await createResources(options.backend);
  console.log(
    `TypeGraph identity bench (backend=${options.backend}, warmup=${WARMUP_ITERATIONS}, samples=${SAMPLE_ITERATIONS})`,
  );

  try {
    const { graph, store } = await seedIdentityStore(resources.backend);
    const results = new Map<string, Sample>();
    let counter = 0;
    async function record(
      label: string,
      ops: number,
      prepare: () => Promise<() => Promise<void>>,
    ): Promise<void> {
      const sample = await measure(ops, prepare);
      results.set(label, sample);
      printSample(label, sample);
    }

    await record("identity:store-create", 1000, async () => async () => {
      for (let index = 0; index < 1000; index += 1) {
        createStore(graph, resources.backend);
      }
    });

    const disabledControlGraph = buildDisabledGraph(
      "perf_identity_disabled_control",
    );
    const [disabledControlStore] = await createStoreWithSchema(
      disabledControlGraph,
      resources.backend,
    );
    const disabledControlNode = await disabledControlStore.nodes.Person.create(
      { name: "disabled-control" },
      { id: "disabled-control" },
    );
    await record(
      "identity:disabled-store-create",
      1000,
      async () => async () => {
        for (let index = 0; index < 1000; index += 1) {
          createStore(disabledControlGraph, resources.backend);
        }
      },
    );
    await record("identity:disabled-property-update", READ_OPS, async () => {
      const start = counter;
      counter += READ_OPS;
      return async () => {
        for (let index = 0; index < READ_OPS; index += 1) {
          await disabledControlStore.nodes.Person.update(
            disabledControlNode.id,
            { name: `disabled-update-${start + index}` },
          );
        }
      };
    });

    await record("identity:folding-create", WRITE_OPS, async () => {
      const ids = Array.from({ length: WRITE_OPS }, () => {
        counter += 1;
        return `fold-${counter}`;
      });
      await store.nodes.Author.bulkCreate(
        ids.map((id) => ({ props: { penName: id }, id })),
      );
      return async () => {
        for (const id of ids) {
          await store.nodes.Person.create({ name: id }, { id });
        }
      };
    });

    await record("identity:closure-assert-retract", WRITE_OPS * 2, async () => {
      const pairs = Array.from({ length: WRITE_OPS }, () => {
        counter += 1;
        return {
          person: `same-person-${counter}`,
          author: `same-author-${counter}`,
        };
      });
      await store.nodes.Person.bulkCreate(
        pairs.map(({ person }) => ({
          props: { name: person },
          id: person,
        })),
      );
      await store.nodes.Author.bulkCreate(
        pairs.map(({ author }) => ({
          props: { penName: author },
          id: author,
        })),
      );
      return async () => {
        for (const pair of pairs) {
          const assertion = await store.identity.assertSame(
            { kind: "Person", id: pair.person },
            { kind: "Author", id: pair.author },
          );
          await store.identity.retractAssertion(assertion.id);
        }
      };
    });

    const anchor = await store.nodes.Person.create(
      { name: "read-anchor" },
      { id: "read-anchor" },
    );
    const alias = await store.nodes.Author.create(
      { penName: "read-alias" },
      { id: "read-alias" },
    );
    await store.identity.assertSame(anchor, alias);
    const historicalInstant = new Date().toISOString();
    await record(
      "identity:current-class-read",
      READ_OPS,
      async () => async () => {
        for (let index = 0; index < READ_OPS; index += 1) {
          await store.identity.membersOf(anchor);
        }
      },
    );
    await record(
      "identity:historical-class-read",
      HISTORICAL_READ_OPS,
      async () => async () => {
        for (let index = 0; index < HISTORICAL_READ_OPS; index += 1) {
          await store.asOf(historicalInstant).identity.membersOf(anchor);
        }
      },
    );

    const friend = await store.nodes.Person.create(
      { name: "read-friend" },
      { id: "read-friend" },
    );
    await store.edges.knows.create(alias, friend, {}, { id: "read-edge" });
    const expandedQuery = store
      .query()
      .from("Person", "person")
      .whereNode("person", (node) => node.id.eq(anchor.id))
      .traverse("knows", "edge", {
        expand: "none",
        includeIdentityMembers: true,
      })
      .to("Person", "friend")
      .select((context) => context.friend.id);
    await record(
      "identity:expanded-traversal",
      READ_OPS,
      async () => async () => {
        for (let index = 0; index < READ_OPS; index += 1) {
          await expandedQuery.execute();
        }
      },
    );

    await record("identity:import", 150, async () => {
      counter += 1;
      const payload = buildImportPayload(counter);
      return async () => {
        const result = await importGraph(store, payload, {
          onConflict: "error",
          refreshStatistics: false,
        });
        if (!result.success) throw new Error("Identity import failed");
      };
    });

    await record("identity:graph-lock-contention", 8, async () => {
      const pairs = Array.from({ length: 8 }, () => {
        counter += 1;
        return {
          person: `lock-person-${counter}`,
          author: `lock-author-${counter}`,
        };
      });
      await store.nodes.Person.bulkCreate(
        pairs.map(({ person }) => ({ props: { name: person }, id: person })),
      );
      await store.nodes.Author.bulkCreate(
        pairs.map(({ author }) => ({
          props: { penName: author },
          id: author,
        })),
      );
      return async () => {
        await Promise.all(
          pairs.map(async (pair) =>
            store.identity.assertSame(
              { kind: "Person", id: pair.person },
              { kind: "Author", id: pair.author },
            ),
          ),
        );
      };
    });

    await record("identity:enablement-scan", 1, async () => {
      counter += 1;
      const graphId = `identity-enablement-${counter}`;
      const disabled = buildDisabledGraph(graphId);
      const [disabledStore] = await createStoreWithSchema(
        disabled,
        resources.backend,
      );
      await disabledStore.nodes.Person.bulkCreate(
        Array.from({ length: SEED_ROWS_PER_KIND }, (_, index) => ({
          props: { name: `person-${index}` },
          id: `shared-${index}`,
        })),
      );
      await disabledStore.nodes.Author.bulkCreate(
        Array.from({ length: SEED_ROWS_PER_KIND }, (_, index) => ({
          props: { penName: `author-${index}` },
          id: `shared-${index}`,
        })),
      );
      const enabled = buildIdentityGraph(graphId);
      return async () => {
        await createStoreWithSchema(enabled, resources.backend);
      };
    });

    const nodesTableName =
      resources.backend.tableNames?.nodes ?? "typegraph_nodes";
    const nodesTable = sql.raw(nodesTableName);
    async function probeByKind(): Promise<void> {
      for (const kind of ["Person", "Author"] as const) {
        await resources.backend.execute(
          asCompiledRowsSql(sql`
            SELECT id FROM ${nodesTable}
            WHERE graph_id = ${graph.id} AND kind = ${kind}
              AND id = ${"person-0"} AND deleted_at IS NULL
          `),
        );
      }
    }
    async function probeGlobally(): Promise<void> {
      await resources.backend.execute(
        asCompiledRowsSql(sql`
          SELECT kind, id FROM ${nodesTable}
          WHERE graph_id = ${graph.id} AND id = ${"person-0"}
            AND deleted_at IS NULL
        `),
      );
    }
    await record(
      "identity:fold-probe-per-kind",
      READ_OPS,
      async () => async () => {
        for (let index = 0; index < READ_OPS; index += 1) await probeByKind();
      },
    );

    const disabledIndexGraph = buildDisabledGraph("perf_disabled_index_tax");
    const [disabledIndexStore] = await createStoreWithSchema(
      disabledIndexGraph,
      resources.backend,
    );
    await record("identity:index-tax-create-before", WRITE_OPS, async () => {
      const start = counter;
      counter += WRITE_OPS;
      return async () => {
        for (let index = 0; index < WRITE_OPS; index += 1) {
          const id = `index-before-${start + index}`;
          await disabledIndexStore.nodes.Person.create({ name: id }, { id });
        }
      };
    });
    await resources.backend.executeDdl?.(
      `CREATE INDEX typegraph_nodes_graph_id_id_bench ON ${nodesTableName} (graph_id, id)`,
    );
    await record(
      "identity:fold-probe-global-index",
      READ_OPS,
      async () => async () => {
        for (let index = 0; index < READ_OPS; index += 1) await probeGlobally();
      },
    );
    await record("identity:index-tax-create-after", WRITE_OPS, async () => {
      const start = counter;
      counter += WRITE_OPS;
      return async () => {
        for (let index = 0; index < WRITE_OPS; index += 1) {
          const id = `index-after-${start + index}`;
          await disabledIndexStore.nodes.Person.create({ name: id }, { id });
        }
      };
    });

    const report = Object.fromEntries(
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
      lane: "identity",
      backend: options.backend,
      warmupIterations: WARMUP_ITERATIONS,
      sampleIterations: SAMPLE_ITERATIONS,
      seedRowsPerKind: SEED_ROWS_PER_KIND,
      measurements: report,
    });
    console.log(`\nappended run to ${historyPath}`);
  } finally {
    await resources.close();
  }
}

await main(process.argv.slice(2));
