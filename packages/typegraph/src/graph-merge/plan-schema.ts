import { z } from "zod";

import { compareEntityRefs, compareMatchSources } from "./evidence";
import type { JsonValue } from "./typegraph-internal";

export const MERGE_PLAN_FORMAT_VERSION = 1 as const;
export const MERGE_PLAN_DIGEST_ALGORITHM = "sha256" as const;

export type MergePlanEntityRef = Readonly<{ kind: string; id: string }>;

export type MergePlanSchemaFence = Readonly<{
  managed: boolean;
  version: number;
  hash: string;
}>;

export type MergePlanRevisionFence = Readonly<{
  origin: string;
  revision: string | null;
}>;

export type MergePlanTargetFence = Readonly<{
  graphId: string;
  schema: MergePlanSchemaFence;
  revision: MergePlanRevisionFence;
}>;

export type MergePlanBranchAnchor = Readonly<{
  branchId: string;
  baseVersion: string;
}>;

export type MergePlanAnchors =
  | Readonly<{
      kind: "snapshot";
      base: Readonly<{ graphId: string; baseVersion: string }>;
      branches: readonly MergePlanBranchAnchor[];
    }>
  | Readonly<{
      kind: "incremental";
      forkPoint: Readonly<{
        graphId: string;
        baseVersion: string;
        schema: MergePlanSchemaFence;
      }>;
      branches: readonly MergePlanBranchAnchor[];
    }>;

export type MergePlanNodeDelete = MergePlanEntityRef;

export type MergePlanNodeUpsert = Readonly<{
  kind: string;
  id: string;
  setProps: Readonly<Record<string, JsonValue>>;
  unsetProps: readonly string[];
  validFrom?: string | null | undefined;
  validTo?: string | undefined;
}>;

export type MergePlanEdgeDelete = MergePlanEntityRef;

export type MergePlanEdgeUpsert = Readonly<{
  kind: string;
  id: string;
  from: MergePlanEntityRef;
  to: MergePlanEntityRef;
  setProps: Readonly<Record<string, JsonValue>>;
  unsetProps: readonly string[];
  validFrom?: string | null | undefined;
  validTo?: string | undefined;
}>;

export type MergePlanIdentityAssertion = Readonly<{
  id: string;
  relation: "same" | "different";
  a: MergePlanEntityRef;
  b: MergePlanEntityRef;
  validFrom: string;
  validTo?: string | undefined;
  endedBy?: MergePlanEntityRef | undefined;
}>;

export type MergePlanWrites = Readonly<{
  nodeDeletes: readonly MergePlanNodeDelete[];
  nodeUpserts: readonly MergePlanNodeUpsert[];
  edgeDeletes: readonly MergePlanEdgeDelete[];
  edgeUpserts: readonly MergePlanEdgeUpsert[];
  identityAssertions: readonly MergePlanIdentityAssertion[];
  identityRetractions: readonly MergePlanIdentityAssertion[];
}>;

export type MergePlanProposedSummary = Readonly<{
  nodes: Readonly<{ upserts: number; deletions: number }>;
  edges: Readonly<{ upserts: number; deletions: number }>;
  identity: Readonly<{ assertions: number; retractions: number }>;
}>;

export type MergePlanCanonicalMapping = Readonly<{
  member: MergePlanEntityRef;
  canonical: MergePlanEntityRef;
}>;

export type MergePlanRetype = Readonly<{
  entity: MergePlanEntityRef;
  toKind: string;
}>;

export type MergePlanGuards = Readonly<{
  canonicalMappings: readonly MergePlanCanonicalMapping[];
  retypes: readonly MergePlanRetype[];
  deletedNodes: readonly MergePlanEntityRef[];
  incremental?: Readonly<{
    tombstoneResurrection: "refuse";
    lossyUpdates: "refuse";
    edgeIdentity: "preserve";
  }>;
}>;

