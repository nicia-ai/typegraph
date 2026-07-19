/**
 * Integration / SQL-correctness suite, run against in-process PGlite.
 *
 * Part of the PGlite correctness lane: the same `createIntegrationTestSuite` the
 * Docker lane runs (predicates, aggregates, ordering, traversals, recursive
 * CTEs, fulltext/tsvector, cross-backend consistency, …), now exercising the
 * real PG dialect on every `pnpm test` with zero Docker. Driver/concurrency
 * behavior stays Docker-only (see `pglite-correctness-harness.ts`).
 *
 * Split from the adapter suite into its own file so the two heaviest reused
 * suites run on separate vitest workers (parallel files) rather than one serial
 * long-pole. One shared engine per file; data is reset between tests.
 */
import { afterAll, beforeAll, beforeEach } from "vitest";

import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { createIntegrationTestSuite } from "../integration-test-suite";
import {
  setupSharedPgliteEngine,
  type SharedPgliteEngine,
} from "./pglite-correctness-harness";

let engine: SharedPgliteEngine;

beforeAll(async () => {
  engine = await setupSharedPgliteEngine();
});

afterAll(async () => {
  const leakedWorkingTables = await engine.makeBackend().execute(
    asCompiledRowsSql(sql`
      SELECT relation.relname
      FROM pg_catalog.pg_class relation
      WHERE relation.relpersistence = 't'
        AND relation.relname LIKE 'typegraph_iterative_%'
    `),
  );
  if (leakedWorkingTables.length > 0) {
    throw new Error(
      `Iterative graph operations leaked temporary tables: ${JSON.stringify(leakedWorkingTables)}`,
    );
  }
  await engine.dispose();
});

// The integration suite builds the store in its own `beforeEach`, so the
// root-level reset here is the correct lifecycle: clear state first, then the
// suite bootstraps the schema on the shared engine. `truncateVectorTables`
// keeps the reset complete for the shared fixture's vector-capable `Article`
// embedding field, which a future hybrid-search test could exercise.
beforeEach(async () => {
  await engine.resetData();
  await engine.truncateVectorTables();
});

// No `cleanup` is returned: closing per test would dispose nothing useful (the
// backend close is a no-op) and the engine must survive for the next test.
createIntegrationTestSuite("PGlite", () => ({ backend: engine.makeBackend() }));
