/**
 * The `identity` merge-options bag: normalization defaults, the `.strict()`
 * scalar validation, the `onAssertionConflict` function/string split, the
 * refusal of every value the merge cannot honor, and — the compatibility hinge
 * — that `normalizeMergeOptions` emits the field ONLY when the caller stated
 * `identity`, so a review artifact captured before this option existed keeps
 * revalidating `compatible`.
 *
 * The governed-merge promise runs through here: `reviewOptionEvidence` encodes
 * what `normalizeMergeOptions` emits, so a policy inside the bag is inside the
 * review digest, and an applier that changed it is refused.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import {
  captureCandidateWriteSetTarget,
  planCandidateWriteSetReview,
  revalidateCandidateWriteSetReview,
  unwrap,
} from "../../src/graph-merge";
import {
  MERGE_OPTION_DEFAULTS,
  normalizeMergeOptions,
} from "../../src/graph-merge/options";
import { reviewOptionEvidence } from "../../src/graph-merge/review-evidence";
import type { IdentityReconciliationOptions } from "../../src/graph-merge/types";

describe("T7 — presence-preserving normalization", () => {
  it("omits `identity` entirely when the caller never stated it", () => {
    const normalized = normalizeMergeOptions({});
    expect("identity" in normalized).toBe(false);
  });

  it("fully resolves `identity` once the caller states it, even as `{}`", () => {
    const normalized = normalizeMergeOptions({ identity: {} });
    expect(normalized.identity).toEqual(MERGE_OPTION_DEFAULTS.identity);
  });

  it("an identity-free options bag's review evidence is unaffected by the new field existing", () => {
    // The digest an old review artifact was captured against, and the digest
    // a caller who never heard of `identity` produces today, must be
    // IDENTICAL — otherwise every stored review artifact from before this
    // release would revalidate `changed` for no stated reason.
    const withoutIdentityField = reviewOptionEvidence({});
    const jsonString = JSON.stringify(withoutIdentityField);
    expect(jsonString.includes('"identity"')).toBe(false);
  });

  it("mutation check: emitting the defaulted bag unconditionally breaks presence-preservation", () => {
    // Simulates the regression this test guards against directly against the
    // normalizer, without needing to re-run the whole suite under a patched
    // build: an unconditional emission is exactly `{ ...normalizeMergeOptions({}), identity: MERGE_OPTION_DEFAULTS.identity }`.
    const wronglyUnconditional = {
      ...normalizeMergeOptions({}),
      identity: MERGE_OPTION_DEFAULTS.identity,
    };
    expect("identity" in wronglyUnconditional).toBe(true);
    // ...which is exactly what the real (correct) normalizer must NOT do.
    expect("identity" in normalizeMergeOptions({})).toBe(false);
  });
});

describe("T6 (options layer) — policy is part of the review evidence", () => {
  it("two different onAssertionConflict policies encode to different evidence", () => {
    const assertWinsEvidence = reviewOptionEvidence({
      identity: { pairing: "candidate", onAssertionConflict: "assertWins" },
    });
    const retractWinsEvidence = reviewOptionEvidence({
      identity: { pairing: "candidate", onAssertionConflict: "retractWins" },
    });
    expect(assertWinsEvidence).not.toEqual(retractWinsEvidence);
  });

  it("a function policy encodes as a callback marker, not its source", () => {
    const evidence = reviewOptionEvidence({
      identity: {
        pairing: "candidate",
        onAssertionConflict: () => ({ kind: "unresolved" as const }),
      },
    });
    expect(JSON.stringify(evidence)).toContain('"callback"');
  });
});

describe("§3.3 refusal matrix — identity option validation", () => {
  it("refuses an unrecognized identity sub-option (typo)", () => {
    expect(() =>
      normalizeMergeOptions({
        // @ts-expect-error deliberately malformed to prove `.strict()` catches it
        identity: { pairign: "candidate" },
      }),
    ).toThrow();
  });

  it("refuses an unrecognized onAssertionConflict string", () => {
    expect(() =>
      normalizeMergeOptions({
        // @ts-expect-error deliberately invalid enum value
        identity: { onAssertionConflict: "yolo" },
      }),
    ).toThrow(/onAssertionConflict/);
  });

  it("refuses an unrecognized pairing mode", () => {
    expect(() =>
      normalizeMergeOptions({
        // @ts-expect-error deliberately invalid enum value
        identity: { pairing: "everything" },
      }),
    ).toThrow();
  });

  // Applied or refused, never ignored: both `"flag"` arms mean "drop the
  // identity pairing", which needs a plan rebuild this release does not do.
  // Accepting them and silently applying the default would be the API lying.
  it("refuses onEdgeConflict: flag, naming what is missing", () => {
    expect(() =>
      normalizeMergeOptions({ identity: { onEdgeConflict: "flag" } }),
    ).toThrow(/onEdgeConflict/);
  });

  it("refuses onUniquenessConflict: flag, naming what is missing", () => {
    expect(() =>
      normalizeMergeOptions({ identity: { onUniquenessConflict: "flag" } }),
    ).toThrow(/onUniquenessConflict/);
  });

  it("accepts every arm it does honor", () => {
    const normalized = normalizeMergeOptions({
      identity: {
        pairing: "definitional",
        onAssertionConflict: "flag",
        onEdgeConflict: "repoint",
        onUniquenessConflict: "refuse",
        onProvenanceConflict: "refuse",
      },
    });
    expect(normalized.identity).toEqual({
      pairing: "definitional",
      onAssertionConflict: "flag",
      onEdgeConflict: "repoint",
      onUniquenessConflict: "refuse",
      onProvenanceConflict: "refuse",
    });
  });
});

const ReviewItem = defineNode("Item", {
  schema: z.object({ name: z.string() }),
});
const reviewGraph = defineGraph({
  id: "identity_options_review",
  nodes: { Item: { type: ReviewItem } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});
const REVIEW_POLICY = { id: "identity-review-policy", context: {} } as const;

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function reviewArgs(identity: IdentityReconciliationOptions | undefined) {
  const { backend } = createLocalSqliteBackend();
  disposers.push(() => backend.close());
  const [target] = await createStoreWithSchema(reviewGraph, backend, {
    history: true,
  });
  return {
    target,
    makeBackend: async () => createLocalSqliteBackend().backend,
    writeSet: {
      formatVersion: 1 as const,
      sourceId: "source",
      target: await captureCandidateWriteSetTarget(target),
      nodes: [
        {
          kind: "Item",
          id: "candidate",
          properties: { name: "New" },
          validFrom: "2026-01-01T00:00:00.000Z",
        },
      ],
      edges: [],
    },
    policy: REVIEW_POLICY,
    ...(identity === undefined ? {} : { options: { identity } }),
  };
}

describe("T6 — the identity policy is inside the review digest", () => {
  it("revalidating an approved plan under a DIFFERENT assertion policy reports changed", async () => {
    const planned = await reviewArgs({ onAssertionConflict: "assertWins" });
    const review = unwrap(await planCandidateWriteSetReview(planned));
    // Same write set, same target, same reviewer — only the policy moved.
    const applying = await reviewArgs({ onAssertionConflict: "retractWins" });
    const revalidated = unwrap(
      await revalidateCandidateWriteSetReview({
        ...applying,
        target: planned.target,
        review: JSON.parse(JSON.stringify(review)),
      }),
    );
    expect(revalidated.status).toBe("changed");
  });

  it("revalidating under the SAME policy stays compatible", async () => {
    const planned = await reviewArgs({ onAssertionConflict: "assertWins" });
    const review = unwrap(await planCandidateWriteSetReview(planned));
    const applying = await reviewArgs({ onAssertionConflict: "assertWins" });
    const revalidated = unwrap(
      await revalidateCandidateWriteSetReview({
        ...applying,
        target: planned.target,
        review: JSON.parse(JSON.stringify(review)),
      }),
    );
    expect(revalidated.status).toBe("compatible");
  });

  it("T7 at the artifact layer: an identity-free review stays compatible against identity-free options", async () => {
    const planned = await reviewArgs(undefined);
    const review = unwrap(await planCandidateWriteSetReview(planned));
    const applying = await reviewArgs(undefined);
    const revalidated = unwrap(
      await revalidateCandidateWriteSetReview({
        ...applying,
        target: planned.target,
        review: JSON.parse(JSON.stringify(review)),
      }),
    );
    expect(revalidated.status).toBe("compatible");
  });
});