export type MergePlanMatchSource =
  | Readonly<{ kind: "block"; sourceId: string }>
  | Readonly<{
      kind: "unique";
      sourceId: string;
      constraintName: string;
    }>
  | Readonly<{
      kind: "baseUnique";
      sourceId: string;
      constraintName: string;
    }>
  | Readonly<{
      kind: "baseIndex";
      sourceId: string;
      indexName: string;
    }>
  | Readonly<{ kind: "keyless"; sourceId: string }>
  | Readonly<{ kind: "retype"; sourceId: string }>
  | Readonly<{
      kind: "custom";
      sourceId: string;
      metadata?: JsonValue | undefined;
    }>;

export type MergePlanSimilarityStrategy =
  | Readonly<{ kind: "fulltext" | "vector"; fields: readonly string[] }>
  | Readonly<{
      kind: "hybrid";
      fields: readonly string[];
      weights: Readonly<{ vector: number; fulltext: number }>;
    }>
  | Readonly<{ kind: "custom" }>;

export type MergePlanMatchEvidence =
  | Readonly<{
      a: MergePlanEntityRef;
      b: MergePlanEntityRef;
      sources: readonly MergePlanMatchSource[];
      decision: "definitional";
    }>
  | Readonly<{
      a: MergePlanEntityRef;
      b: MergePlanEntityRef;
      sources: readonly MergePlanMatchSource[];
      decision: "scored";
      strategy: MergePlanSimilarityStrategy;
      score: number;
      threshold: number;
    }>;

export type MergePlanEntityResolution = Readonly<{
  canonicalId: string;
  memberIds: readonly string[];
  kind: string;
  branchOrigins: readonly string[];
  decisiveEdges: readonly MergePlanMatchEvidence[];
}>;

export type MergePlanCandidateDiagnostic = Readonly<{
  evidence: MergePlanMatchEvidence;
  scoreDecision: "accepted" | "rejected";
  reason?: "noComparableValues" | undefined;
  clusterDisposition?:
    | "retained"
    | Readonly<{
        kind: "excluded";
        reason: "diameter" | "baseAmbiguity";
      }>
    | undefined;
}>;

export type MergePlanDiagnostics = Readonly<{
  entries: readonly MergePlanCandidateDiagnostic[];
  total: number;
  limit: number;
  truncated: boolean;
}>;

export type MergePlanTypeReconciliation = Readonly<{
  entityId: string;
  fromTypes: readonly string[];
  toType: string;
  decisiveEdges?: readonly MergePlanMatchEvidence[] | undefined;
}>;

export type MergePlanReview = Readonly<{
  resolutions: readonly MergePlanEntityResolution[];
  conflicts: readonly JsonValue[];
  deleteModifyConflicts: readonly JsonValue[];
  typeReconciliations: readonly MergePlanTypeReconciliation[];
  dropped: readonly JsonValue[];
  validityEnds: readonly JsonValue[];
  baseAmbiguities: readonly JsonValue[];
  provenanceRecords: readonly JsonValue[];
  warnings: readonly string[];
  diagnostics?: MergePlanDiagnostics | undefined;
}>;

export type MergePlanProvenanceOptions = Readonly<{
  includeInReport: boolean;
  persist: boolean;
}>;

export type MergePlanDigest = Readonly<{
  algorithm: typeof MERGE_PLAN_DIGEST_ALGORITHM;
  value: string;
}>;

export type MergePlanArtifactV1 = Readonly<{
  formatVersion: typeof MERGE_PLAN_FORMAT_VERSION;
  digest: MergePlanDigest;
  mode: "snapshot" | "incremental";
  target: MergePlanTargetFence;
  anchors: MergePlanAnchors;
  proposed: MergePlanProposedSummary;
  writes: MergePlanWrites;
  guards: MergePlanGuards;
  review: MergePlanReview;
  provenance: MergePlanProvenanceOptions;
}>;

