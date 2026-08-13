/**
 * T11 — bundle/declaration mismatch behavior.
 *
 * (i) `claims` (the pilot's one `bidirectional` cross-check) throws on
 *     disagreement in either direction, naming the members and carrying
 *     `CONSTRAINT_CLAIM_SURFACE_MISMATCH`.
 * (ii) every `crossCheck: "none"` bundle resolves without throwing when a
 *     backend implements the members with the declaration left undefined —
 *     the shape `types.ts:334` documents as ordinary.
 * (iii) Contract R2's audit, executed: `claimsVerdict`'s thrown error and
 *     `claimSupport`'s thrown error agree byte-for-byte on the
 *     `projectBackendWithout` fixtures `tests/recorded-capture-capability-
 *     gate.test.ts` already uses — this is the anti-drift seam for the
 *     transitional duplicate `resolve.ts` carries until B7.
 */
import { describe, expect, it } from "vitest";

import {
  batchPointReadVerdict,
  claimsVerdict,
  contributionHealthVerdict,
  recordedRevisionOriginsVerdict,
  statementExecutionVerdict,
  uniqueSidecarBatchVerdict,
} from "../src/backend/capabilities/resolve";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import { claimSupport } from "../src/store/claims/backing";
import { createTestBackend } from "./test-utils";

describe("capability bundle / declaration mismatch (T11)", () => {
  describe("(i) claims: the bidirectional cross-check", () => {
    it("throws when declared but a member is missing, naming the members", () => {
      const base = createTestBackend();
      const missing = projectBackendWithout(base, ["claimEdgeCardinality"]);
      let caught: unknown;
      try {
        claimsVerdict(missing);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & {
        details: Readonly<Record<string, unknown>>;
      };
      expect(error.details["code"]).toBe("CONSTRAINT_CLAIM_SURFACE_MISMATCH");
      expect(error.message).toContain("claimEdgeCardinality");
      expect(error.details["missing"]).toEqual(["claimEdgeCardinality"]);
    });

    it("throws when implemented but not declared, naming the members", () => {
      const base = createTestBackend();
      const { constraintClaims: _dropped, ...capabilities } = base.capabilities;
      const undeclared = deriveBackend(base, { capabilities });
      let caught: unknown;
      try {
        claimsVerdict(undeclared);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & {
        details: Readonly<Record<string, unknown>>;
      };
      expect(error.details["code"]).toBe("CONSTRAINT_CLAIM_SURFACE_MISMATCH");
      expect(error.message).toContain("claimEdgeCardinality");
      expect(error.details["present"]).toEqual([
        "claimEdgeCardinality",
        "claimEdgeCardinalityBatch",
        "purgeEdgeClaims",
        "hardDeleteUniquesByConcreteKind",
      ]);
    });
  });

  describe("(ii) crossCheck: 'none' bundles never acquire a new refusal from an undeclared implementation", () => {
    it("uniqueSidecarBatch resolves without throwing on the default backend", () => {
      expect(() =>
        uniqueSidecarBatchVerdict(createTestBackend()),
      ).not.toThrow();
    });

    it("batchPointRead resolves without throwing on the default backend", () => {
      expect(() => batchPointReadVerdict(createTestBackend())).not.toThrow();
    });

    it("statementExecution resolves without throwing on the default backend", () => {
      expect(() =>
        statementExecutionVerdict(createTestBackend()),
      ).not.toThrow();
    });

    it("recordedRevisionOrigins resolves without throwing on the default backend", () => {
      expect(() =>
        recordedRevisionOriginsVerdict(createTestBackend()),
      ).not.toThrow();
    });

    it("contributionHealth resolves without throwing over a real backend with capabilities.contributions: undefined", () => {
      const base = createTestBackend();
      const backend = deriveBackend(base, {
        capabilities: { ...base.capabilities, contributions: undefined },
      });
      const verdict = contributionHealthVerdict(backend);
      expect(verdict.extras.probeContributions.present).toBe(true);
    });
  });

  describe("(iii) claimsVerdict and claimSupport agree on the recorded-capture gate's own fixtures (Contract R2's audit)", () => {
    it("agree when a claim member is missing", () => {
      const base = createTestBackend();
      const missing = projectBackendWithout(base, ["purgeEdgeClaims"]);

      let fromVerdict: unknown;
      try {
        claimsVerdict(missing);
      } catch (error) {
        fromVerdict = error;
      }
      let fromSupport: unknown;
      try {
        claimSupport(missing);
      } catch (error) {
        fromSupport = error;
      }

      expect(fromVerdict).toBeInstanceOf(Error);
      expect(fromSupport).toBeInstanceOf(Error);
      const a = fromVerdict as Error & {
        details: Readonly<Record<string, unknown>>;
        suggestion?: string;
      };
      const b = fromSupport as Error & {
        details: Readonly<Record<string, unknown>>;
        suggestion?: string;
      };
      expect(a.message).toBe(b.message);
      expect(a.details["code"]).toBe(b.details["code"]);
      expect(a.details["missing"]).toEqual(b.details["missing"]);
      expect(a.details["present"]).toEqual(b.details["present"]);
      expect(a.suggestion).toBe(b.suggestion);
    });

    it("agree when the claim members are implemented without the declaration", () => {
      const base = createTestBackend();
      const { constraintClaims: _dropped, ...capabilities } = base.capabilities;
      const undeclared = deriveBackend(base, { capabilities });

      let fromVerdict: unknown;
      try {
        claimsVerdict(undeclared);
      } catch (error) {
        fromVerdict = error;
      }
      let fromSupport: unknown;
      try {
        claimSupport(undeclared);
      } catch (error) {
        fromSupport = error;
      }

      expect(fromVerdict).toBeInstanceOf(Error);
      expect(fromSupport).toBeInstanceOf(Error);
      const a = fromVerdict as Error & {
        details: Readonly<Record<string, unknown>>;
        suggestion?: string;
      };
      const b = fromSupport as Error & {
        details: Readonly<Record<string, unknown>>;
        suggestion?: string;
      };
      expect(a.message).toBe(b.message);
      expect(a.details["code"]).toBe(b.details["code"]);
      expect(a.details["missing"]).toEqual(b.details["missing"]);
      expect(a.details["present"]).toEqual(b.details["present"]);
      expect(a.suggestion).toBe(b.suggestion);
    });
  });
});
