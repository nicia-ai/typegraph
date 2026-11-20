import { describe, expect, it } from "vitest";

import {
  canonicalMergePlanJson,
  computeMergePlanDigest,
  finalizeMergePlanArtifact,
} from "../../src/graph-merge/plan-canonical";
import {
  LEGACY_MERGE_PLAN_FORMAT_VERSIONS,
  MERGE_PLAN_FORMAT_VERSION,
  type MergePlanArtifactInput,
  type MergePlanArtifactV3Input,
} from "../../src/graph-merge/plan-schema";
import {
  constructMergePlanArtifact,
  parseMergePlanArtifact,
  validateMergePlanArtifact,
  verifyMergePlanDigest,
} from "../../src/graph-merge/plan-wire";
import { requireDefined } from "../../src/utils/presence";

const ALLOCATION_OWNER = { origin: "store-origin", namespace: "a".repeat(32) };

/** A legacy-format input built from the current fixture, digested by hand. */
async function legacyArtifact(
  formatVersion: 1 | 2,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<unknown> {
  const { review, target, ...body } = planInput();
  const { identityConflicts: _conflicts, ...legacyReview } = review;
  const { owner: _owner, ...unownedRevision } = target.revision;
  const input = {
    ...body,
    formatVersion,
    target:
      formatVersion === 1 ? { ...target, revision: unownedRevision } : target,
    review: legacyReview,
    ...overrides,
  } as unknown as MergePlanArtifactInput;
  return {
    ...input,
    digest: {
      algorithm: "sha256",
      value: await computeMergePlanDigest(input),
    },
  };
}

function planInput(): MergePlanArtifactV3Input {
  return {
    formatVersion: MERGE_PLAN_FORMAT_VERSION,
    mode: "snapshot",
    target: {
      graphId: "care",
      schema: { managed: true, version: 3, hash: "schema-hash" },
      revision: {
        owner: ALLOCATION_OWNER,
        origin: "store-origin",
        revision: "revision-7",
      },
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
      diagnostics: { entries: [], total: 0, limit: 10, truncated: false },
    },
    provenance: { includeInReport: true, persist: false },
  };
}

function resolutionPlanInput(): MergePlanArtifactV3Input {
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
    const right: MergePlanArtifactV3Input = {
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
    // A legacy format parses under its own grammar, for inspection, so an
    // empty legacy artifact is malformed rather than unsupported.
    for (const legacy of LEGACY_MERGE_PLAN_FORMAT_VERSIONS) {
      const parsed = parseMergePlanArtifact({ formatVersion: legacy });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.kind).toBe("malformed");
    }
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

  it("parses legacy formats 1 and 2 under their own grammar", async () => {
    const v1 = await legacyArtifact(1);
    const v2 = await legacyArtifact(2);
    expect(parseMergePlanArtifact(v1).success).toBe(true);
    expect(parseMergePlanArtifact(v2).success).toBe(true);
    expect((await validateMergePlanArtifact(v2)).success).toBe(true);
    // Format 1 carries no allocation owner; format 2 requires one.
    const ownedV1 = await legacyArtifact(1, {
      target: planInput().target,
    });
    expect(parseMergePlanArtifact(ownedV1).success).toBe(false);
    // Neither legacy format carries the identity-conflict review field.
    const identityConflicts = [
      {
        kind: "separation",
        a: { kind: "Person", id: "a" },
        b: { kind: "Person", id: "b" },
        assertionIds: ["different-ab"],
      },
    ] as const;
    const withIdentityConflicts = await legacyArtifact(2, {
      review: {
        ...planInput().review,
        identityConflicts,
      },
    });
    expect(parseMergePlanArtifact(withIdentityConflicts).success).toBe(false);
    expect(
      parseMergePlanArtifact(
        await constructMergePlanArtifact({
          ...planInput(),
          review: {
            ...planInput().review,
            identityConflicts,
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("requires format 2 or later for validity clearing and recreation", async () => {
    const base = planInput();
    const writes = {
      ...base.writes,
      nodeUpserts: [
        {
          kind: "Patient",
          id: "new",
          setProps: { name: "new" },
          unsetProps: [],
          clearValidTo: true as const,
          recreate: true as const,
        },
      ],
    };
    expect(
      parseMergePlanArtifact(await legacyArtifact(1, { writes })).success,
    ).toBe(false);
    expect(
      parseMergePlanArtifact(await legacyArtifact(2, { writes })).success,
    ).toBe(true);
    const current = await constructMergePlanArtifact({ ...base, writes });
    expect(
      (await validateMergePlanArtifact(JSON.parse(JSON.stringify(current))))
        .success,
    ).toBe(true);
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