/** Current public merge-plan artifact type. */
export type MergePlanArtifact = MergePlanArtifactV1;

export type MergePlanArtifactV1Input = Omit<MergePlanArtifactV1, "digest">;

const nonEmptyStringSchema = z.string().min(1);
// Zod 4's number schema rejects NaN and infinities by default.
const finiteNumberSchema = z.number();
const nonNegativeIntegerSchema = finiteNumberSchema.int().nonnegative();
const jsonObjectSchema = z.record(z.string(), z.json());

const mergePlanEntityRefSchema = z
  .object({ kind: nonEmptyStringSchema, id: nonEmptyStringSchema })
  .strict();

const mergePlanSchemaFenceSchema = z
  .object({
    managed: z.boolean(),
    version: nonNegativeIntegerSchema,
    hash: nonEmptyStringSchema,
  })
  .strict();

const mergePlanRevisionFenceSchema = z
  .object({
    origin: nonEmptyStringSchema,
    revision: nonEmptyStringSchema.nullable(),
  })
  .strict();

const mergePlanTargetFenceSchema = z
  .object({
    graphId: nonEmptyStringSchema,
    schema: mergePlanSchemaFenceSchema,
    revision: mergePlanRevisionFenceSchema,
  })
  .strict();

const branchAnchorSchema = z
  .object({
    branchId: nonEmptyStringSchema,
    baseVersion: nonEmptyStringSchema,
  })
  .strict();

const snapshotAnchorsSchema = z
  .object({
    kind: z.literal("snapshot"),
    base: z
      .object({
        graphId: nonEmptyStringSchema,
        baseVersion: nonEmptyStringSchema,
      })
      .strict(),
    branches: z.array(branchAnchorSchema),
  })
  .strict();

const incrementalAnchorsSchema = z
  .object({
    kind: z.literal("incremental"),
    forkPoint: z
      .object({
        graphId: nonEmptyStringSchema,
        baseVersion: nonEmptyStringSchema,
        schema: mergePlanSchemaFenceSchema,
      })
      .strict(),
    branches: z.array(branchAnchorSchema),
  })
  .strict();

const mergePlanAnchorsSchema = z.discriminatedUnion("kind", [
  snapshotAnchorsSchema,
  incrementalAnchorsSchema,
]);

const nodeUpsertSchema = z
  .object({
    kind: nonEmptyStringSchema,
    id: nonEmptyStringSchema,
    setProps: jsonObjectSchema,
    unsetProps: z.array(nonEmptyStringSchema),
    validFrom: nonEmptyStringSchema.nullable().optional(),
    validTo: nonEmptyStringSchema.optional(),
  })
  .strict();

const edgeUpsertSchema = z
  .object({
    kind: nonEmptyStringSchema,
    id: nonEmptyStringSchema,
    from: mergePlanEntityRefSchema,
    to: mergePlanEntityRefSchema,
    setProps: jsonObjectSchema,
    unsetProps: z.array(nonEmptyStringSchema),
    validFrom: nonEmptyStringSchema.nullable().optional(),
    validTo: nonEmptyStringSchema.optional(),
  })
  .strict();

const mergePlanIdentityAssertionSchema = z
  .object({
    id: nonEmptyStringSchema,
    relation: z.enum(["same", "different"]),
    a: mergePlanEntityRefSchema,
    b: mergePlanEntityRefSchema,
    validFrom: nonEmptyStringSchema,
    validTo: nonEmptyStringSchema.optional(),
    endedBy: mergePlanEntityRefSchema.optional(),
  })
  .strict();

const mergePlanWritesSchema = z
  .object({
    nodeDeletes: z.array(mergePlanEntityRefSchema),
    nodeUpserts: z.array(nodeUpsertSchema),
    edgeDeletes: z.array(mergePlanEntityRefSchema),
    edgeUpserts: z.array(edgeUpsertSchema),
    identityAssertions: z.array(mergePlanIdentityAssertionSchema),
    identityRetractions: z.array(mergePlanIdentityAssertionSchema),
  })
  .strict();

