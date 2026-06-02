/**
 * Adapter contract suite, run against in-process PGlite (Postgres-in-WASM).
 *
 * Part of the PGlite correctness lane: unlike the Docker-gated
 * `postgres-backend.test.ts`, this runs in plain `pnpm test` with zero Docker,
 * so the real PG dialect gets adapter-contract coverage on every CI run. It is
 * the same `createAdapterTestSuite` the Docker lane uses — driver/concurrency
 * behavior stays Docker-only (see `pglite-correctness-harness.ts`).
 *
 * One shared engine is booted per file; data is reset between tests rather than
 * re-booting WASM. `makeBackend()` is a plain backend whose `close()` (called by
 * the suite's `afterEach`) is a client no-op, so the shared engine survives.
 */
import { afterAll, beforeAll, beforeEach } from "vitest";

import { createAdapterTestSuite } from "../adapter-test-suite";
import {
  setupSharedPgliteEngine,
  type SharedPgliteEngine,
} from "./pglite-correctness-harness";

let engine: SharedPgliteEngine;

beforeAll(async () => {
  engine = await setupSharedPgliteEngine();
});

afterAll(async () => {
  await engine.dispose();
});

// Root-level reset runs before the suite's own per-test `beforeEach`
// (which builds the backend), giving every test a clean, migrated schema.
// `truncateVectorTables` is defensive completeness: the adapter contract
// writes no embeddings today, but the reset stays correct if it ever does.
beforeEach(async () => {
  await engine.resetData();
  await engine.truncateVectorTables();
});

createAdapterTestSuite("PGlite", () => engine.makeBackend(), {
  skipRawQueries: false,
});
