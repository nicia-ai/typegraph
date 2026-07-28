/**
 * #149: `ensureRuntimeContributions` must be a read-only no-op when every
 * runtime contribution is already materialized — no marker `CREATE TABLE`,
 * no per-contribution DDL — mirroring the SELECT-only `assertInitialized`.
 *
 * These exercise `createContributionMaterializer` directly with mock deps
 * so the DDL seams (`ensureMarkerTable`, `execDdl`) are observable: a fresh
 * materializer instance (the per-request "fresh backend, empty cache" case)
 * opening an already-materialized graph must touch neither. The signature
 * value stays internal — both sides run the real `computeContributionSignature`
 * over the same contribution, so a recorded marker reads back as `initialized`
 * without the test hard-coding the hash.
 */
import { describe, expect, it, vi } from "vitest";

import {
  fts5Strategy,
  pgvectorStrategy,
  StoreNotInitializedError,
} from "../src";
import {
  type ContributionMaterializerDeps,
  createContributionMaterializer,
} from "../src/backend/drizzle/contribution-materializations";
import type {
  ContributionMaterializationIdentity,
  ContributionMaterializationRow,
  RecordContributionMaterializationParams,
} from "../src/backend/types";
import {
  type VectorSlot,
  type VectorStrategy,
} from "../src/query/dialect/vector-strategy";

const GRAPH_ID = "contrib-mat-unit";
const FULLTEXT_TABLE = "typegraph_node_fulltext";

// SQLite's missing-relation message — what `isMissingTableError` keys on
// for a never-bootstrapped marker table.
const MISSING_MARKER_TABLE_ERROR = new Error(
  "no such table: typegraph_contribution_materializations",
);

// Postgres' missing-relation failure as it actually reaches the gate:
// drizzle-orm wraps the query-builder marker SELECT in a
// `DrizzleQueryError` whose `.message` is the SQL text, with the real pg
// error (`relation ... does not exist` / SQLSTATE 42P01) on `.cause`.
// This is the #152 regression shape — the pre-check must still recognize
// it as a missing table and fall through to first materialization.
const POSTGRES_MISSING_MARKER_TABLE_ERROR = Object.assign(
  new Error(
    'Failed query: select * from "typegraph_contribution_materializations"\nparams: ',
  ),
  {
    cause: Object.assign(
      new Error(
        'relation "typegraph_contribution_materializations" does not exist',
      ),
      { code: "42P01" },
    ),
  },
);

function markerKey(identity: ContributionMaterializationIdentity): string {
  return [
    identity.graphId,
    identity.logicalName,
    identity.owner,
    identity.tableName,
  ].join("\0");
}

/**
 * Upsert a recorded attempt into the in-memory marker store, preserving a
 * prior success when this attempt failed (`materializedAt` undefined) —
 * the same COALESCE rule the real `buildContributionOnConflictSet` applies.
 */
function recordMarkerInto(
  markers: Map<string, ContributionMaterializationRow>,
  params: RecordContributionMaterializationParams,
): void {
  const key = markerKey(params);
  const prior = markers.get(key);
  markers.set(key, {
    graphId: params.graphId,
    logicalName: params.logicalName,
    owner: params.owner,
    tableName: params.tableName,
    signature: params.signature,
    materializedAt: params.materializedAt ?? prior?.materializedAt,
    lastAttemptedAt: params.attemptedAt,
    lastError: params.error,
  });
}

/**
 * A materializer wired to an in-memory marker store with spied DDL seams.
 * `getMarkers` defaults to a graph-scoped map lookup; pass an override to
 * simulate a missing marker table or a hard read fault.
 */
function createMockMaterializer(
  markers: Map<string, ContributionMaterializationRow>,
  getMarkersOverride?: (
    graphId: string,
  ) => Promise<readonly ContributionMaterializationRow[]>,
  vectorStrategy?: VectorStrategy,
  // Physical tables the catalog reports for `verifyContributions`.
  // `undefined` means "every table exists" — the healthy state every
  // non-diagnostic test in this file assumes.
  existingTables?: ReadonlySet<string>,
) {
  const ensureMarkerTable = vi.fn((): Promise<void> => Promise.resolve());
  const execDdl = vi.fn((_statement: string): Promise<void> =>
    Promise.resolve(),
  );
  const getMarkers = vi.fn(
    getMarkersOverride ??
      ((graphId: string): Promise<readonly ContributionMaterializationRow[]> =>
        Promise.resolve(
          [...markers.values()].filter((row) => row.graphId === graphId),
        )),
  );
  const recordMarker = vi.fn(
    (params: RecordContributionMaterializationParams): Promise<void> => {
      recordMarkerInto(markers, params);
      return Promise.resolve();
    },
  );
  const deleteMarker = vi.fn(
    (identity: ContributionMaterializationIdentity): Promise<void> => {
      markers.delete(markerKey(identity));
      return Promise.resolve();
    },
  );
  const tableExists = vi.fn((tableName: string): Promise<boolean> =>
    Promise.resolve(
      existingTables === undefined || existingTables.has(tableName),
    ),
  );

  const deps = {
    dialect: vectorStrategy === undefined ? "sqlite" : "postgres",
    fulltextStrategy: fts5Strategy,
    fulltextTableName: FULLTEXT_TABLE,
    vectorStrategy,
    execDdl,
    ensureMarkerTable,
    getMarkers,
    recordMarker,
    deleteMarker,
    tableExists,
  } satisfies ContributionMaterializerDeps;

  return {
    materializer: createContributionMaterializer(deps),
    spies: {
      ensureMarkerTable,
      execDdl,
      getMarkers,
      recordMarker,
      deleteMarker,
      tableExists,
    },
  };
}

