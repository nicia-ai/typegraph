import { describe, expect, it } from "vitest";

import {
  canonicalMergePlanJson,
  computeMergePlanDigest,
  finalizeMergePlanArtifact,
} from "../../src/graph-merge/plan-canonical";
import type { MergePlanArtifactV2Input } from "../../src/graph-merge/plan-schema";
import { MERGE_PLAN_FORMAT_VERSION } from "../../src/graph-merge/plan-schema";
import {
  constructMergePlanArtifact,
  parseMergePlanArtifact,
  validateMergePlanArtifact,
  verifyMergePlanDigest,
} from "../../src/graph-merge/plan-wire";
import { requireDefined } from "../../src/utils/presence";

function planInput(): MergePlanArtifactV2Input {
  return {
    formatVersion: MERGE_PLAN_FORMAT_VERSION,
    mode: "snapshot",
    target: {
      graphId: "care",
      schema: { managed: true, version: 3, hash: "schema-hash" },
      revision: { origin: "store-origin", revision: "revision-7" },
    },
    anchors: {
      kind: "snapshot",
      base: { graphId: "care", baseVersion: "base-version" },
      branches: [{ branchId: "branch-a", baseVersion: "base-version" }],
    },
    proposed: {
      nodes: { upserts: 1, deletions: 0 },
      edges: { upserts: 0, deletions: 0 },
      identity: { assertions: 0, retractions: 0 },
    },
    writes: {
      nodeDeletes: [],
      nodeUpserts: [
        {
          kind: "Patient",
          id: "patient-1",
          setProps: { profile: { last: "Ng", first: "Ada" } },
          unsetProps: ["legacyName"],
        },
      ],
      edgeDeletes: [],
      edgeUpserts: [],
      identityAssertions: [],
      identityRetractions: [],
    },
    guards: {
      canonicalMappings: [],
      retypes: [],
      deletedNodes: [],
    },
    review: {
      resolutions: [],
      conflicts: [],
      deleteModifyConflicts: [],
      typeReconciliations: [],
      dropped: [],
      validityEnds: [],
      baseAmbiguities: [],
      provenanceRecords: [],
      warnings: [],
      compositionOrphans: [],
      diagnostics: { entries: [], total: 0, limit: 10, truncated: false },
    },
    provenance: { includeInReport: true, persist: false },
  };
}

function resolutionPlanInput(): MergePlanArtifactV2Input {
  const input = planInput();
  const evidence = {
    a: { kind: "Patient", id: "a" },
    b: { kind: "Patient", id: "b" },
    sources: [
      { kind: "unique" as const, sourceId: "u:name", constraintName: "name" },
    ],
    decision: "definitional" as const,
  };
  return {
    ...input,
    guards: {
      ...input.guards,
      canonicalMappings: [
        { member: evidence.a, canonical: evidence.a },
        { member: evidence.b, canonical: evidence.a },
      ],
    },
    review: {
      ...input.review,
      resolutions: [
        {
          canonicalId: "a",
          memberIds: ["a", "b"],
          kind: "Patient",
          branchOrigins: ["branch-a"],
          decisiveEdges: [evidence],
        },
      ],
    },
  };
}

