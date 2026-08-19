/**
 * T10 (skeleton) — every `refuse` operation row in the pilot registry names
 * a non-empty code; every GRADUATED bundle's refuse row carries a non-empty
 * `requires` (that is how a graduated bundle still refuses where the tree
 * refuses today); and the enumerated `(bundle, operation, code)` set equals
 * a pinned table, in BOTH directions, so neither a row silently disappearing
 * nor an unpinned row silently appearing goes unnoticed.
 *
 * Behavioral rows (actually exercising the refusal against a backend) land
 * in B7/B8 — this file enumerates the registry's OWN data.
 *
 * The `describe("behavioral rows (B7)")` block below is B7's addition: each
 * row asserts what the TREE actually throws (class, message, details) against
 * a real backend, separately from the registry naming the row above — the
 * registry's `code` is classification data, not a promise that this exact
 * machine code is thrown (most rows here have none of their own).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  repairInvertedValidityWindows,
} from "../src";
import {
  CAPABILITY_BUNDLES,
  RECORDED_REVISION_ORIGINS,
} from "../src/backend/capabilities/bundle-registry";
import {
  createClaimsVerdictThunk,
  recordedRevisionOriginsVerdict,
  uniqueSidecarBatchVerdict,
} from "../src/backend/capabilities/resolve";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import { type GraphBackend } from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import { buildKindRegistry } from "../src/registry";
import {
  alreadyAppliedRowWrite,
  createUniquenessContext,
  hardDeleteClaimsByNodeIds,
} from "../src/store/claims/node-claims";
import { applyResolvedNodeClaims } from "../src/store/claims/resolved-node-claims";
import {
  ensureRevisionOrigin,
  uncapturedGraphWriteLock,
} from "../src/store/recorded-capture/clock";
import { createTestBackend } from "./test-utils";

type RefusalRow = Readonly<{
  bundle: string;
  operation: string;
  code: string;
  graduated: boolean;
  requires: readonly string[] | undefined;
}>;

function enumerateRefusalRows(): readonly RefusalRow[] {
  const rows: RefusalRow[] = [];
  for (const bundle of CAPABILITY_BUNDLES) {
    for (const operation of bundle.operations) {
      if (operation.disposition.kind !== "refuse") continue;
      rows.push({
        bundle: bundle.id,
        operation: operation.operation,
        code: operation.disposition.code,
        graduated: bundle.kind === "graduated",
        requires: "requires" in operation ? operation.requires : undefined,
      });
    }
  }
  return rows;
}

// The pinned table — `(bundle, operation, code)` triples the enumeration
// must reproduce EXACTLY, in both directions.
const PINNED_REFUSAL_TABLE: readonly (readonly [string, string, string])[] = [
  [
    "uniqueSidecarBatch",
    "unique reap by node ids",
    "UNIQUE_REAP_BY_NODE_IDS_UNSUPPORTED",
  ],
  [
    "uniqueSidecarBatch",
    "set-based node update",
    "SET_UPDATE_UNIQUENESS_UNSUPPORTED",
  ],
  [
    "uniqueSidecarBatch",
    "resolved node write",
    "RESOLVED_NODE_UNIQUENESS_UNSUPPORTED",
  ],
  [
    "statementExecution",
    "identity statement execution",
    "IDENTITY_REQUIRES_STATEMENT_EXECUTION",
  ],
  [
    "statementExecution",
    "recorded capture statement",
    "RECORDED_CAPTURE_STATEMENT_UNSUPPORTED",
  ],
  [
    "statementExecution",
    "history construction gate",
    "HISTORY_REQUIRES_STATEMENT_EXECUTION",
  ],
  [
    "statementExecution",
    "revision tracking construction gate",
    "REVISION_TRACKING_REQUIRES_STATEMENT_EXECUTION",
  ],
  [
    "statementExecution",
    "identity construction gate",
    "IDENTITY_REQUIRES_ATOMIC_BACKEND",
  ],
  [
    "statementExecution",
    "validity window repair",
    "VALIDITY_WINDOW_REPAIR_REQUIRES_STATEMENT_EXECUTION",
  ],
  [
    "statementExecution",
    "recorded-time migration",
    "RECORDED_TIME_MIGRATION_REQUIRES_STATEMENT_EXECUTION",
  ],
  [
    "contributionHealth",
    "contribution verify",
    "CONTRIBUTION_VERIFY_UNSUPPORTED",
  ],
  [
    "contributionHealth",
    "contribution repair",
    "CONTRIBUTION_REPAIR_UNSUPPORTED",
  ],
  [
    "contributionHealth",
    "contribution rebuild",
    "CONTRIBUTION_REBUILD_UNSUPPORTED",
  ],
  [
    "recordedRevisionOrigins",
    "revision tracking construction gate",
    "REVISION_TRACKING_REQUIRES_REVISION_ORIGINS",
  ],
  [
    "recordedRevisionOrigins",
    "revision origin bootstrap",
    "REVISION_ORIGIN_BOOTSTRAP_UNSUPPORTED",
  ],
];

describe("capability refusal matrix (T10, skeleton)", () => {
  it("every refuse row names a non-empty code", () => {
    for (const row of enumerateRefusalRows()) {
      expect(row.code.length, `${row.bundle}/${row.operation}`).toBeGreaterThan(
        0,
      );
    }
  });

  it("every graduated bundle's refuse row carries a non-empty `requires`", () => {
    for (const row of enumerateRefusalRows()) {
      if (!row.graduated) continue;
      expect(
        row.requires,
        `${row.bundle}/${row.operation} is a graduated refuse row with no requires`,
      ).toBeDefined();
      expect((row.requires ?? []).length).toBeGreaterThan(0);
    }
  });

  it("the enumerated (bundle, operation, code) set equals the pinned table, in both directions", () => {
    const enumerated = enumerateRefusalRows().map(
      (row) => [row.bundle, row.operation, row.code] as const,
    );
    const enumeratedKeys = new Set(enumerated.map((row) => row.join(" ")));
    const pinnedKeys = new Set(
      PINNED_REFUSAL_TABLE.map((row) => row.join(" ")),
    );

    const missingFromPinned = [...enumeratedKeys].filter(
      (key) => !pinnedKeys.has(key),
    );
    const missingFromEnumerated = [...pinnedKeys].filter(
      (key) => !enumeratedKeys.has(key),
    );

    expect(missingFromPinned, "rows in the registry but not pinned").toEqual(
      [],
    );
    expect(
      missingFromEnumerated,
      "rows pinned but missing from the registry",
    ).toEqual([]);
  });
});

function backendWithoutExecuteStatement(): GraphBackend {
  const base = createTestBackend();
  return projectBackendWithout(base, ["executeStatement"]);
}

const RefusalPerson = defineNode("RefusalPerson", {
  schema: z.object({ name: z.string() }),
});

const refusalGraph = defineGraph({
  id: "capability-refusal-matrix-behavioral",
  nodes: { RefusalPerson: { type: RefusalPerson } },
  edges: {},
});

const identityRefusalGraph = defineGraph({
  id: "capability-refusal-matrix-identity",
  nodes: { RefusalPerson: { type: RefusalPerson } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const refusalHasPassport = defineEdge("refusalHasPassport", {
  schema: z.object({}),
});

const constrainedRefusalGraph = defineGraph({
  id: "capability-refusal-matrix-claims",
  nodes: { RefusalPerson: { type: RefusalPerson } },
  edges: {
    refusalHasPassport: {
      type: refusalHasPassport,
      from: [RefusalPerson],
      to: [RefusalPerson],
      cardinality: "one",
    },
  },
});

describe("behavioral rows (B7)", () => {
  it("statementExecution / history construction gate", () => {
    // What the TREE actually throws: `history: true` also enables revision
    // tracking (`this.#revisionTrackingEnabled = this.#captureEnabled || …`),
    // whose OWN construction gate (`assertRevisionTrackableBackend`) runs
    // BEFORE `createRecordedBackend`'s `assertCapturableBackend` and checks
    // the SAME `executeStatement` member first — so a backend missing only
    // `executeStatement` throws revisionTracking's message, never history's
    // own (guards.ts:251's `HISTORY_REQUIRES_STATEMENT_EXECUTION` message is
    // unreachable through THIS gap; see the batch report). The registry
    // still separately names a "history construction gate" row.
    expect(() =>
      createStore(refusalGraph, backendWithoutExecuteStatement(), {
        history: true,
      }),
    ).toThrow(
      "revisionTracking: true requires a backend that supports executeStatement.",
    );

    const registryRow = CAPABILITY_BUNDLES.find(
      (bundle) => bundle.id === "statementExecution",
    )?.operations.find(
      (operation) => operation.operation === "history construction gate",
    );
    expect(registryRow?.disposition.kind).toBe("refuse");
  });

  it("statementExecution / revision tracking construction gate", () => {
    expect(() =>
      createStore(refusalGraph, backendWithoutExecuteStatement(), {
        revisionTracking: true,
      }),
    ).toThrow(
      "revisionTracking: true requires a backend that supports executeStatement.",
    );
  });

  it("statementExecution / identity construction gate", () => {
    let caught: unknown;
    try {
      createStore(identityRefusalGraph, backendWithoutExecuteStatement());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & {
      details: Readonly<Record<string, unknown>>;
    };
    expect(error.details["code"]).toBe("IDENTITY_REQUIRES_ATOMIC_BACKEND");
  });

  it("statementExecution / validity window repair", async () => {
    await expect(
      repairInvertedValidityWindows({
        backend: backendWithoutExecuteStatement(),
        relations: "live",
        mode: "apply",
      }),
    ).rejects.toThrow(
      "Repairing inverted validity windows requires executeStatement support.",
    );
  });

  it("claims / edge claim write (fallback): a backend with no claim members and no declaration writes a constrained edge with no claim and no throw", async () => {
    const base = createTestBackend();
    const { constraintClaims: _dropped, ...capabilities } = base.capabilities;
    const backend = deriveBackend(
      projectBackendWithout(base, [
        "claimEdgeCardinality",
        "claimEdgeCardinalityBatch",
        "purgeEdgeClaims",
        "hardDeleteUniquesByConcreteKind",
      ]),
      { capabilities },
    );
    const store = createStore(constrainedRefusalGraph, backend);
    const alice = await store.nodes.RefusalPerson.create({ name: "Alice" });
    const bob = await store.nodes.RefusalPerson.create({ name: "Bob" });

    await expect(
      store.edges.refusalHasPassport.create(alice, bob, {}),
    ).resolves.toBeDefined();
  });

  it("claims mismatch, declared but missing a member: CONSTRAINT_CLAIM_SURFACE_MISMATCH, byte-identical to the registry's own message", async () => {
    const base = createTestBackend();
    const backend = projectBackendWithout(base, ["claimEdgeCardinality"]);
    // Node creation must still succeed: the verdict thunk resolves lazily, at
    // the first CLAIMED write, never at store construction (T14).
    const store = createStore(constrainedRefusalGraph, backend);
    const alice = await store.nodes.RefusalPerson.create({ name: "Alice" });
    const bob = await store.nodes.RefusalPerson.create({ name: "Bob" });

    let caught: unknown;
    try {
      await store.edges.refusalHasPassport.create(alice, bob, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & {
      details: Readonly<Record<string, unknown>>;
      message: string;
    };
    expect(error.details["code"]).toBe("CONSTRAINT_CLAIM_SURFACE_MISMATCH");
    expect(error.message).toBe(
      "This backend declares `constraintClaims: true` but does not implement claimEdgeCardinality. " +
        "A declared constraint would then be written without the fence the declaration promises.",
    );
  });

  it("claims mismatch, implemented but not declared: CONSTRAINT_CLAIM_SURFACE_MISMATCH, byte-identical to the registry's own message", async () => {
    const base = createTestBackend();
    const { constraintClaims: _dropped, ...capabilities } = base.capabilities;
    const backend = deriveBackend(base, { capabilities });
    const store = createStore(constrainedRefusalGraph, backend);
    const alice = await store.nodes.RefusalPerson.create({ name: "Alice" });
    const bob = await store.nodes.RefusalPerson.create({ name: "Bob" });

    let caught: unknown;
    try {
      await store.edges.refusalHasPassport.create(alice, bob, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & {
      details: Readonly<Record<string, unknown>>;
      message: string;
    };
    expect(error.details["code"]).toBe("CONSTRAINT_CLAIM_SURFACE_MISMATCH");
    expect(error.message).toBe(
      "This backend implements claimEdgeCardinality, claimEdgeCardinalityBatch, purgeEdgeClaims, hardDeleteUniquesByConcreteKind but does not declare `constraintClaims: true`. " +
        "Claim support is read from the declaration, so these members would never be called.",
    );
  });
});

const UniqueRefusalWidget = defineNode("UniqueRefusalWidget", {
  schema: z.object({ code: z.string() }),
});

const uniqueRefusalGraph = defineGraph({
  id: "capability-refusal-matrix-unique-sidecar",
  nodes: {
    UniqueRefusalWidget: {
      type: UniqueRefusalWidget,
      unique: [
        {
          name: "unique_code",
          fields: ["code"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

/**
 * B8's behavioral rows: the `uniqueSidecarBatch`, `contributionHealth` and
 * `recordedRevisionOrigins` refusals, each exercising what the TREE actually
 * throws against a real backend — the same discipline the B7 block above
 * applies to `claims` and `statementExecution`.
 */