const proposedRoleSchema = z
  .object({
    upserts: nonNegativeIntegerSchema,
    deletions: nonNegativeIntegerSchema,
  })
  .strict();

const mergePlanProposedSummarySchema = z
  .object({
    nodes: proposedRoleSchema,
    edges: proposedRoleSchema,
    identity: z
      .object({
        assertions: nonNegativeIntegerSchema,
        retractions: nonNegativeIntegerSchema,
      })
      .strict(),
  })
  .strict();

const mergePlanGuardsSchema = z
  .object({
    canonicalMappings: z.array(
      z
        .object({
          member: mergePlanEntityRefSchema,
          canonical: mergePlanEntityRefSchema,
        })
        .strict(),
    ),
    retypes: z.array(
      z
        .object({
          entity: mergePlanEntityRefSchema,
          toKind: nonEmptyStringSchema,
        })
        .strict(),
    ),
    deletedNodes: z.array(mergePlanEntityRefSchema),
    incremental: z
      .object({
        tombstoneResurrection: z.literal("refuse"),
        lossyUpdates: z.literal("refuse"),
        edgeIdentity: z.literal("preserve"),
      })
      .strict()
      .optional(),
  })
  .strict();

const matchSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("block"), sourceId: nonEmptyStringSchema })
    .strict(),
  z
    .object({
      kind: z.literal("unique"),
      sourceId: nonEmptyStringSchema,
      constraintName: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("baseUnique"),
      sourceId: nonEmptyStringSchema,
      constraintName: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("baseIndex"),
      sourceId: nonEmptyStringSchema,
      indexName: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("keyless"), sourceId: nonEmptyStringSchema })
    .strict(),
  z
    .object({ kind: z.literal("retype"), sourceId: nonEmptyStringSchema })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      sourceId: nonEmptyStringSchema,
      metadata: z.json().optional(),
    })
    .strict(),
]);

const similarityStrategySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fulltext"),
      fields: z.array(nonEmptyStringSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("vector"),
      fields: z.array(nonEmptyStringSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("hybrid"),
      fields: z.array(nonEmptyStringSchema),
      weights: z
        .object({ vector: finiteNumberSchema, fulltext: finiteNumberSchema })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal("custom") }).strict(),
]);

const definitionalEvidenceSchema = z
  .object({
    a: mergePlanEntityRefSchema,
    b: mergePlanEntityRefSchema,
    sources: z.array(matchSourceSchema),
    decision: z.literal("definitional"),
  })
  .strict();

const scoredEvidenceSchema = z
  .object({
    a: mergePlanEntityRefSchema,
    b: mergePlanEntityRefSchema,
    sources: z.array(matchSourceSchema),
    decision: z.literal("scored"),
    strategy: similarityStrategySchema,
    score: finiteNumberSchema,
    threshold: finiteNumberSchema,
  })
  .strict();

const mergePlanMatchEvidenceSchema = z.discriminatedUnion("decision", [
  definitionalEvidenceSchema,
  scoredEvidenceSchema,
]);

const entityResolutionSchema = z
  .object({
    canonicalId: nonEmptyStringSchema,
    memberIds: z.array(nonEmptyStringSchema),
    kind: nonEmptyStringSchema,
    branchOrigins: z.array(nonEmptyStringSchema),
    decisiveEdges: z.array(mergePlanMatchEvidenceSchema),
  })
  .strict();