/** The physical table `pgvectorStrategy` owns for a slot. */
function vectorTableOf(slot: VectorSlot): string {
  return pgvectorStrategy.tableName(
    slot.graphId,
    slot.nodeKind,
    slot.fieldPath,
  );
}

/**
 * Provision a graph at both a fulltext and a vector contribution — the
 * healthy starting state every diagnostic case then corrupts one half of.
 */
async function provision(
  markers: Map<string, ContributionMaterializationRow>,
): Promise<void> {
  const { materializer } = createMockMaterializer(
    markers,
    undefined,
    pgvectorStrategy,
  );
  await materializer.ensureRuntimeContributions(GRAPH_ID);
  await materializer.ensureVectorSlot(VECTOR_SLOT);
}

/** The physical tables the runtime (fulltext) contributions occupy. */
function runtimeTables(): readonly string[] {
  return fts5Strategy
    .ownedTables(FULLTEXT_TABLE)
    .filter((contribution) => contribution.runtimeEnsure)
    .map((contribution) => contribution.tableName);
}

// A representative embedding slot for the vector-contribution tests. Its
// physical table + marker identity derive from `pgvectorStrategy.ownedTables`.
const VECTOR_SLOT = {
  graphId: GRAPH_ID,
  nodeKind: "Document",
  fieldPath: "embedding",
  dimensions: 8,
  metric: "cosine",
  indexType: "hnsw",
} as const;

const SECOND_VECTOR_SLOT = {
  ...VECTOR_SLOT,
  fieldPath: "summaryEmbedding",
} as const;