describe("merge plan wire format", () => {
  it("round-trips through JSON with explicit property removals intact", async () => {
    const artifact = await constructMergePlanArtifact(planInput());
    const roundTripped: unknown = JSON.parse(JSON.stringify(artifact));

    const validated = await validateMergePlanArtifact(roundTripped);
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.artifact).toEqual(artifact);
      expect(validated.artifact.writes.nodeUpserts[0]?.unsetProps).toEqual([
        "legacyName",
      ]);
    }
  });

  it("canonicalizes nested object keys before hashing", async () => {
    const left = planInput();
    const right: MergePlanArtifactV2Input = {
      ...left,
      writes: {
        ...left.writes,
        nodeUpserts: [
          {
            ...requireDefined(left.writes.nodeUpserts[0]),
            setProps: { profile: { first: "Ada", last: "Ng" } },
          },
        ],
      },
    };

    expect(canonicalMergePlanJson(left)).toBe(canonicalMergePlanJson(right));
    await expect(computeMergePlanDigest(left)).resolves.toBe(
      await computeMergePlanDigest(right),
    );
  });

  it("detects write-set tampering", async () => {
    const artifact = await constructMergePlanArtifact(planInput());
    const tampered = {
      ...artifact,
      writes: {
        ...artifact.writes,
        nodeUpserts: [
          {
            ...requireDefined(artifact.writes.nodeUpserts[0]),
            setProps: { profile: { first: "Mallory" } },
          },
        ],
      },
    };

    const digest = await verifyMergePlanDigest(tampered);
    expect(digest.valid).toBe(false);
    const validated = await validateMergePlanArtifact(tampered);
    expect(validated).toMatchObject({
      success: false,
      error: { kind: "digest-mismatch" },
    });
  });

  it("distinguishes unsupported versions from malformed artifacts", async () => {
    // A stale but genuinely PRE-COMPOSITION artifact: `formatVersion: 1`
    // (this library's PREVIOUS format, before `review.compositionOrphans`
    // was added — see the version-bump comment on
    // `MERGE_PLAN_FORMAT_VERSION`) must be reported as `unsupported-version`,
    // never as `malformed` — a caller that stored a v1 plan for later
    // application is told the format moved, not that its payload is corrupt.
    expect(parseMergePlanArtifact({ formatVersion: 1 })).toEqual({
      success: false,
      error: { kind: "unsupported-version", received: 1 },
    });
    expect(
      parseMergePlanArtifact({
        formatVersion: MERGE_PLAN_FORMAT_VERSION + 1,
      }),
    ).toEqual({
      success: false,
      error: {
        kind: "unsupported-version",
        received: MERGE_PLAN_FORMAT_VERSION + 1,
      },
    });

    const artifact = await constructMergePlanArtifact(planInput());
    const malformed = { ...artifact, unexpected: true };
    const parsed = parseMergePlanArtifact(malformed);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.kind).toBe("malformed");
  });

  describe("refuses identity arbitration shapes the merge no longer produces", () => {
    const SEPARATION_CONFLICT = {
      kind: "separation",
      a: { kind: "Patient", id: "a" },
      b: { kind: "Patient", id: "b" },
      assertionIds: ["assertion-1"],
    };

    async function artifactWithReview(
      extraReview: Readonly<Record<string, unknown>>,
    ): Promise<unknown> {
      const artifact = await constructMergePlanArtifact(planInput());
      return { ...artifact, review: { ...artifact.review, ...extraReview } };
    }

    function expectMalformed(artifact: unknown): void {
      const parsed = parseMergePlanArtifact(artifact);
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.kind).toBe("malformed");
    }

    it("accepts a separation conflict, the one identity conflict arm a merge still writes", async () => {
      const parsed = parseMergePlanArtifact(
        await artifactWithReview({ identityConflicts: [SEPARATION_CONFLICT] }),
      );
      expect(parsed.success).toBe(true);
    });

    it.each(["assertion", "edge", "uniqueness"])(
      "rejects an identity conflict of removed kind %s",
      async (kind) => {
        expectMalformed(
          await artifactWithReview({
            identityConflicts: [{ ...SEPARATION_CONFLICT, kind }],
          }),
        );
      },
    );

    it("rejects review.identityReconciliations", async () => {
      expectMalformed(
        await artifactWithReview({ identityReconciliations: [] }),
      );
    });

    it("rejects an identity match source on a resolution", async () => {
      const input = resolutionPlanInput();
      const artifact = await constructMergePlanArtifact(input);
      const [resolution] = artifact.review.resolutions;
      const [edge] = requireDefined(resolution).decisiveEdges;
      expectMalformed({
        ...artifact,
        review: {
          ...artifact.review,
          resolutions: [
            {
              ...requireDefined(resolution),
              decisiveEdges: [
                { ...requireDefined(edge), sources: [{ kind: "identity" }] },
              ],
            },
          ],
        },
      });
    });
  });

  it("rejects non-finite evidence numbers", async () => {
    const artifact = await constructMergePlanArtifact(planInput());
    const malformed = {
      ...artifact,
      review: {
        ...artifact.review,
        resolutions: [
          {
            canonicalId: "a",
            memberIds: ["a", "b"],
            kind: "Patient",
            branchOrigins: ["branch-a"],
            decisiveEdges: [
              {
                a: { kind: "Patient", id: "a" },
                b: { kind: "Patient", id: "b" },
                sources: [{ kind: "block", sourceId: "exact-key" }],
                decision: "scored",
                strategy: { kind: "fulltext", fields: ["name"] },
                score: Number.NaN,
                threshold: 0.8,
              },
            ],
          },
        ],
      },
    };

    const parsed = parseMergePlanArtifact(malformed);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.kind).toBe("malformed");
  });

  it("uses the producer's id-first endpoint order for escaped ids", async () => {
    const input = resolutionPlanInput();
    const first = { kind: "Patient", id: '"' };
    const second = { kind: "Patient", id: "/" };
    const artifact = await constructMergePlanArtifact({
      ...input,
      guards: {
        ...input.guards,
        canonicalMappings: [
          { member: first, canonical: first },
          { member: second, canonical: first },
        ],
      },
      review: {
        ...input.review,
        resolutions: [
          {
            canonicalId: first.id,
            memberIds: [first.id, second.id],
            kind: first.kind,
            branchOrigins: ["branch-a"],
            decisiveEdges: [
              {
                a: first,
                b: second,
                sources: [{ kind: "block", sourceId: "exactKey" }],
                decision: "scored",
                strategy: { kind: "fulltext", fields: ["name"] },
                score: 0.9,
                threshold: 0.8,
              },
            ],
          },
        ],
      },
    });

    await expect(validateMergePlanArtifact(artifact)).resolves.toMatchObject({
      success: true,
    });
  });

  it("round-trips legal empty fulltext strategy fields", async () => {
    const input = resolutionPlanInput();
    const resolution = requireDefined(input.review.resolutions[0]);
    const evidence = requireDefined(resolution.decisiveEdges[0]);
    const artifact = await constructMergePlanArtifact({
      ...input,
      review: {
        ...input.review,
        resolutions: [
          {
            ...resolution,
            decisiveEdges: [
              {
                ...evidence,
                decision: "scored",
                strategy: { kind: "fulltext", fields: [] },
                score: 0.9,
                threshold: 0.8,
              },
            ],
          },
        ],
      },
    });

    await expect(validateMergePlanArtifact(artifact)).resolves.toMatchObject({
      success: true,
    });
  });

  it("rejects contradictory writes and proposal counts", async () => {
    const artifact = await constructMergePlanArtifact(planInput());
    const malformed = {
      ...artifact,
      proposed: {
        ...artifact.proposed,
        nodes: { upserts: 99, deletions: 1 },
      },
      writes: {
        ...artifact.writes,
        nodeDeletes: [{ kind: "Patient", id: "patient-1" }],
      },
    };

    const parsed = parseMergePlanArtifact(malformed);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.kind).toBe("malformed");
  });

  it("rejects a rehashed resolution without a connected N-1 witness", async () => {
    const input = resolutionPlanInput();
    const malformed = await finalizeMergePlanArtifact({
      ...input,
      review: {
        ...input.review,
        resolutions: [
          {
            ...requireDefined(input.review.resolutions[0]),
            decisiveEdges: [],
          },
        ],
      },
    });

    const validated = await validateMergePlanArtifact(malformed);
    expect(validated).toMatchObject({
      success: false,
      error: { kind: "malformed" },
    });
  });

  it("rejects rehashed contradictory diagnostic retention metadata", async () => {
    const input = planInput();
    const malformed = await finalizeMergePlanArtifact({
      ...input,
      review: {
        ...input.review,
        diagnostics: { entries: [], total: 10, limit: 1, truncated: false },
      },
    });

    const validated = await validateMergePlanArtifact(malformed);
    expect(validated).toMatchObject({
      success: false,
      error: { kind: "malformed" },
    });
  });
});