describe("behavioral rows (B8)", () => {
  it("uniqueSidecarBatch / set-based node update", async () => {
    const base = createTestBackend();
    const backend = projectBackendWithout(base, ["insertUniqueBatch"]);
    const store = createStore(uniqueRefusalGraph, backend);
    await store.nodes.UniqueRefusalWidget.create({ code: "widget-1" });

    let caught: unknown;
    try {
      await store.nodes.UniqueRefusalWidget.updateWhere({
        all: true,
        patch: { code: "widget-2" },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & {
      details: Readonly<Record<string, unknown>>;
    };
    expect(error.details["code"]).toBe("SET_UPDATE_UNIQUENESS_UNSUPPORTED");
  });

  it("uniqueSidecarBatch / resolved node write", async () => {
    const base = createTestBackend();
    const backend = projectBackendWithout(base, ["insertUniqueBatch"]);
    const registry = buildKindRegistry(uniqueRefusalGraph);

    let caught: unknown;
    try {
      await applyResolvedNodeClaims(
        {
          graphId: uniqueRefusalGraph.id,
          registry,
          lock: uncapturedGraphWriteLock(),
          claimsVerdict: createClaimsVerdictThunk(backend),
          uniqueSidecarBatch: uniqueSidecarBatchVerdict(backend),
        },
        backend,
        [],
        [],
        alreadyAppliedRowWrite,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & {
      details: Readonly<Record<string, unknown>>;
    };
    expect(error.details["code"]).toBe("RESOLVED_NODE_UNIQUENESS_UNSUPPORTED");
  });

  it("uniqueSidecarBatch / unique reap by node ids: TypeError, matching the registry's `refuse`", async () => {
    const base = createTestBackend();
    const backend = projectBackendWithout(base, ["hardDeleteUniquesByNodeIds"]);
    const registry = buildKindRegistry(uniqueRefusalGraph);
    const ctx = createUniquenessContext(
      uniqueRefusalGraph.id,
      registry,
      backend,
      uniqueSidecarBatchVerdict(backend),
    );
    await expect(
      hardDeleteClaimsByNodeIds(ctx, "UniqueRefusalWidget", ["id-1"]),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("contributionHealth / contribution verify", async () => {
    const base = createTestBackend();
    const backend = projectBackendWithout(base, ["verifyContributions"]);
    const store = createStore(refusalGraph, backend);

    let caught: unknown;
    try {
      await store.verifyContributions();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & {
      details: Readonly<Record<string, unknown>>;
      message: string;
    };
    expect(error.message).toBe(
      "verifyContributions requires a backend that can probe its catalog " +
        "for contribution tables.",
    );
    expect(error.details["capability"]).toBe("contributions");
    expect(error.details["operation"]).toBe("verify");
  });

  it("contributionHealth / contribution repair", async () => {
    const base = createTestBackend();
    const backend = projectBackendWithout(base, ["repairContributions"]);
    const store = createStore(refusalGraph, backend);

    let caught: unknown;
    try {
      await store.repairContributions();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & {
      details: Readonly<Record<string, unknown>>;
      message: string;
    };
    expect(error.message).toBe(
      "repairContributions requires a backend that can probe and repair " +
        "strategy-owned contribution tables.",
    );
    expect(error.details["capability"]).toBe("contributions");
    expect(error.details["operation"]).toBe("repair");
  });

  it("contributionHealth / contribution rebuild", async () => {
    const base = createTestBackend();
    const backend = projectBackendWithout(base, ["rebuildContribution"]);
    const store = createStore(refusalGraph, backend);

    let caught: unknown;
    try {
      await store.rebuildContribution("fulltext");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & {
      details: Readonly<Record<string, unknown>>;
      message: string;
    };
    expect(error.message).toBe(
      "rebuildContribution requires a backend that can drop, recreate, " +
        "and re-stamp strategy-owned contribution tables.",
    );
    expect(error.details["capability"]).toBe("contributions");
    expect(error.details["operation"]).toBe("rebuild");
  });

  it("contributionHealth / contribution probe (declarationGate): undeclared + absent falls back to {entries: []}", async () => {
    const base = createTestBackend();
    const { contributions: _dropped, ...capabilities } = base.capabilities;
    const backend = deriveBackend(
      projectBackendWithout(base, ["probeContributions"]),
      { capabilities },
    );
    const store = createStore(refusalGraph, backend);
    await expect(store.probeContributions()).resolves.toEqual({
      entries: [],
    });
  });

  it("contributionHealth / contribution probe (declarationGate): declared + absent refuses", async () => {
    const base = createTestBackend();
    // The default SQLite test backend declares `contributions.supported: true`.
    const backend = projectBackendWithout(base, ["probeContributions"]);
    const store = createStore(refusalGraph, backend);

    let caught: unknown;
    try {
      await store.probeContributions();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & {
      details: Readonly<Record<string, unknown>>;
      message: string;
    };
    expect(error.message).toBe(
      "probeContributions requires a backend that can probe its catalog " +
        "for contribution tables.",
    );
    expect(error.details["capability"]).toBe("contributions");
    expect(error.details["operation"]).toBe("probe");
  });

  it("recordedRevisionOrigins / revision tracking construction gate", () => {
    const base = createTestBackend();
    const backend = projectBackendWithout(base, ["ensureRevisionOriginsTable"]);

    expect(() =>
      createStore(refusalGraph, backend, { revisionTracking: true }),
    ).toThrow(
      "revisionTracking: true requires a backend that can bootstrap revision origins.",
    );
  });

  it("recordedRevisionOrigins / revision origin bootstrap: direct call on an unsupported verdict, and the registry names the row", async () => {
    const base = createTestBackend();
    const backend = projectBackendWithout(base, ["ensureRevisionOriginsTable"]);
    const verdict = recordedRevisionOriginsVerdict(backend);
    expect(verdict.supported).toBe(false);

    // Unreachable through the public API: `assertRevisionTrackableBackend`
    // (the "revision tracking construction gate" row, above) refuses first,
    // at store construction — the same gate-ordering fact B4's fixture (c)
    // ruling records for a different pair of gates.
    await expect(
      ensureRevisionOrigin(backend, verdict, createSqlSchema(), "test-graph"),
    ).rejects.toThrow(
      "Revision tracking requires a backend that can bootstrap revision origins.",
    );

    const registryRow = RECORDED_REVISION_ORIGINS.operations.find(
      (operation) => operation.operation === "revision origin bootstrap",
    );
    expect(registryRow?.disposition.kind).toBe("refuse");
  });
});