describe("#149 ensureRuntimeContributions is read-only when already materialized", () => {
  it("a fresh materializer over an already-materialized graph runs zero DDL", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();

    // Cold boot: empty markers → the full materialization path runs DDL
    // and records the durable marker.
    const cold = createMockMaterializer(markers);
    await cold.materializer.ensureRuntimeContributions(GRAPH_ID);
    expect(cold.spies.ensureMarkerTable).toHaveBeenCalledTimes(1);
    expect(cold.spies.execDdl).toHaveBeenCalled();
    expect(markers.size).toBe(1);

    // Warm reopen with a FRESH materializer instance — the per-request
    // "new backend, empty per-instance cache" case the issue is about.
    const warm = createMockMaterializer(markers);
    await warm.materializer.ensureRuntimeContributions(GRAPH_ID);

    // #149: no marker `CREATE TABLE`, no contribution DDL, no marker write.
    expect(warm.spies.ensureMarkerTable).not.toHaveBeenCalled();
    expect(warm.spies.execDdl).not.toHaveBeenCalled();
    expect(warm.spies.recordMarker).not.toHaveBeenCalled();
    // It did consult the durable marker — a SELECT-only pre-check.
    expect(warm.spies.getMarkers).toHaveBeenCalled();
  });

  it("the per-materializer cache makes a redundant warm call a true no-op", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await createMockMaterializer(
      markers,
    ).materializer.ensureRuntimeContributions(GRAPH_ID);

    const warm = createMockMaterializer(markers);
    await warm.materializer.ensureRuntimeContributions(GRAPH_ID);
    warm.spies.getMarkers.mockClear();

    // Second call on the same instance hits the cache before any read.
    await warm.materializer.ensureRuntimeContributions(GRAPH_ID);
    expect(warm.spies.getMarkers).not.toHaveBeenCalled();
  });

  it("still materializes (with DDL) when the marker table is missing", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    let tableExists = false;
    const ensureMarkerTable = vi.fn((): Promise<void> => {
      tableExists = true;
      return Promise.resolve();
    });
    const execDdl = vi.fn((_statement: string): Promise<void> =>
      Promise.resolve(),
    );
    // Faithful to the real backend: the marker SELECT throws until
    // `ensureMarkerTable` has created the table.
    const getMarkers = vi.fn(
      (graphId: string): Promise<readonly ContributionMaterializationRow[]> => {
        if (!tableExists) return Promise.reject(MISSING_MARKER_TABLE_ERROR);
        return Promise.resolve(
          [...markers.values()].filter((row) => row.graphId === graphId),
        );
      },
    );
    const recordMarker = vi.fn(
      (params: RecordContributionMaterializationParams): Promise<void> => {
        recordMarkerInto(markers, params);
        return Promise.resolve();
      },
    );
    const deps = {
      dialect: "sqlite",
      fulltextStrategy: fts5Strategy,
      fulltextTableName: FULLTEXT_TABLE,
      vectorStrategy: undefined,
      execDdl,
      ensureMarkerTable,
      getMarkers,
      recordMarker,
      deleteMarker: vi.fn((): Promise<void> => Promise.resolve()),
      tableExists: vi.fn((): Promise<boolean> => Promise.resolve(true)),
    } satisfies ContributionMaterializerDeps;

    await createContributionMaterializer(deps).ensureRuntimeContributions(
      GRAPH_ID,
    );

    // The pre-check saw a missing marker table → fell through to the
    // privileged first-materialization path: create marker table, run DDL,
    // record the marker.
    expect(ensureMarkerTable).toHaveBeenCalledTimes(1);
    expect(execDdl).toHaveBeenCalled();
    expect(recordMarker).toHaveBeenCalled();
    expect(markers.size).toBe(1);
  });

  it("falls through to DDL when the marker table is missing behind a DrizzleQueryError (Postgres)", async () => {
    // The #152 regression: on Postgres the pre-check marker SELECT
    // fails wrapped, so the missing-table signal lives on `.cause`. Before
    // the cause-walking fix this rethrew and broke first boot.
    let tableExists = false;
    const ensureMarkerTable = vi.fn((): Promise<void> => {
      tableExists = true;
      return Promise.resolve();
    });
    const execDdl = vi.fn((_statement: string): Promise<void> =>
      Promise.resolve(),
    );
    const markers = new Map<string, ContributionMaterializationRow>();
    const getMarkers = vi.fn(
      (graphId: string): Promise<readonly ContributionMaterializationRow[]> =>
        tableExists ?
          Promise.resolve(
            [...markers.values()].filter((row) => row.graphId === graphId),
          )
        : Promise.reject(POSTGRES_MISSING_MARKER_TABLE_ERROR),
    );
    const recordMarker = vi.fn(
      (params: RecordContributionMaterializationParams): Promise<void> => {
        recordMarkerInto(markers, params);
        return Promise.resolve();
      },
    );
    const deps = {
      dialect: "postgres",
      fulltextStrategy: fts5Strategy,
      fulltextTableName: FULLTEXT_TABLE,
      vectorStrategy: undefined,
      execDdl,
      ensureMarkerTable,
      getMarkers,
      recordMarker,
      deleteMarker: vi.fn((): Promise<void> => Promise.resolve()),
      tableExists: vi.fn((): Promise<boolean> => Promise.resolve(true)),
    } satisfies ContributionMaterializerDeps;

    await expect(
      createContributionMaterializer(deps).ensureRuntimeContributions(GRAPH_ID),
    ).resolves.toBeUndefined();
    expect(ensureMarkerTable).toHaveBeenCalledTimes(1);
    expect(execDdl).toHaveBeenCalled();
    expect(markers.size).toBe(1);
  });

  it("propagates a non-missing-table read fault without attempting DDL", async () => {
    const fault = new Error("connection terminated unexpectedly");
    const { materializer, spies } = createMockMaterializer(new Map(), () =>
      Promise.reject(fault),
    );

    // The read-first pre-check must not swallow a genuine system fault and
    // proceed to DDL — it surfaces as-is.
    await expect(
      materializer.ensureRuntimeContributions(GRAPH_ID),
    ).rejects.toBe(fault);
    expect(spies.ensureMarkerTable).not.toHaveBeenCalled();
    expect(spies.execDdl).not.toHaveBeenCalled();
  });
});

