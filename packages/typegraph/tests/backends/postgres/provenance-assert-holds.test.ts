/**
 * `assertHolds` / `holding(tx)` on server PostgreSQL: the write-lock behavior
 * that no single-connection backend can observe.
 *
 * - A `retract` and a transaction that derives a fact and asserts it overlap in
 *   both orders; whichever commits second observes the first, and no fact is
 *   ever live while absent from `holding()`.
 * - `assertHolds` takes the schema fence and graph write lock BEFORE the
 *   transaction's first write, so a concurrent retraction waits for it.
 * - `holding()` / `holding(tx)` never write and run read-only, including under a
 *   SELECT-only role; `assertHolds` refuses a read-only transaction.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import {
  FactNotHoldingError,
  UnsupportedBackendCapabilityError,
} from "../../../src/errors-entry";
import { createRetractionCapability } from "../../../src/provenance";
import {
  createGate,
  raceTimeout,
  TIMEOUT_SENTINEL,
} from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const SUITE_NAME = "provenance-assert-holds";
const POOL_MAX_CONNECTIONS = 4;
const BLOCKED_PROBE_MS = 500;
const RANDOMIZED_ITERATIONS = 24;
const MAX_RANDOM_DELAY_MS = 25;
const SELECT_ONLY_ROLE = "tg_assert_holds_select_only";
const SELECT_ONLY_PASSWORD = "select-only-password";

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const Fact = defineNode("Fact", { schema: z.object({ label: z.string() }) });
const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});
const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const graph = defineGraph({
  id: "pg_provenance_assert_holds",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: { type: premiseOf, from: [Source, Fact], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Fact] },
  },
});

const config = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

type Store = Awaited<ReturnType<typeof createGraphStore>>;
type Provenance = ReturnType<
  typeof createRetractionCapability<typeof graph, typeof config>
>;
type Tx = Parameters<Parameters<Store["transaction"]>[0]>[0];
type PremiseRef = Readonly<{ kind: "Source" | "Fact"; id: string }>;

let pool: Pool | undefined;

function requirePool(): Pool {
  if (pool === undefined) {
    throw new Error(`${SUITE_NAME}: pool unavailable after setup succeeded.`);
  }
  return pool;
}

async function createGraphStore(targetPool: Pool) {
  const backend = createPostgresBackend(drizzle(targetPool));
  const [store] = await createAdapterStoreWithSchema(graph, backend, {
    history: true,
  });
  return store;
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: POOL_MAX_CONNECTIONS,
  });
  await runServerSuiteSetup(SUITE_NAME, [candidate], async () => {
    await candidate.query("SELECT 1");
    await candidate.query(`
      DROP TABLE IF EXISTS typegraph_revision_origins CASCADE;
      DROP TABLE IF EXISTS typegraph_recorded_clock CASCADE;
      DROP TABLE IF EXISTS typegraph_recorded_edges CASCADE;
      DROP TABLE IF EXISTS typegraph_recorded_nodes CASCADE;
      DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
      DROP TABLE IF EXISTS typegraph_edges CASCADE;
      DROP TABLE IF EXISTS typegraph_nodes CASCADE;
      DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
    `);
    await candidate.query(generatePostgresMigrationSQL());
    pool = candidate;
  });
});

afterAll(async () => {
  if (pool === undefined) return;
  // The role is cluster-global: drop it even if a test failed half-way.
  await pool.query(`DROP OWNED BY ${SELECT_ONLY_ROLE}`).catch(ignoreRejection);
  await pool.query(`DROP ROLE IF EXISTS ${SELECT_ONLY_ROLE}`);
  await pool.end();
});

beforeEach(async () => {
  if (pool === undefined) return;
  await pool.query(
    `TRUNCATE typegraph_revision_origins,
              typegraph_recorded_clock,
              typegraph_recorded_edges,
              typegraph_recorded_nodes,
              typegraph_node_uniques,
              typegraph_nodes,
              typegraph_edges,
              typegraph_schema_versions CASCADE`,
  );
});

/** `source -> justification -> fact`, so `fact` is held until `source` is retracted. */
async function seedHeldFact(store: Store, name: string) {
  await store.nodes.Source.create(
    { label: name, retracted: false },
    { id: `${name}-source` },
  );
  await store.nodes.Justification.create(
    { label: name },
    { id: `${name}-justification` },
  );
  await store.nodes.Fact.create({ label: name }, { id: `${name}-fact` });
  await store.edges.premiseOf.create(
    { kind: "Source", id: `${name}-source` },
    { kind: "Justification", id: `${name}-justification` },
    {},
    { id: `${name}-premise` },
  );
  await store.edges.derives.create(
    { kind: "Justification", id: `${name}-justification` },
    { kind: "Fact", id: `${name}-fact` },
    {},
    { id: `${name}-derives` },
  );
  return {
    source: { kind: "Source", id: `${name}-source` } as const,
    fact: { kind: "Fact", id: `${name}-fact` } as const,
  };
}