const diagnosticsSchema = z
  .object({
    entries: z.array(
      z
        .object({
          evidence: mergePlanMatchEvidenceSchema,
          scoreDecision: z.enum(["accepted", "rejected"]),
          reason: z.literal("noComparableValues").optional(),
          clusterDisposition: z
            .union([
              z.literal("retained"),
              z
                .object({
                  kind: z.literal("excluded"),
                  reason: z.enum(["diameter", "baseAmbiguity"]),
                })
                .strict(),
            ])
            .optional(),
        })
        .strict(),
    ),
    total: nonNegativeIntegerSchema,
    limit: nonNegativeIntegerSchema,
    truncated: z.boolean(),
  })
  .strict();

const mergePlanReviewSchema = z
  .object({
    resolutions: z.array(entityResolutionSchema),
    conflicts: z.array(
      z
        .object({
          entityId: nonEmptyStringSchema,
          kind: nonEmptyStringSchema,
          property: nonEmptyStringSchema,
          values: z.array(
            z
              .object({ branchId: nonEmptyStringSchema, value: z.json() })
              .strict(),
          ),
          resolution: z.json(),
        })
        .strict(),
    ),
    deleteModifyConflicts: z.array(
      z
        .object({
          entityId: nonEmptyStringSchema,
          kind: nonEmptyStringSchema,
          deletedBy: nonEmptyStringSchema,
          modifiedBy: nonEmptyStringSchema,
          resolution: z.enum(["deleteWins", "modifyWins", "flag"]),
        })
        .strict(),
    ),
    typeReconciliations: z.array(
      z
        .object({
          entityId: nonEmptyStringSchema,
          fromTypes: z.array(nonEmptyStringSchema),
          toType: nonEmptyStringSchema,
          decisiveEdges: z.array(mergePlanMatchEvidenceSchema).optional(),
        })
        .strict(),
    ),
    dropped: z.array(
      z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("node"),
            id: nonEmptyStringSchema,
            reason: nonEmptyStringSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("edge"),
            id: nonEmptyStringSchema,
            reason: nonEmptyStringSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("identity"),
            id: nonEmptyStringSchema,
            reason: nonEmptyStringSchema,
          })
          .strict(),
      ]),
    ),
    validityEnds: z.array(
      z
        .object({
          entity: z.enum(["node", "edge"]),
          kind: nonEmptyStringSchema,
          id: nonEmptyStringSchema,
          validTo: nonEmptyStringSchema,
          claimedBy: z.array(nonEmptyStringSchema),
          precedence: z.literal("target").optional(),
        })
        .strict(),
    ),
    baseAmbiguities: z.array(
      z
        .object({
          baseIds: z.array(mergePlanEntityRefSchema),
          memberIds: z.array(mergePlanEntityRefSchema),
        })
        .strict(),
    ),
    provenanceRecords: z.array(
      z
        .object({
          role: z.enum(["node", "edge"]),
          canonicalId: nonEmptyStringSchema,
          canonicalKind: nonEmptyStringSchema,
          branchId: nonEmptyStringSchema,
          sourceId: nonEmptyStringSchema,
        })
        .strict(),
    ),
    warnings: z.array(z.string()),
    diagnostics: diagnosticsSchema.optional(),
  })
  .strict();

const mergePlanDigestSchema = z
  .object({
    algorithm: z.literal(MERGE_PLAN_DIGEST_ALGORITHM),
    value: z.string().regex(/^[\da-f]{64}$/),
  })
  .strict();

const mergePlanArtifactV1BaseSchema = z
  .object({
    formatVersion: z.literal(MERGE_PLAN_FORMAT_VERSION),
    digest: mergePlanDigestSchema,
    mode: z.enum(["snapshot", "incremental"]),
    target: mergePlanTargetFenceSchema,
    anchors: mergePlanAnchorsSchema,
    proposed: mergePlanProposedSummarySchema,
    writes: mergePlanWritesSchema,
    guards: mergePlanGuardsSchema,
    review: mergePlanReviewSchema,
    provenance: z
      .object({ includeInReport: z.boolean(), persist: z.boolean() })
      .strict(),
  })
  .strict();