describe("assertInitialized verdicts after the readContributionState refactor", () => {
  it("resolves without DDL when every contribution is materialized", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await createMockMaterializer(
      markers,
    ).materializer.ensureRuntimeContributions(GRAPH_ID);

    const warm = createMockMaterializer(markers);
    await expect(
      warm.materializer.assertInitialized(GRAPH_ID),
    ).resolves.toBeUndefined();
    expect(warm.spies.ensureMarkerTable).not.toHaveBeenCalled();
    expect(warm.spies.execDdl).not.toHaveBeenCalled();
  });

  it("throws StoreNotInitializedError(missing) when the marker table is missing", async () => {
    const { materializer } = createMockMaterializer(new Map(), () =>
      Promise.reject(MISSING_MARKER_TABLE_ERROR),
    );

    await expect(
      materializer.assertInitialized(GRAPH_ID),
    ).rejects.toMatchObject({
      name: "StoreNotInitializedError",
      details: { reason: "missing" },
    });
  });

  it("propagates a non-missing-table read fault as-is (not masked as missing)", async () => {
    const fault = new Error("permission denied for relation");
    const { materializer } = createMockMaterializer(new Map(), () =>
      Promise.reject(fault),
    );

    const rejection = await materializer
      .assertInitialized(GRAPH_ID)
      .catch((error: unknown) => error);
    expect(rejection).toBe(fault);
    expect(rejection).not.toBeInstanceOf(StoreNotInitializedError);
  });
});

