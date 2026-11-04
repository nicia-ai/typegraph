/**
 * `import(export(store))` over random composition + identity histories.
 *
 * The source runs a random history (see `interchange-composition-model.ts`):
 * parts of every population/existence pairing created, reparented and
 * detached at fixed past instants, ended and soft-deleted edges, cascading
 * deletes, refused cycles and second wholes, and — on the identity graph —
 * `assertSame` / `assertDifferent` / retractions with the transition log on.
 * Its default export (`identityMode: "archival"` on the identity graph) is
 * imported into a fresh store, and the two stores must agree on:
 *
 * - every live row WITH its validity window, uniqueness reservations, and
 *   edge claim rows (`dumpRoundTripState`);
 * - the identity ledger — assertions, closure, separation — and the source's
 *   transition log, restored on the target;
 * - `planDelete` of every whole, and `parts()` / `wholes()` /
 *   `subgraph({ composition: true })` now and at sampled past coordinates.
 *
 * The oracle is the source store itself: an independent model of composition
 * would have to re-derive the cascade, the claim axes and the identity closure;
 * the round trip only has to preserve whatever the source decided.
 *
 * MUTATION CHECK (each verified and reverted):
 * - `requiredTemporalFields` (src/interchange/export.ts) answering
 *   `undefined` for an active-only graph — the default export drops every
 *   `validTo`, so an ended `oneActive` row re-imports as current.
 * - skipping `produceIdentityTransitionChunks` in an archival export — the
 *   target restores no transition the source logged.
 * - dropping `validFrom: window.validFrom` from the current-assertion insert
 *   in `importIdentityAssertionsIntoTarget`
 *   (src/identity/service-interchange-write.ts) — every imported assertion
 *   then opens at the import instant instead of its own.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createStoreWithSchema } from "../../src";
import { createTestBackend } from "../test-utils";
import {
  buildRoundTripGraph,
  checkRoundTrip,
  historyArb,
  type RoundTripStore,
} from "./interchange-composition-model";
import { propertyRuns } from "./run-budget";

async function createSqliteStore(identity: boolean): Promise<RoundTripStore> {
  const graph = buildRoundTripGraph({
    id: "interchange_composition_roundtrip",
    identity,
  });
  const [store] = await createStoreWithSchema(
    graph,
    createTestBackend(),
    identity ? { history: true } : undefined,
  );
  return store;
}

describe("interchange round trip over composition and identity histories", () => {
  for (const identity of [false, true]) {
    it(`import(export(store)) preserves rows, windows, claims, ${identity ? "the identity ledger, " : ""}and composition reads`, async () => {
      let applied = 0;
      let refused = 0;
      await fc.assert(
        fc.asyncProperty(historyArb(identity), async (history) => {
          const outcome = await checkRoundTrip(history, {
            identity,
            createStore: createSqliteStore,
          });
          applied += outcome.applied;
          refused += outcome.refused;
        }),
        { numRuns: propertyRuns({ ci: 25, local: 40 }) },
      );
      // A history that every store refused would round-trip trivially.
      expect(applied).toBeGreaterThan(refused / 2);
    }, 120_000);
  }
});
