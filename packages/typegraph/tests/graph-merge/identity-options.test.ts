/**
 * The `identity` merge-options normalizer (design §4.2 / plan-G2 §3):
 * defaults, the `.strict()` scalar validation, the `onAssertionConflict`
 * function/string split, and — the compatibility hinge (§3.2) — that
 * normalization is PRESENCE-PRESERVING (`undefined` in, `undefined` out; `{}`
 * in resolves every default), so a review artifact captured before this
 * option existed will keep revalidating `compatible` once PR-3 wires it in.
 *
 * `normalizeIdentityOptions` is deliberately NOT yet called from
 * `normalizeMergeOptions`/`MergeOptions` (see the notes in `options.ts` and
 * `types.ts`): `MergeOptions` is already publicly exported, so attaching a
 * member to it moves `etc/typegraph-graph-merge.api.md`, a public-surface
 * change this internal PR must not make. This suite exercises the
 * normalizer directly — exactly the shape PR-3's wiring will preserve.
 */
import { describe, expect, it } from "vitest";

import {
  IDENTITY_OPTION_DEFAULTS,
  normalizeIdentityOptions,
} from "../../src/graph-merge/options";

describe("T7 — presence-preserving normalization", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeIdentityOptions(undefined)).toBeUndefined();
  });

  it("fully resolves every default once the caller states `{}`", () => {
    expect(normalizeIdentityOptions({})).toEqual(IDENTITY_OPTION_DEFAULTS);
  });

  it("mutation check: defaulting `undefined` to the resolved bag breaks presence-preservation", () => {
    // Simulates the regression this test guards against: a normalizer that
    // falls back to the defaulted bag instead of passing `undefined` through
    // would make `identity-free` options revalidate as "identity present"
    // once PR-3 wires this into `reviewOptionEvidence`.
    const wronglyDefaulted =
      normalizeIdentityOptions(undefined) ?? IDENTITY_OPTION_DEFAULTS;
    expect(wronglyDefaulted).toEqual(IDENTITY_OPTION_DEFAULTS);
    // ...which is exactly why the real normalizer must return `undefined`
    // here, not the defaulted bag itself.
    expect(normalizeIdentityOptions(undefined)).toBeUndefined();
  });
});

describe("T6 (normalizer layer) — every stated policy resolves distinctly", () => {
  it("two different onAssertionConflict policies normalize to different bags", () => {
    const assertWins = normalizeIdentityOptions({
      pairing: "candidate",
      onAssertionConflict: "assertWins",
    });
    const retractWins = normalizeIdentityOptions({
      pairing: "candidate",
      onAssertionConflict: "retractWins",
    });
    expect(assertWins).not.toEqual(retractWins);
  });

  it("a function policy passes through unchanged", () => {
    const policy = (): { kind: "unresolved" } => ({ kind: "unresolved" });
    const normalized = normalizeIdentityOptions({
      pairing: "candidate",
      onAssertionConflict: policy,
    });
    expect(normalized?.onAssertionConflict).toBe(policy);
  });
});

describe("§3.3 refusal matrix — identity option validation", () => {
  it("refuses an unrecognized identity sub-option (typo)", () => {
    expect(() =>
      normalizeIdentityOptions({
        // @ts-expect-error deliberately malformed to prove `.strict()` catches it
        pairign: "candidate",
      }),
    ).toThrow();
  });

  it("refuses an unrecognized onAssertionConflict string", () => {
    expect(() =>
      normalizeIdentityOptions({
        // @ts-expect-error deliberately invalid enum value
        onAssertionConflict: "yolo",
      }),
    ).toThrow(/onAssertionConflict/);
  });

  it("refuses an unrecognized pairing mode", () => {
    expect(() =>
      normalizeIdentityOptions({
        // @ts-expect-error deliberately invalid enum value
        pairing: "everything",
      }),
    ).toThrow();
  });
});