const mergePlanArtifactV1InputBaseSchema = mergePlanArtifactV1BaseSchema.omit({
  digest: true,
});
type ParsedMergePlanArtifactV1Input = z.infer<
  typeof mergePlanArtifactV1InputBaseSchema
>;

function addSemanticIssues(
  artifact: ParsedMergePlanArtifactV1Input,
  ctx: z.RefinementCtx,
): void {
  if (artifact.mode !== artifact.anchors.kind) {
    ctx.addIssue({
      code: "custom",
      path: ["anchors", "kind"],
      message: `Expected ${artifact.mode} anchors for a ${artifact.mode} plan.`,
    });
  }
  if (
    (artifact.mode === "incremental") !==
    (artifact.guards.incremental !== undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["guards", "incremental"],
      message:
        "Incremental write guards must be present exactly for incremental plans.",
    });
  }

  const expectedCounts = {
    nodeUpserts: artifact.writes.nodeUpserts.length,
    nodeDeletions: artifact.writes.nodeDeletes.length,
    edgeUpserts: artifact.writes.edgeUpserts.length,
    edgeDeletions: artifact.writes.edgeDeletes.length,
    assertions: artifact.writes.identityAssertions.length,
    retractions: artifact.writes.identityRetractions.length,
  };
  const receivedCounts = {
    nodeUpserts: artifact.proposed.nodes.upserts,
    nodeDeletions: artifact.proposed.nodes.deletions,
    edgeUpserts: artifact.proposed.edges.upserts,
    edgeDeletions: artifact.proposed.edges.deletions,
    assertions: artifact.proposed.identity.assertions,
    retractions: artifact.proposed.identity.retractions,
  };
  if (JSON.stringify(expectedCounts) !== JSON.stringify(receivedCounts)) {
    ctx.addIssue({
      code: "custom",
      path: ["proposed"],
      message: "Proposed counts must equal the resolved write-set counts.",
    });
  }

  addOperationIssues(
    artifact.writes.nodeDeletes,
    artifact.writes.nodeUpserts,
    "node",
    ctx,
  );
  addOperationIssues(
    artifact.writes.edgeDeletes,
    artifact.writes.edgeUpserts,
    "edge",
    ctx,
  );
  for (const [index, upsert] of artifact.writes.nodeUpserts.entries()) {
    addPropertyPatchIssues(upsert, ["writes", "nodeUpserts", index], ctx);
  }
  for (const [index, upsert] of artifact.writes.edgeUpserts.entries()) {
    addPropertyPatchIssues(upsert, ["writes", "edgeUpserts", index], ctx);
  }

  const canonicalByMember = new Map<string, string>();
  let invalidCanonicalMappings = false;
  for (const mapping of artifact.guards.canonicalMappings) {
    const member = entityKey(mapping.member);
    const canonical = entityKey(mapping.canonical);
    if (canonicalByMember.has(member)) invalidCanonicalMappings = true;
    canonicalByMember.set(member, canonical);
  }
  for (const canonical of canonicalByMember.values()) {
    if (canonicalByMember.get(canonical) !== canonical) {
      invalidCanonicalMappings = true;
    }
  }
  if (invalidCanonicalMappings) {
    ctx.addIssue({
      code: "custom",
      path: ["guards", "canonicalMappings"],
      message:
        "Canonical mappings must name each member once and include a self-mapped canonical root.",
    });
  }

  const diagnostics = artifact.review.diagnostics;
  if (diagnostics !== undefined) {
    const expectedRetained = Math.min(diagnostics.total, diagnostics.limit);
    if (
      diagnostics.entries.length !== expectedRetained ||
      diagnostics.truncated !== diagnostics.total > diagnostics.entries.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["review", "diagnostics"],
        message:
          "Diagnostic retention and truncation metadata must exactly match total and limit.",
      });
    }
    for (const [index, diagnostic] of diagnostics.entries.entries()) {
      addEvidenceIssues(
        diagnostic.evidence,
        ["review", "diagnostics", "entries", index, "evidence"],
        ctx,
      );
      const accepted =
        diagnostic.evidence.decision === "definitional" ||
        (diagnostic.evidence.score >= diagnostic.evidence.threshold &&
          diagnostic.reason === undefined);
      if (
        diagnostic.scoreDecision !== (accepted ? "accepted" : "rejected") ||
        (diagnostic.evidence.decision === "scored" &&
          diagnostic.reason === "noComparableValues" &&
          diagnostic.evidence.score !== 0) ||
        (diagnostic.evidence.decision === "definitional" &&
          (diagnostic.reason !== undefined ||
            typeof diagnostic.clusterDisposition !== "object")) ||
        (diagnostic.scoreDecision === "rejected" &&
          diagnostic.clusterDisposition !== undefined)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["review", "diagnostics", "entries", index],
          message:
            "Diagnostic decision, reason, and cluster disposition must agree with its score evidence.",
        });
      }
    }
  }

  for (const [index, resolution] of artifact.review.resolutions.entries()) {
    addResolutionEvidenceIssues(artifact, resolution, index, ctx);
  }
  for (const [
    reconciliationIndex,
    reconciliation,
  ] of artifact.review.typeReconciliations.entries()) {
    for (const [edgeIndex, evidence] of (
      reconciliation.decisiveEdges ?? []
    ).entries()) {
      addEvidenceIssues(
        evidence,
        [
          "review",
          "typeReconciliations",
          reconciliationIndex,
          "decisiveEdges",
          edgeIndex,
        ],
        ctx,
      );
    }
  }
}

