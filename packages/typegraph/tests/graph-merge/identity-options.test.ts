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
  branch,
  captureCandidateWriteSetTarget,
  isOk,
  merge,
  MERGE_PLAN_FORMAT_VERSION,
  planCandidateWriteSetReview,
  planMerge,
  revalidateCandidateWriteSetReview,
  unwrap,
} from "../../src/graph-merge";
import {
  MERGE_OPTION_DEFAULTS,
  normalizeMergeOptions,
} from "../../src/graph-merge/options";
import { reviewOptionEvidence } from "../../src/graph-merge/review-evidence";
import {
  asBranchId,
  type IdentityReconciliationOptions,
} from "../../src/graph-merge/types";

/**
 * The option evidence a caller who never heard of `identity` produced BEFORE
 * this release — copied literally, not recomputed. A review artifact stored
 * against this must keep revalidating `compatible`.
 */
const PRE_RELEASE_OPTION_EVIDENCE = [
  "object",
  [
    ["onBasePropertyConflict", ["literal", "flag"]],
    ["onComparisonCeiling", ["literal", "error"]],
    ["onDeleteModifyConflict", ["literal", "flag"]],
    ["onPropertyConflict", ["literal", "flag"]],
    ["persistProvenance", ["literal", false]],
    ["provenance", ["literal", true]],
    ["reconcileTypes", ["literal", "off"]],
    ["resolve", ["object", []]],
  ],
] as const;

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

  it("an identity-free bag encodes to the FROZEN pre-release evidence, field for field", () => {
    // Not "the same as what the normalizer produces" — a literal copy of the
    // evidence this release inherited. Anything the normalizer starts emitting
    // for an identity-free caller fails here, which is what makes every stored
    // review artifact's compatibility a guarantee rather than a coincidence.
    expect(reviewOptionEvidence({})).toEqual(PRE_RELEASE_OPTION_EVIDENCE);
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

  // The two deferred knobs (`onEdgeConflict`, `onUniquenessConflict`) are not
  // part of the option at all this release: an option whose only accepted
  // value is its default is dead surface. `.strict()` refuses them exactly as
  // it refuses a typo, so a caller who states one is told rather than served a
  // plan that ignored it.
  it("refuses the deferred onEdgeConflict knob", () => {
    expect(() =>
      // @ts-expect-error deferred: not part of this release's option
      normalizeMergeOptions({ identity: { onEdgeConflict: "repoint" } }),
    ).toThrow();
  });

  it("refuses the deferred onUniquenessConflict knob", () => {
    expect(() =>
      // @ts-expect-error deferred: not part of this release's option
      normalizeMergeOptions({ identity: { onUniquenessConflict: "refuse" } }),
    ).toThrow();
  });

  it("a refused identity option carries details.option through tryNormalize", async () => {
    const { backend } = createLocalSqliteBackend();
    disposers.push(() => backend.close());
    const [store] = await createStoreWithSchema(reviewGraph, backend, {
      history: true,
    });
    const result = await merge(store, [], {
      // @ts-expect-error deliberately invalid enum value
      identity: { onAssertionConflict: "yolo" },
    });
    if (isOk(result)) throw new Error("expected an invalid-options refusal");
    expect(result.error.code).toBe("GRAPH_MERGE_INVALID_OPTIONS");
    expect(result.error.details["option"]).toBe("identity.onAssertionConflict");
  });

  it("accepts every arm it does honor", () => {
    const normalized = normalizeMergeOptions({
      identity: {
        pairing: "definitional",
        onAssertionConflict: "flag",
        onProvenanceConflict: "refuse",
      },
    });
    expect(normalized.identity).toEqual({
      pairing: "definitional",
      onAssertionConflict: "flag",
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

  it("T7 at the artifact layer: a review captured BEFORE this release still revalidates compatible", async () => {
    const planned = await reviewArgs(undefined);
    const review = unwrap(await planCandidateWriteSetReview(planned));
    // The stored artifact is a PRE-RELEASE one: its option evidence is the
    // frozen literal, not whatever today's normalizer happens to emit. Both
    // sides being computed by the current code would make this test unable to
    // fail — an unconditional `identity` emission would move both together.
    const stored = {
      ...JSON.parse(JSON.stringify(review)),
      options: PRE_RELEASE_OPTION_EVIDENCE,
    };
    const applying = await reviewArgs(undefined);
    const revalidated = unwrap(
      await revalidateCandidateWriteSetReview({
        ...applying,
        target: planned.target,
        review: stored,
      }),
    );
    expect(revalidated.status).toBe("compatible");
  });

  it("T7 — the identity review arms are additive: the plan format version stays 2", async () => {
    const { backend } = createLocalSqliteBackend();
    disposers.push(() => backend.close());
    const [target] = await createStoreWithSchema(reviewGraph, backend, {
      history: true,
    });
    await target.nodes.Item.create({ name: "Kept" }, { id: "kept" });
    const source = unwrap(
      await branch(target, async () => createLocalSqliteBackend().backend, {
        id: asBranchId("branch-a"),
      }),
    );
    await source.store.nodes.Item.create({ name: "Fresh" }, { id: "fresh" });
    await source.store.identity.assertSame(
      { kind: "Item", id: "kept" },
      { kind: "Item", id: "fresh" },
    );
    disposers.push(() => source.close());

    const artifact = unwrap(
      await planMerge(target, [source], {
        branchOrder: [asBranchId("branch-a")],
        identity: { pairing: "definitional" },
      }),
    );
    expect(MERGE_PLAN_FORMAT_VERSION).toBe(2);
    expect(artifact.formatVersion).toBe(MERGE_PLAN_FORMAT_VERSION);
    // Present only when non-empty, so an identity-free plan's review object is
    // byte-identical to a pre-release one at the same format version.
    expect(artifact.review.identityConflicts).toBeDefined();
  });
});