/** Writes `premise -> justification -> derived` and returns the derived fact's ref. */
async function writeDerivation(tx: Tx, premise: PremiseRef, name: string) {
  await tx.nodes.Justification.create(
    { label: name },
    { id: `${name}-justification` },
  );
  await tx.nodes.Fact.create({ label: name }, { id: `${name}-fact` });
  await tx.edges.premiseOf.create(
    premise,
    { kind: "Justification", id: `${name}-justification` },
    {},
    { id: `${name}-premise` },
  );
  await tx.edges.derives.create(
    { kind: "Justification", id: `${name}-justification` },
    { kind: "Fact", id: `${name}-fact` },
    {},
    { id: `${name}-derives` },
  );
  return { kind: "Fact", id: `${name}-fact` } as const;
}

async function expectNoLiveFactOutsideHolding(
  store: Store,
  provenance: Provenance,
) {
  const live = await store.nodes.Fact.find();
  const holding = await provenance.holding();
  const holdingIds = new Set(holding.map((ref) => ref.id));
  const liveUnsupported = live
    .map((fact) => fact.id)
    .filter((id) => !holdingIds.has(id));
  expect(liveUnsupported).toEqual([]);
}

/** Cleanup paths must not mask the failure that brought them here. */
function ignoreRejection(): undefined {
  return;
}

