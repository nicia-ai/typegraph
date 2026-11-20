/**
 * The interchange round-trip property (tests/property/
 * interchange-composition-roundtrip.test.ts) on PGlite: the PostgreSQL dialect
 * renders every claim, window comparison and identity write the round trip
 * depends on, so the same histories must round-trip there too. A smaller
 * budget than the SQLite lane — each run leases two fresh schemas.
 */
import fc from "fast-check";
import { afterAll, describe, it } from "vitest";

import { createStoreWithSchema } from "../../../src";
import { createPgliteFixturePool } from "../../graph-merge/pglite-fixture-pool";
import {
  buildRoundTripGraph,
  checkRoundTrip,
  historyArb,
  type RoundTripStore,
} from "../../property/interchange-composition-model";
import { propertyRuns } from "../../property/run-budget";

const pool = createPgliteFixturePool();

afterAll(async () => {
  await pool.dispose();
});

describe("interchange round trip over composition and identity histories (PGlite)", () => {
  for (const identity of [false, true]) {
    it(`import(export(store)) preserves rows, windows, claims, ${identity ? "the identity ledger, " : ""}and composition reads`, async () => {
      await fc.assert(
        fc.asyncProperty(historyArb(identity), async (history) => {
          const cleanups: (() => Promise<void>)[] = [];
          async function createStore(
            withIdentity: boolean,
          ): Promise<RoundTripStore> {
            const fixture = await pool.makeFixture();
            cleanups.push(fixture.cleanup);
            const [store] = await createStoreWithSchema(
              buildRoundTripGraph({
                id: "interchange_composition_roundtrip",
                identity: withIdentity,
              }),
              fixture.backend,
              withIdentity ? { history: true } : undefined,
            );
            return store;
          }
          try {
            await checkRoundTrip(history, { identity, createStore });
          } finally {
            for (const cleanup of cleanups) await cleanup();
          }
        }),
        { numRuns: propertyRuns({ ci: 6, local: 10 }) },
      );
    }, 240_000);
  }
});
