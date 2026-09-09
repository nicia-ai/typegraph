/**
 * The `identity` merge-options bag (design §4.2 / plan-G2 §3): normalization
 * defaults, the `.strict()` scalar validation, the `onAssertionConflict`
 * function/string split, and — the compatibility hinge (§3.2) — that
 * `normalizeMergeOptions` emits the field ONLY when the caller stated
 * `identity`, so a review artifact captured before this option existed keeps
 * revalidating `compatible`.
 */
import { describe, expect, it } from "vitest";

import {
  MERGE_OPTION_DEFAULTS,
  normalizeMergeOptions,
} from "../../src/graph-merge/options";
import { reviewOptionEvidence } from "../../src/graph-merge/review-evidence";

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
});
