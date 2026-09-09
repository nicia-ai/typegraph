/**
 * Roadmap F — removal of the public custom `metaEdge()` factory, the public
 * `InferenceType` union, `MetaEdgeProperties.{transitive,symmetric,reflexive,
 * inverse,inference}`, and the deprecated `sameAs`/`differentFrom` factories.
 *
 * Every test in this file is load-bearing — each MUTATION CHECK comment
 * below states in full the code change that must flip the test red:
 *
 * - "still loads": a document persisted by pre-removal code (an old-shape
 *   `metaEdges` catalog entry with the five now-internal fields, and a
 *   `sameAs` relation) must still parse and build a `KindRegistry`.
 * - "sameAs -> equivalentTo": the classifier's verdict on a store opened
 *   after the code migrates a `sameAs(A, B)` declaration to `equivalentTo(A,
 *   B)` is warning-only (never breaking) — it auto-migrates on open.
 * - "differentFrom dropped": the classifier's verdict on a store opened
 *   after the code simply deletes a `differentFrom(A, B)` declaration is
 *   safe — it auto-migrates on open.
 *
 * The three `describe` blocks above exercise `computeSchemaDiff` and
 * `deserializeSchema` directly — the classification math in isolation. The
 * final block drives the same two migrations end to end through
 * `ensureSchema` against a real backend, the way a booting `Store` actually
 * encounters a pre-removal document: committed schema rows, not diff
 * literals, and the "migrated" status the schema manager actually returns.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  equivalentTo,
  type GraphBackend,
} from "../src";
import { deserializeSchema } from "../src/schema/deserializer";
import { ensureSchema } from "../src/schema/manager";
import { computeSchemaDiff } from "../src/schema/migration";
import { computeSchemaHash, serializeSchema } from "../src/schema/serializer";
import {
  type SerializedNodeDef,
  type SerializedOntology,
  type SerializedSchema,
  serializedSchemaZod,
} from "../src/schema/types";
import { createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

// ============================================================
// Fixtures
// ============================================================

function nodeDef(kind: string): SerializedNodeDef {
  return {
    kind,
    properties: { type: "object", properties: {} },
    uniqueConstraints: [],
    onDelete: "restrict",
    description: undefined,
  };
}

const EMPTY_CLOSURES = {
  subClassAncestors: {},
  subClassDescendants: {},
  broaderClosure: {},
  narrowerClosure: {},
  equivalenceSets: {},
  disjointPairs: [],
  partOfClosure: {},
  hasPartClosure: {},
  iriToKind: {},
  edgeInverses: {},
  edgeImplicationsClosure: {},
  edgeImplyingClosure: {},
};

function createSchema(ontology: SerializedOntology): SerializedSchema {
  return {
    graphId: "meta-edge-removal-migration",
    version: 1,
    generatedAt: "2024-01-01T00:00:00Z",
    nodes: { A: nodeDef("A"), B: nodeDef("B") },
    edges: {},
    ontology,
    defaults: { onNodeDelete: "restrict", temporalMode: "current" },
  };
}

describe("roadmap F: a pre-removal persisted document still loads", () => {
  it("parses a `sameAs` relation and an old-shape metaEdges catalog entry, and builds a registry that folds sameAs like equivalentTo", () => {
    // Exactly the shape pre-removal code would have serialized: the
    // `metaEdges` catalog entry still carries `transitive`/`symmetric`/
    // `reflexive`/`inverse`/`inference` (removed from `SerializedMetaEdge`
    // and from the zod validator's required fields by this change) — a
    // literal, not `SerializedSchema`-typed, because current code can no
    // longer describe this shape; that IS the point of the fixture.
    const legacyDocument = {
      graphId: "legacy-sameas",
      version: 1,
      generatedAt: "2023-01-01T00:00:00Z",
      nodes: { A: nodeDef("A"), B: nodeDef("B") },
      edges: {},
      ontology: {
        metaEdges: {
          sameAs: {
            name: "sameAs",
            transitive: true,
            symmetric: true,
            reflexive: false,
            inverse: undefined,
            inference: "substitution",
            description: "Deprecated type-level equivalence alias",
          },
        },
        relations: [{ metaEdge: "sameAs", from: "A", to: "B" }],
        closures: EMPTY_CLOSURES,
      },
      defaults: { onNodeDelete: "restrict", temporalMode: "current" },
    };

    // MUTATION CHECK: changing the per-meta-edge zod object's `.loose()`
    // (src/schema/types.ts) to `.strict()` makes this `safeParse` fail on
    // the legacy `sameAs` entry's now-unrecognized `transitive`/`symmetric`/
    // `reflexive`/`inverse`/`inference` fields — restored after the check.
    const parsed = serializedSchemaZod.safeParse(legacyDocument);
    expect(parsed.success).toBe(true);

    const registry = deserializeSchema(
      legacyDocument as unknown as SerializedSchema,
    ).buildRegistry();
    expect(registry.areEquivalent("A", "B")).toBe(true);
  });
});

describe("roadmap F: migrating sameAs(A, B) to equivalentTo(A, B) auto-migrates", () => {
  it("classifies the change as warning-only, never breaking", () => {
    // `metaEdges` populated the way the real serializer derives it (1:1
    // from `relations`) — a synthetic catalog-only fixture would not
    // exercise the dropped catalog diff arm the mutation check below relies
    // on (see `SerializedOntology.metaEdges`'s docblock).
    const before = createSchema({
      metaEdges: { sameAs: { name: "sameAs", description: undefined } },
      relations: [{ metaEdge: "sameAs", from: "A", to: "B" }],
      closures: EMPTY_CLOSURES,
    });
    const after = createSchema({
      metaEdges: {
        equivalentTo: { name: "equivalentTo", description: undefined },
      },
      relations: [{ metaEdge: "equivalentTo", from: "A", to: "B" }],
      closures: EMPTY_CLOSURES,
    });

    const diff = computeSchemaDiff(before, after);

    // MUTATION CHECK: restoring the dropped meta-edge-CATALOG diff arm in
    // `classifyOntologyChanges` (`src/schema/ontology-change.ts`) — which
    // unconditionally marked any meta-edge name disappearing from the
    // catalog `breaking` — flips `hasBreakingChanges` to `true` here, since
    // `sameAs` leaves the catalog in this exact migration. Restored after
    // the check.
    expect(diff.hasBreakingChanges).toBe(false);
    expect(diff.isBackwardsCompatible).toBe(true);
    expect(diff.ontology).toHaveLength(2);
    expect(diff.ontology).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "removed",
          entity: "relation",
          severity: "warning",
        }),
        expect.objectContaining({
          type: "added",
          entity: "relation",
          severity: "warning",
        }),
      ]),
    );
  });
});

describe("roadmap F: dropping a differentFrom(A, B) declaration auto-migrates", () => {
  it("classifies the removal as safe", () => {
    const before = createSchema({
      metaEdges: {
        differentFrom: { name: "differentFrom", description: undefined },
      },
      relations: [{ metaEdge: "differentFrom", from: "A", to: "B" }],
      closures: EMPTY_CLOSURES,
    });
    const after = createSchema({
      metaEdges: {},
      relations: [],
      closures: EMPTY_CLOSURES,
    });

    const diff = computeSchemaDiff(before, after);

    expect(diff.hasBreakingChanges).toBe(false);
    expect(diff.isBackwardsCompatible).toBe(true);
    expect(diff.ontology).toHaveLength(1);
    expect(diff.ontology[0]).toMatchObject({
      type: "removed",
      entity: "relation",
      severity: "safe",
    });
  });
});

describe("roadmap F: ensureSchema auto-migrates a persisted pre-removal document", () => {
  const A = defineNode("A", { schema: z.object({}) });
  const B = defineNode("B", { schema: z.object({}) });

  const baseGraph = defineGraph({
    id: "meta-edge-removal-ensure-schema",
    nodes: { A: { type: A }, B: { type: B } },
    edges: {},
  });

  // Simulates "an earlier process, running pre-removal code, persisted this
  // document": initializes the backend normally (so the A/B tables exist),
  // then commits a v2 schema row whose `ontology` is hand-edited to the
  // pre-removal shape — a shape today's `serializeSchema` can no longer
  // produce, which is exactly the point of the fixture.
  async function persistLegacyOntologyDocument(
    backend: GraphBackend,
    legacyOntology: SerializedOntology,
  ): Promise<void> {
    const [, initial] = await createStoreWithSchema(baseGraph, backend);
    expect(initial.status).toBe("initialized");

    const legacySchema: SerializedSchema = {
      ...serializeSchema(baseGraph, 2),
      ontology: legacyOntology,
    };
    const legacyHash = await computeSchemaHash(legacySchema);
    await backend.commitSchemaVersion({
      graphId: baseGraph.id,
      expected: { kind: "active", version: 1 },
      version: 2,
      schemaHash: legacyHash,
      schemaDoc: legacySchema,
    });
  }

  it("migrates a persisted sameAs(A, B) relation to equivalentTo(A, B) on open", async () => {
    const backend = createTestBackend();
    await persistLegacyOntologyDocument(backend, {
      metaEdges: {
        sameAs: {
          name: "sameAs",
          description: "Deprecated type-level equivalence alias",
        },
      },
      relations: [{ metaEdge: "sameAs", from: "A", to: "B" }],
      closures: EMPTY_CLOSURES,
    });

    const migratedGraph = defineGraph({
      id: baseGraph.id,
      nodes: { A: { type: A }, B: { type: B } },
      edges: {},
      ontology: [equivalentTo(A, B)],
    });

    // MUTATION CHECK: restoring the dropped meta-edge-CATALOG diff arm in
    // `classifyOntologyChanges` (`src/schema/ontology-change.ts`) flips this
    // to `status: "breaking"` (and, with `throwOnBreaking` defaulted true,
    // a thrown `MigrationError`) — `sameAs` leaves the catalog in this exact
    // migration. Restored after the check.
    const result = await ensureSchema(backend, migratedGraph);
    expect(result.status).toBe("migrated");
  });

  it("migrates a persisted differentFrom(A, B) relation by dropping it on open", async () => {
    const backend = createTestBackend();
    await persistLegacyOntologyDocument(backend, {
      metaEdges: {
        differentFrom: {
          name: "differentFrom",
          description: "Deprecated decorative type-level non-identity relation",
        },
      },
      relations: [{ metaEdge: "differentFrom", from: "A", to: "B" }],
      closures: EMPTY_CLOSURES,
    });

    const migratedGraph = defineGraph({
      id: baseGraph.id,
      nodes: { A: { type: A }, B: { type: B } },
      edges: {},
    });

    const result = await ensureSchema(backend, migratedGraph);
    expect(result.status).toBe("migrated");
  });
});