function randomDelay(): Promise<void> {
  const milliseconds = Math.floor(Math.random() * MAX_RANDOM_DELAY_MS);
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe.runIf(process.env["POSTGRES_URL"])(
  "provenance.assertHolds under concurrency (Postgres)",
  () => {
    it("derive commits first: the retraction waits, then closes the fact and names it in died", async () => {
      const store = await createGraphStore(requirePool());
      const provenance = createRetractionCapability(store, config);
      const { source } = await seedHeldFact(store, "seed");

      const deriveWritten = createGate();
      const releaseDerive = createGate();
      const derivation = store.transaction(async (tx) => {
        const summary = await writeDerivation(tx, source, "summary");
        const [held] = await provenance.assertHolds(tx, [summary]);
        expect(held).toEqual({
          fact: summary,
          via: [{ kind: "Justification", id: "summary-justification" }],
        });
        deriveWritten.open();
        await releaseDerive.opened;
      });

      try {
        await deriveWritten.opened;
        const retraction = provenance.retract(source);
        expect(await raceTimeout(retraction, BLOCKED_PROBE_MS)).toBe(
          TIMEOUT_SENTINEL,
        );
        releaseDerive.open();
        await derivation;

        const report = await retraction;
        expect(report.died).toEqual([
          { kind: "Fact", id: "seed-fact" },
          { kind: "Fact", id: "summary-fact" },
        ]);
      } finally {
        releaseDerive.open();
        await derivation.catch(ignoreRejection);
      }

      await expect(
        store.nodes.Fact.getById("summary-fact" as never),
      ).resolves.toBeUndefined();
      await expectNoLiveFactOutsideHolding(store, provenance);
    }, 15_000);

    it("retraction commits first: the assert refuses and nothing from the derivation commits", async () => {
      const store = await createGraphStore(requirePool());
      const provenance = createRetractionCapability(store, config);
      const { source } = await seedHeldFact(store, "seed");

      const retractionDone = createGate();
      const derivation = store.transaction(async (tx) => {
        // The derivation has not written (so holds no lock) until the
        // retraction, which started after it, has committed.
        await retractionDone.opened;
        const summary = await writeDerivation(tx, source, "summary");
        await provenance.assertHolds(tx, [summary]);
      });
      const derivationOutcome = derivation.then(
        ignoreRejection,
        (error: unknown) => error,
      );

      const report = await provenance.retract(source);
      retractionDone.open();

      expect(report.died).toEqual([{ kind: "Fact", id: "seed-fact" }]);
      const error = await derivationOutcome;
      expect(error).toBeInstanceOf(FactNotHoldingError);
      expect((error as FactNotHoldingError).failures).toEqual([
        {
          fact: { kind: "Fact", id: "summary-fact" },
          reason: "no-firing-justification",
          justifications: [
            {
              justification: {
                kind: "Justification",
                id: "summary-justification",
              },
              premises: [
                {
                  premise: { kind: "Source", id: "seed-source" },
                  reason: "retracted",
                },
              ],
            },
          ],
        },
      ]);

      await expect(
        store.nodes.Fact.getById("summary-fact" as never),
      ).resolves.toBeUndefined();
      await expect(
        store.nodes.Justification.getById("summary-justification" as never),
      ).resolves.toBeUndefined();
      await expectNoLiveFactOutsideHolding(store, provenance);
    }, 15_000);

    it("assert before any write takes the lock: a concurrent retraction waits for the transaction", async () => {
      const store = await createGraphStore(requirePool());
      const provenance = createRetractionCapability(store, config);
      const { source, fact } = await seedHeldFact(store, "seed");

      const asserted = createGate();
      const releaseDerive = createGate();
      const derivation = store.transaction(async (tx) => {
        const [held] = await provenance.assertHolds(tx, [fact]);
        expect(held?.fact).toEqual(fact);
        asserted.open();
        await releaseDerive.opened;
        const child = await writeDerivation(tx, fact, "child");
        await provenance.assertHolds(tx, [child]);
      });

      try {
        await asserted.opened;
        const retraction = provenance.retract(source);
        // Without a lock taken by the assert, the retraction would run to
        // completion here, while the derivation has not yet written.
        expect(await raceTimeout(retraction, BLOCKED_PROBE_MS)).toBe(
          TIMEOUT_SENTINEL,
        );
        releaseDerive.open();
        await derivation;

        const report = await retraction;
        expect(report.died).toEqual([
          { kind: "Fact", id: "child-fact" },
          { kind: "Fact", id: "seed-fact" },
        ]);
      } finally {
        releaseDerive.open();
        await derivation.catch(ignoreRejection);
      }

      await expectNoLiveFactOutsideHolding(store, provenance);
    }, 15_000);

    it(`randomized overlap of retract and derive-and-assert (${RANDOMIZED_ITERATIONS} rounds): the second committer observes the first`, async () => {
      const store = await createGraphStore(requirePool());
      const provenance = createRetractionCapability(store, config);
      const outcomes = { refused: 0, committed: 0 };

      for (let round = 0; round < RANDOMIZED_ITERATIONS; round++) {
        const { source } = await seedHeldFact(store, `r${round}`);
        const summaryId = `r${round}-summary-fact`;

        const derivation = (async () => {
          await randomDelay();
          try {
            await store.transaction(async (tx) => {
              const summary = await writeDerivation(
                tx,
                source,
                `r${round}-summary`,
              );
              await provenance.assertHolds(tx, [summary]);
            });
            return "committed" as const;
          } catch (error) {
            if (error instanceof FactNotHoldingError) return "refused" as const;
            throw error;
          }
        })();
        const retraction = (async () => {
          await randomDelay();
          return provenance.retract(source);
        })();

        const [derivationOutcome, report] = await Promise.all([
          derivation,
          retraction,
        ]);
        const diedIds = report.died.map((ref) => ref.id);

        outcomes[derivationOutcome]++;
        const expectedDied =
          derivationOutcome === "refused" ?
            [`r${round}-fact`]
          : [`r${round}-fact`, summaryId].toSorted();
        expect(diedIds).toEqual(expectedDied);
        await expect(
          store.nodes.Fact.getById(summaryId as never),
        ).resolves.toBeUndefined();
        await expectNoLiveFactOutsideHolding(store, provenance);
      }

      expect(outcomes.refused + outcomes.committed).toBe(RANDOMIZED_ITERATIONS);
    }, 60_000);
  },
);

describe.runIf(process.env["POSTGRES_URL"])(
  "provenance.holding and assertHolds access modes (Postgres)",
  () => {
    it("holding(tx) answers inside a read-only transaction", async () => {
      const store = await createGraphStore(requirePool());
      const provenance = createRetractionCapability(store, config);
      const { fact } = await seedHeldFact(store, "seed");

      const believed = await store.transaction((tx) => provenance.holding(tx), {
        accessMode: "read_only",
      });

      expect(believed).toEqual([fact]);
    });

    it("holding() and holding(tx) answer for a SELECT-only role", async () => {
      const store = await createGraphStore(requirePool());
      const { fact } = await seedHeldFact(store, "seed");
      const adminPool = requirePool();
      await adminPool.query(`DROP ROLE IF EXISTS ${SELECT_ONLY_ROLE}`);
      await adminPool.query(
        `CREATE ROLE ${SELECT_ONLY_ROLE} LOGIN PASSWORD '${SELECT_ONLY_PASSWORD}'`,
      );
      await adminPool.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${SELECT_ONLY_ROLE}`,
      );
      const { rows } = await adminPool.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      const databaseName = rows[0]?.name;
      await adminPool.query(
        `GRANT CONNECT ON DATABASE "${databaseName}" TO ${SELECT_ONLY_ROLE}`,
      );

      const roleUrl = new URL(TEST_DATABASE_URL);
      roleUrl.username = SELECT_ONLY_ROLE;
      roleUrl.password = SELECT_ONLY_PASSWORD;
      const rolePool = new Pool({
        connectionString: roleUrl.toString(),
        connectionTimeoutMillis: 5000,
        max: 2,
      });
      try {
        const readerStore = await createGraphStore(rolePool);
        const reader = createRetractionCapability(readerStore, config);

        await expect(reader.holding()).resolves.toEqual([fact]);
        await expect(
          readerStore.transaction((tx) => reader.holding(tx), {
            accessMode: "read_only",
          }),
        ).resolves.toEqual([fact]);
      } finally {
        await rolePool.end();
      }
    });

    it("assertHolds is refused in a read-only transaction before any statement", async () => {
      const store = await createGraphStore(requirePool());
      const provenance = createRetractionCapability(store, config);
      const { fact } = await seedHeldFact(store, "seed");

      const refusal = await store
        .transaction((tx) => provenance.assertHolds(tx, [fact]), {
          accessMode: "read_only",
        })
        .then(ignoreRejection, (error: unknown) => error);

      expect(refusal).toBeInstanceOf(UnsupportedBackendCapabilityError);
      expect(refusal).toMatchObject({
        code: "UNSUPPORTED_BACKEND_CAPABILITY",
        message:
          "provenance.assertHolds() requires backend capability 'write transaction access'.",
      });
    });
  },
);
