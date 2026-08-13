/**
 * T13 — the decision-threading pattern: a verdict is resolved ONCE against
 * `GraphBackend` and threaded; binding happens locally, off whichever port
 * the call site holds, and the bound value is `===` the port's own member.
 *
 * (a) types `resolveBundle(tx, …)` as a compile error — a transaction port
 * is not where the support question is answered.
 * (b) pins the pattern behaviorally: resolve at entry, enter
 * `store.transaction()`, bind through the bundle's member accessor inside —
 * the verdict is `toBe`-identical and each bound member is `===` the
 * corresponding transaction member.
 *
 * B6 ships no production call site that threads a verdict through
 * `store.transaction()` — this test PINS the pattern; B7/B8 anchor it in
 * production code (`claimSupport`'s move onto the framework, and the
 * `uniqueSidecarBatch`/`batchPointRead` call sites).
 */
import { describe, expect, it } from "vitest";

import { claimsMembers } from "../src/backend/capabilities/bind";
import { CONTRIBUTION_HEALTH } from "../src/backend/capabilities/bundle-registry";
import {
  claimsVerdict,
  resolveBundle,
} from "../src/backend/capabilities/resolve";
import { type TransactionBackend } from "../src/backend/types";
import { createTestBackend } from "./test-utils";

describe("capability decision threading (T13)", () => {
  it("(a) resolveBundle refuses a TransactionBackend at the type level", () => {
    const backend = createTestBackend();
    return backend.transaction((tx: TransactionBackend) => {
      // @ts-expect-error — a transaction port is not where the support
      // question is answered (ruling B1/B-3); this directive is USED, not
      // decorative, because `tx` really is assignable to `TransactionBackend`.
      resolveBundle(tx, CONTRIBUTION_HEALTH);
      return Promise.resolve();
    });
  });

  it("(b) the verdict resolved at entry threads reference-identically into a transaction, and binds off the transaction's own members", async () => {
    const backend = createTestBackend();
    const verdict = claimsVerdict(backend);
    expect(verdict.supported).toBe(true);
    if (!verdict.supported) throw new Error("expected claims to be supported");

    await backend.transaction((tx) => {
      // What a call site that RE-RESOLVED instead of threading would hold
      // here: `resolveBundle` builds a fresh verdict object literal on
      // every call (no memoization — see `resolve.ts`), so re-resolving
      // produces a DISTINCT object even though its fields are structurally
      // identical to `verdict`. This is the failing case T13(b)'s own
      // design note names ("re-resolve inside the transaction body instead
      // of threading -> the reference check fails"), made concrete rather
      // than compared against itself.
      const reResolvedVerdict = claimsVerdict(backend);
      expect(reResolvedVerdict).not.toBe(verdict);

      // The pattern under test: the body threads the SAME verdict object
      // resolved at entry, not the freshly re-resolved one above.
      // (Mutation check: replace the line below with
      // `const threadedVerdict = reResolvedVerdict;` — RED, restored.)
      const threadedVerdict = verdict;
      expect(threadedVerdict).toBe(verdict);
      expect(threadedVerdict).not.toBe(reResolvedVerdict);
      const binding = claimsMembers(tx, threadedVerdict);
      expect(binding.claimEdgeCardinality).toBe(tx.claimEdgeCardinality);
      expect(binding.claimEdgeCardinalityBatch).toBe(
        tx.claimEdgeCardinalityBatch,
      );
      expect(binding.purgeEdgeClaims).toBe(tx.purgeEdgeClaims);
      expect(binding.hardDeleteUniquesByConcreteKind).toBe(
        tx.hardDeleteUniquesByConcreteKind,
      );
      return Promise.resolve();
    });
  });
});