describe("vector slot contributions ride the same durable-marker machinery", () => {
  it("batches marker reads across vector slots at boot and verified attach", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    const cold = createMockMaterializer(markers, undefined, pgvectorStrategy);

    await cold.materializer.ensureVectorSlots([
      VECTOR_SLOT,
      SECOND_VECTOR_SLOT,
    ]);

    expect(cold.spies.ensureMarkerTable).toHaveBeenCalledTimes(1);
    // One read-only pre-check plus one post-bootstrap race check, independent
    // of the number of slots.
    expect(cold.spies.getMarkers).toHaveBeenCalledTimes(2);
    expect(markers.size).toBe(2);

    const verified = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
    );
    await verified.materializer.assertVectorSlots([
      VECTOR_SLOT,
      SECOND_VECTOR_SLOT,
    ]);
    expect(verified.spies.getMarkers).toHaveBeenCalledTimes(1);

    verified.spies.getMarkers.mockClear();
    await verified.materializer.assertVectorSlots([
      VECTOR_SLOT,
      SECOND_VECTOR_SLOT,
    ]);
    expect(verified.spies.getMarkers).not.toHaveBeenCalled();
  });

  it("ensureVectorSlot materializes the per-field table + marker on cold boot", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    const cold = createMockMaterializer(markers, undefined, pgvectorStrategy);

    await cold.materializer.ensureVectorSlot(VECTOR_SLOT);

    expect(cold.spies.ensureMarkerTable).toHaveBeenCalledTimes(1);
    expect(cold.spies.execDdl).toHaveBeenCalled();
    expect(markers.size).toBe(1);
  });

  it("assertVectorSlot throws StoreNotInitializedError before provisioning — never DDL", async () => {
    const { materializer, spies } = createMockMaterializer(
      new Map(),
      () => Promise.reject(MISSING_MARKER_TABLE_ERROR),
      pgvectorStrategy,
    );

    await expect(
      materializer.assertVectorSlot(VECTOR_SLOT),
    ).rejects.toMatchObject({
      name: "StoreNotInitializedError",
      details: { reason: "missing" },
    });
    // The hot-path gate never tries to create anything on a USAGE-only role.
    expect(spies.execDdl).not.toHaveBeenCalled();
    expect(spies.ensureMarkerTable).not.toHaveBeenCalled();
  });

  it("assertVectorSlot resolves with zero DDL once a fresh instance reopens a provisioned slot", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
    ).materializer.ensureVectorSlot(VECTOR_SLOT);

    const warm = createMockMaterializer(markers, undefined, pgvectorStrategy);
    await expect(
      warm.materializer.assertVectorSlot(VECTOR_SLOT),
    ).resolves.toBeUndefined();
    expect(warm.spies.execDdl).not.toHaveBeenCalled();
    expect(warm.spies.ensureMarkerTable).not.toHaveBeenCalled();
    expect(warm.spies.getMarkers).toHaveBeenCalled();
  });

  it("ensureVectorSlot refuses a dimension change as drift, but { force: true } re-stamps it", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
    ).materializer.ensureVectorSlot(VECTOR_SLOT);

    // A dimension change keeps the same (kind, field) table identity but
    // changes the createDdl signature — drift. A fresh instance must refuse
    // it loudly rather than silently bless a stale table.
    const changed = { ...VECTOR_SLOT, dimensions: 16 } as const;
    await expect(
      createMockMaterializer(
        markers,
        undefined,
        pgvectorStrategy,
      ).materializer.ensureVectorSlot(changed),
    ).rejects.toThrow(/different signature/);

    // `reembedVectorField`'s path: force past the drift-guard after the
    // table was recreated at the new dimension.
    await createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
    ).materializer.ensureVectorSlot(changed, { force: true });

    // The marker now reads back as initialized at the new shape.
    const warm = createMockMaterializer(markers, undefined, pgvectorStrategy);
    await expect(
      warm.materializer.assertVectorSlot(changed),
    ).resolves.toBeUndefined();
  });

  it("the SAME instance's warm cache does not skip the drift-guard on a dimension change", async () => {
    // The positive cache is keyed by contribution identity AND signature: a
    // shape change on the very instance that just ensured the slot must
    // miss the cache and reach the drift-guard, not be silently accepted.
    const markers = new Map<string, ContributionMaterializationRow>();
    const { materializer } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
    );
    await materializer.ensureVectorSlot(VECTOR_SLOT);

    await expect(
      materializer.ensureVectorSlot({ ...VECTOR_SLOT, dimensions: 16 }),
    ).rejects.toThrow(/different signature/);

    // The guard is SIGNATURE-based, not parameter-based: a pgvector metric
    // change leaves the table DDL (and so the physical shape) identical —
    // metric only affects the search operator and the ANN index — so it is
    // correctly treated as already materialized rather than as drift.
    await expect(
      materializer.ensureVectorSlot({ ...VECTOR_SLOT, metric: "l2" }),
    ).resolves.toBeUndefined();
  });

  it("memoizes WebCrypto signatures until the canonical DDL input changes", async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    try {
      const markers = new Map<string, ContributionMaterializationRow>();
      const { materializer } = createMockMaterializer(
        markers,
        undefined,
        pgvectorStrategy,
      );
      await materializer.ensureVectorSlot(VECTOR_SLOT);
      const digestCallsAfterProvisioning = digest.mock.calls.length;

      await materializer.assertVectorSlot(VECTOR_SLOT);
      await materializer.assertVectorSlot(VECTOR_SLOT);
      await materializer.ensureVectorSlot(VECTOR_SLOT);
      expect(digest).toHaveBeenCalledTimes(digestCallsAfterProvisioning);

      await expect(
        materializer.assertVectorSlot({ ...VECTOR_SLOT, dimensions: 16 }),
      ).rejects.toMatchObject({
        name: "StoreNotInitializedError",
        details: { reason: "stale" },
      });
      expect(digest).toHaveBeenCalledTimes(digestCallsAfterProvisioning + 1);
    } finally {
      digest.mockRestore();
    }
  });

  it("the SAME instance's warm assert sees a shape change as stale, not initialized", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    const { materializer, spies } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
    );
    await materializer.ensureVectorSlot(VECTOR_SLOT);
    // Warm the assert cache at the original shape.
    await expect(
      materializer.assertVectorSlot(VECTOR_SLOT),
    ).resolves.toBeUndefined();

    // The changed shape must not ride the warm cache: it reads the marker,
    // sees signature drift, and refuses as stale — still with zero DDL.
    const changed = { ...VECTOR_SLOT, dimensions: 16 } as const;
    await expect(materializer.assertVectorSlot(changed)).rejects.toMatchObject({
      name: "StoreNotInitializedError",
      details: { reason: "stale" },
    });
    expect(spies.execDdl).toHaveBeenCalledTimes(
      pgvectorStrategy
        .ownedTables(VECTOR_SLOT)
        .flatMap((contribution) => contribution.createDdl).length,
    ); // only the original ensure's DDL — the assert path added none

    // The original shape stays cached and keeps passing.
    await expect(
      materializer.assertVectorSlot(VECTOR_SLOT),
    ).resolves.toBeUndefined();
  });

  it("a { force: true } re-stamp on the SAME instance invalidates the old shape's cache entry", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    const { materializer } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
    );
    await materializer.ensureVectorSlot(VECTOR_SLOT);
    await materializer.assertVectorSlot(VECTOR_SLOT); // warm at dim 8

    // reembedVectorField's path: recreate at dim 16 and force-restamp.
    const changed = { ...VECTOR_SLOT, dimensions: 16 } as const;
    await materializer.ensureVectorSlot(changed, { force: true });

    // The new shape asserts clean; the OLD shape must now read as stale on
    // this same instance — its cache entry was overwritten by the restamp.
    await expect(
      materializer.assertVectorSlot(changed),
    ).resolves.toBeUndefined();
    await expect(
      materializer.assertVectorSlot(VECTOR_SLOT),
    ).rejects.toMatchObject({
      name: "StoreNotInitializedError",
      details: { reason: "stale" },
    });
  });

  it("ensureVectorSlot({ onDrift: 'skip' }) leaves a drifted slot untouched instead of refusing", async () => {
    // The boot/evolve path: the declared dimension moved ahead of the
    // provisioned table. Boot must complete (warn, no throw), the marker
    // must stay EXACTLY as it was (old shape still reads initialized; new
    // shape reads stale until reembedVectorField force-restamps), and no
    // DDL may run against the stale table.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      // Silence the drift warning in test output; the spy asserts it fired.
    });
    try {
      const markers = new Map<string, ContributionMaterializationRow>();
      const { materializer, spies } = createMockMaterializer(
        markers,
        undefined,
        pgvectorStrategy,
      );
      await materializer.ensureVectorSlot(VECTOR_SLOT);
      const markerBefore = [...markers.values()];
      spies.execDdl.mockClear();
      spies.recordMarker.mockClear();

      const changed = { ...VECTOR_SLOT, dimensions: 16 } as const;
      await expect(
        materializer.ensureVectorSlot(changed, { onDrift: "skip" }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(spies.execDdl).not.toHaveBeenCalled();
      expect(spies.recordMarker).not.toHaveBeenCalled();
      expect([...markers.values()]).toEqual(markerBefore);

      // Nothing was blessed: the drifted shape still asserts stale on this
      // same instance, and the provisioned shape keeps passing.
      await expect(
        materializer.assertVectorSlot(changed),
      ).rejects.toMatchObject({
        name: "StoreNotInitializedError",
        details: { reason: "stale" },
      });
      await expect(
        materializer.assertVectorSlot(VECTOR_SLOT),
      ).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("dropVectorSlot forgets the marker so a later ensure re-creates the table", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    const first = createMockMaterializer(markers, undefined, pgvectorStrategy);
    await first.materializer.ensureVectorSlot(VECTOR_SLOT);
    expect(markers.size).toBe(1);

    // Reclaim drops the physical table; dropVectorSlot must delete the marker
    // so a stale "initialized" row can't outlive it.
    await first.materializer.dropVectorSlot(VECTOR_SLOT);
    expect(markers.size).toBe(0);

    // A fresh instance (cold cache) now sees "missing" and the assert refuses.
    const warm = createMockMaterializer(markers, undefined, pgvectorStrategy);
    await expect(
      warm.materializer.assertVectorSlot(VECTOR_SLOT),
    ).rejects.toBeInstanceOf(StoreNotInitializedError);

    // ...and a re-provision runs the CREATE again rather than trusting a marker.
    const reprovision = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
    );
    await reprovision.materializer.ensureVectorSlot(VECTOR_SLOT);
    expect(reprovision.spies.execDdl).toHaveBeenCalled();
    expect(markers.size).toBe(1);
  });

  it("ensureVectorSlot/assertVectorSlot are no-ops when vector support is disabled", async () => {
    // No vectorStrategy → the materializer can't address any slot; both
    // methods resolve without touching the marker store.
    const { materializer, spies } = createMockMaterializer(new Map());
    await expect(
      materializer.ensureVectorSlot(VECTOR_SLOT),
    ).resolves.toBeUndefined();
    await expect(
      materializer.assertVectorSlot(VECTOR_SLOT),
    ).resolves.toBeUndefined();
    expect(spies.getMarkers).not.toHaveBeenCalled();
    expect(spies.execDdl).not.toHaveBeenCalled();
  });
});