function addResolutionEvidenceIssues(
  artifact: ParsedMergePlanArtifactV1Input,
  resolution: ParsedMergePlanArtifactV1Input["review"]["resolutions"][number],
  resolutionIndex: number,
  ctx: z.RefinementCtx,
): void {
  const retypedKinds = new Map(
    artifact.guards.retypes.map((retype) => [
      entityKey(retype.entity),
      retype.toKind,
    ]),
  );
  const clusterMembers = artifact.guards.canonicalMappings
    .filter((mapping) => {
      const canonicalKind =
        retypedKinds.get(entityKey(mapping.canonical)) ??
        mapping.canonical.kind;
      return (
        mapping.canonical.id === resolution.canonicalId &&
        canonicalKind === resolution.kind
      );
    })
    .map((mapping) => mapping.member);
  const uniqueMembers = new Map(
    clusterMembers.map((member) => [entityKey(member), member]),
  );
  const memberIds = new Set(
    [...uniqueMembers.values()].map((member) => member.id),
  );
  const declaredMemberIds = new Set(resolution.memberIds);
  if (
    uniqueMembers.size < 2 ||
    declaredMemberIds.size !== resolution.memberIds.length ||
    memberIds.size !== declaredMemberIds.size ||
    [...memberIds].some((id) => !declaredMemberIds.has(id)) ||
    resolution.decisiveEdges.length !== uniqueMembers.size - 1
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["review", "resolutions", resolutionIndex],
      message:
        "A resolution must name its complete guarded cluster and carry exactly N-1 decisive edges.",
    });
    return;
  }

  const parent = new Map([...uniqueMembers.keys()].map((key) => [key, key]));
  const find = (key: string): string => {
    const next = parent.get(key);
    if (next === undefined || next === key) return key;
    const root = find(next);
    parent.set(key, root);
    return root;
  };
  let invalidTree = false;
  for (const [edgeIndex, evidence] of resolution.decisiveEdges.entries()) {
    addEvidenceIssues(
      evidence,
      ["review", "resolutions", resolutionIndex, "decisiveEdges", edgeIndex],
      ctx,
    );
    const a = entityKey(evidence.a);
    const b = entityKey(evidence.b);
    if (!uniqueMembers.has(a) || !uniqueMembers.has(b)) {
      invalidTree = true;
      continue;
    }
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) invalidTree = true;
    else parent.set(rootB, rootA);
  }
  if (
    invalidTree ||
    new Set([...uniqueMembers.keys()].map((key) => find(key))).size !== 1
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["review", "resolutions", resolutionIndex, "decisiveEdges"],
      message:
        "Decisive edges must be an acyclic connected witness over the guarded cluster.",
    });
  }
}

function addEvidenceIssues(
  evidence: ParsedMergePlanArtifactV1Input["review"]["resolutions"][number]["decisiveEdges"][number],
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const sourcesCanonical = evidence.sources.every((source, index) => {
    const previous = evidence.sources[index - 1];
    return previous === undefined || compareMatchSources(previous, source) < 0;
  });
  const invalidStrategy =
    evidence.decision === "scored" &&
    ((evidence.strategy.kind === "vector" &&
      evidence.strategy.fields.length !== 1) ||
      (evidence.strategy.kind === "hybrid" &&
        (evidence.strategy.weights.vector < 0 ||
          evidence.strategy.weights.vector > 1 ||
          evidence.strategy.weights.fulltext < 0 ||
          evidence.strategy.weights.fulltext > 1 ||
          Math.abs(
            evidence.strategy.weights.vector +
              evidence.strategy.weights.fulltext -
              1,
          ) > Number.EPSILON)));
  if (
    compareEntityRefs(evidence.a, evidence.b) >= 0 ||
    evidence.sources.length === 0 ||
    !sourcesCanonical ||
    (evidence.decision === "scored" &&
      (evidence.score < 0 ||
        evidence.score > 1 ||
        evidence.threshold < 0 ||
        evidence.threshold > 1)) ||
    invalidStrategy
  ) {
    ctx.addIssue({
      code: "custom",
      path: [...path],
      message:
        "Evidence endpoints and sources must be canonical, and scored values must be within [0, 1].",
    });
  }
}

function addOperationIssues(
  deletions: readonly MergePlanEntityRef[],
  upserts: readonly MergePlanEntityRef[],
  role: "node" | "edge",
  ctx: z.RefinementCtx,
): void {
  const deletionKeys = deletions.map((entry) => entityKey(entry));
  const upsertKeys = upserts.map((entry) => entityKey(entry));
  if (
    new Set(deletionKeys).size !== deletionKeys.length ||
    new Set(upsertKeys).size !== upsertKeys.length
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["writes"],
      message: `The ${role} write set must not contain duplicate identities.`,
    });
  }
  const deleted = new Set(deletionKeys);
  if (upsertKeys.some((key) => deleted.has(key))) {
    ctx.addIssue({
      code: "custom",
      path: ["writes"],
      message: `The same ${role} identity cannot be both deleted and upserted.`,
    });
  }
}

function addPropertyPatchIssues(
  patch: Readonly<{
    setProps: Readonly<Record<string, JsonValue>>;
    unsetProps: readonly string[];
  }>,
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const unset = new Set(patch.unsetProps);
  if (
    unset.size !== patch.unsetProps.length ||
    Object.keys(patch.setProps).some((key) => unset.has(key))
  ) {
    ctx.addIssue({
      code: "custom",
      path: [...path],
      message:
        "unsetProps must be duplicate-free and disjoint from setProps keys.",
    });
  }
}

function entityKey(entity: MergePlanEntityRef): string {
  return JSON.stringify([entity.kind, entity.id]);
}

export const mergePlanArtifactV1InputSchema =
  mergePlanArtifactV1InputBaseSchema.superRefine((artifact, ctx) =>
    addSemanticIssues(artifact, ctx),
  );

export const mergePlanArtifactV1Schema =
  mergePlanArtifactV1BaseSchema.superRefine((artifact, ctx) =>
    addSemanticIssues(artifact, ctx),
  );