/**
 * #324: the marker-vs-catalog diagnostic. These verdicts cover catalog drift
 * the ensure/assert paths cannot see plus recorded failed materializations,
 * which are unusable even when marker and catalog agree.
 */
describe("verifyContributions audits currently declared contributions", () => {
  it("reports nothing when every current contribution is healthy", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await provision(markers);

    const { materializer } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
      new Set([...runtimeTables(), vectorTableOf(VECTOR_SLOT)]),
    );
    await expect(
      materializer.verifyContributions(GRAPH_ID, [VECTOR_SLOT]),
    ).resolves.toEqual([]);
  });

  it("ignores marker rows outside the current declaration set", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await provision(markers);
    const retiredTable = "tg_retired_contribution";
    recordMarkerInto(markers, {
      graphId: GRAPH_ID,
      logicalName: "retired",
      owner: "retired-strategy",
      tableName: retiredTable,
      signature: "retired-signature",
      attemptedAt: new Date().toISOString(),
      materializedAt: new Date().toISOString(),
      error: undefined,
    });

    const { materializer, spies } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
      new Set([...runtimeTables(), vectorTableOf(VECTOR_SLOT), retiredTable]),
    );
    await expect(
      materializer.verifyContributions(GRAPH_ID, [VECTOR_SLOT]),
    ).resolves.toEqual([]);
    expect(spies.tableExists).not.toHaveBeenCalledWith(retiredTable);
  });

  it("reports a dropped vector table with a live marker as orphaned-marker", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await provision(markers);

    // The failure mode the issue describes: the tg_vec_* table was dropped
    // out of band, the "initialized" marker survived, and the store opens
    // completely clean.
    const { materializer } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
      new Set(runtimeTables()),
    );

    // The entry carries identity from the active declaration, matching the
    // marker contract, so a caller routes it to
    // store.reembedVectorField(kind, fieldPath) without reconstructing any
    // internal naming contract even when the row itself is missing.
    const [owned] = pgvectorStrategy.ownedTables(VECTOR_SLOT);
    await expect(
      materializer.verifyContributions(GRAPH_ID, [VECTOR_SLOT]),
    ).resolves.toEqual([
      {
        owner: owned?.owner,
        logicalName: owned?.logicalName,
        physicalName: vectorTableOf(VECTOR_SLOT),
        kind: VECTOR_SLOT.nodeKind,
        fieldPath: VECTOR_SLOT.fieldPath,
        state: "orphaned-marker",
      },
    ]);
  });

  it("reports a live table whose marker was forgotten as missing-marker", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await provision(markers);

    const existing = new Set([...runtimeTables(), vectorTableOf(VECTOR_SLOT)]);
    const { materializer } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
      existing,
    );
    // Reclaim-style marker deletion WITHOUT the table drop that should
    // accompany it.
    await materializer.dropVectorSlot(VECTOR_SLOT);

    await expect(
      materializer.verifyContributions(GRAPH_ID, [VECTOR_SLOT]),
    ).resolves.toMatchObject([
      {
        physicalName: vectorTableOf(VECTOR_SLOT),
        kind: VECTOR_SLOT.nodeKind,
        fieldPath: VECTOR_SLOT.fieldPath,
        state: "missing-marker",
      },
    ]);
  });

  it("carries the marker's recorded error through the state fold", async () => {
    // A failed attempt can surface as `missing-marker` when the physical
    // table exists. The recorded reason is the part the catalog cannot
    // supply; a missing row has no reason to carry through.
    const markers = new Map<string, ContributionMaterializationRow>();
    await provision(markers);
    const failure = "could not open shared library: sqlite-vec";
    const { materializer } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
      new Set([...runtimeTables(), vectorTableOf(VECTOR_SLOT)]),
    );
    for (const contribution of pgvectorStrategy.ownedTables(VECTOR_SLOT)) {
      recordMarkerInto(markers, {
        graphId: GRAPH_ID,
        logicalName: contribution.logicalName,
        owner: contribution.owner,
        tableName: contribution.tableName,
        signature: "unused-signature",
        attemptedAt: new Date().toISOString(),
        materializedAt: undefined,
        error: failure,
      });
    }

    await expect(
      materializer.verifyContributions(GRAPH_ID, [VECTOR_SLOT]),
    ).resolves.toMatchObject([{ state: "missing-marker", lastError: failure }]);
  });

  it("omits lastError entirely when the marker recorded none", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await provision(markers);
    const { materializer } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
      new Set(runtimeTables()),
    );

    // `toStrictEqual` (not `toEqual`) so a present-but-undefined
    // `lastError` key would fail: the field is absent, not blank.
    const [owned] = pgvectorStrategy.ownedTables(VECTOR_SLOT);
    await expect(
      materializer.verifyContributions(GRAPH_ID, [VECTOR_SLOT]),
    ).resolves.toStrictEqual([
      {
        owner: owned?.owner,
        logicalName: owned?.logicalName,
        physicalName: vectorTableOf(VECTOR_SLOT),
        kind: VECTOR_SLOT.nodeKind,
        fieldPath: VECTOR_SLOT.fieldPath,
        state: "orphaned-marker",
      },
    ]);
  });

  it("reports signature drift against a live table as stale", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await provision(markers);

    // The declared dimension moved ahead of the provisioned table — the
    // shape `evaluateContributionState` already models, surfaced by name.
    const changed = { ...VECTOR_SLOT, dimensions: 16 } as const;
    const { materializer } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
      new Set([...runtimeTables(), vectorTableOf(changed)]),
    );

    await expect(
      materializer.verifyContributions(GRAPH_ID, [changed]),
    ).resolves.toMatchObject([{ state: "stale" }]);
  });

  it("reports a failed attempt that produced no table as failed-materialization", async () => {
    // The state a contribution lands in when provisioning genuinely broke:
    // `fts5` module absent, no CREATE privilege, extension never loaded.
    // Marker and catalog AGREE (both say "nothing there") — reporting it
    // clean on that basis would hide the exact case an operator is hunting.
    const markers = new Map<string, ContributionMaterializationRow>();
    const failure = "no such module: fts5";
    const contributions = fts5Strategy
      .ownedTables(FULLTEXT_TABLE)
      .filter((contribution) => contribution.runtimeEnsure);
    for (const contribution of contributions) {
      recordMarkerInto(markers, {
        graphId: GRAPH_ID,
        logicalName: contribution.logicalName,
        owner: contribution.owner,
        tableName: contribution.tableName,
        signature: "unused-signature",
        attemptedAt: new Date().toISOString(),
        materializedAt: undefined,
        error: failure,
      });
    }

    const { materializer } = createMockMaterializer(
      markers,
      undefined,
      undefined,
      new Set(),
    );
    await expect(
      materializer.verifyContributions(GRAPH_ID, []),
    ).resolves.toMatchObject([
      { state: "failed-materialization", lastError: failure },
    ]);
  });

  it("stays silent on a contribution that was never provisioned at all", async () => {
    // No marker row AND no table means nothing was ever attempted — boot
    // will provision it on the next privileged run. This is the ONLY silent
    // table-absent case; the discriminating counterpart is the test above,
    // where a marker row recording a failure makes the same missing table
    // `failed-materialization` rather than silence.
    const { materializer } = createMockMaterializer(
      new Map(),
      undefined,
      pgvectorStrategy,
      new Set(),
    );
    await expect(
      materializer.verifyContributions(GRAPH_ID, [VECTOR_SLOT]),
    ).resolves.toEqual([]);
  });

  it("reports every live table as missing-marker when the marker table is absent", async () => {
    const { materializer } = createMockMaterializer(
      new Map(),
      () => Promise.reject(MISSING_MARKER_TABLE_ERROR),
      pgvectorStrategy,
    );

    const diagnostics = await materializer.verifyContributions(GRAPH_ID, [
      VECTOR_SLOT,
    ]);
    expect(diagnostics.length).toBe(runtimeTables().length + 1);
    expect(diagnostics.every((entry) => entry.state === "missing-marker")).toBe(
      true,
    );
  });

  it("mutates nothing — no DDL, no marker writes, no marker-table bootstrap", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await provision(markers);
    const markersBefore = [...markers.values()];

    const { materializer, spies } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
      new Set(),
    );
    await materializer.verifyContributions(GRAPH_ID, [VECTOR_SLOT]);

    expect(spies.execDdl).not.toHaveBeenCalled();
    expect(spies.recordMarker).not.toHaveBeenCalled();
    expect(spies.ensureMarkerTable).not.toHaveBeenCalled();
    expect(spies.deleteMarker).not.toHaveBeenCalled();
    expect([...markers.values()]).toEqual(markersBefore);
  });

  it("probes each distinct physical table exactly once per call", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await provision(markers);

    const { materializer, spies } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
      new Set([...runtimeTables(), vectorTableOf(VECTOR_SLOT)]),
    );
    // The same slot twice must not cost two round trips.
    await materializer.verifyContributions(GRAPH_ID, [
      VECTOR_SLOT,
      VECTOR_SLOT,
    ]);

    const probed = spies.tableExists.mock.calls.map(([tableName]) => tableName);
    expect(new Set(probed).size).toBe(probed.length);
  });

  it("re-probes on every call — a table confirmed present can disappear", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await provision(markers);

    const existing = new Set([...runtimeTables(), vectorTableOf(VECTOR_SLOT)]);
    const { materializer } = createMockMaterializer(
      markers,
      undefined,
      pgvectorStrategy,
      existing,
    );
    await expect(
      materializer.verifyContributions(GRAPH_ID, [VECTOR_SLOT]),
    ).resolves.toEqual([]);

    existing.delete(vectorTableOf(VECTOR_SLOT));
    await expect(
      materializer.verifyContributions(GRAPH_ID, [VECTOR_SLOT]),
    ).resolves.toMatchObject([{ state: "orphaned-marker" }]);
  });

  it("skips vector slots when vector support is disabled, still checking fulltext", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    const noVector = createMockMaterializer(markers);
    await noVector.materializer.ensureRuntimeContributions(GRAPH_ID);

    // Fulltext table dropped, vector slot unaddressable by this backend.
    const { materializer } = createMockMaterializer(
      markers,
      undefined,
      undefined,
      new Set(),
    );
    const diagnostics = await materializer.verifyContributions(GRAPH_ID, [
      VECTOR_SLOT,
    ]);

    expect(diagnostics).toMatchObject([{ state: "orphaned-marker" }]);
    expect(
      diagnostics.some(
        (entry) => entry.physicalName === vectorTableOf(VECTOR_SLOT),
      ),
    ).toBe(false);
  });
});
