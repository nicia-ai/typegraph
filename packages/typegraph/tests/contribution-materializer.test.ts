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

import { fts5Strategy, StoreNotInitializedError } from "../src";
import {
  type ContributionMaterializerDeps,
  createContributionMaterializer,
} from "../src/backend/drizzle/contribution-materializations";
import type {
  ContributionMaterializationIdentity,
  ContributionMaterializationRow,
  RecordContributionMaterializationParams,
} from "../src/backend/types";

const GRAPH_ID = "contrib-mat-unit";
const FULLTEXT_TABLE = "typegraph_node_fulltext";

// SQLite's missing-relation message — what `isMissingTableError` keys on
// for a never-bootstrapped marker table.
const MISSING_MARKER_TABLE_ERROR = new Error(
  "no such table: typegraph_contribution_materializations",
);

// Postgres' missing-relation failure as it actually reaches the gate:
// drizzle-orm wraps the query-builder `getMarker` SELECT in a
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
 * `getMarker` defaults to a map lookup; pass an override to simulate a
 * missing marker table or a hard read fault.
 */
function createMockMaterializer(
  markers: Map<string, ContributionMaterializationRow>,
  getMarkerOverride?: (
    identity: ContributionMaterializationIdentity,
  ) => Promise<ContributionMaterializationRow | undefined>,
) {
  const ensureMarkerTable = vi.fn((): Promise<void> => Promise.resolve());
  const execDdl = vi.fn(
    (_statement: string): Promise<void> => Promise.resolve(),
  );
  const getMarker = vi.fn(
    getMarkerOverride ??
      ((
        identity: ContributionMaterializationIdentity,
      ): Promise<ContributionMaterializationRow | undefined> =>
        Promise.resolve(markers.get(markerKey(identity)))),
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
    execDdl,
    ensureMarkerTable,
    getMarker,
    recordMarker,
  } satisfies ContributionMaterializerDeps;

  return {
    materializer: createContributionMaterializer(deps),
    spies: { ensureMarkerTable, execDdl, getMarker, recordMarker },
  };
}

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
    expect(warm.spies.getMarker).toHaveBeenCalled();
  });

  it("the per-materializer cache makes a redundant warm call a true no-op", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    await createMockMaterializer(
      markers,
    ).materializer.ensureRuntimeContributions(GRAPH_ID);

    const warm = createMockMaterializer(markers);
    await warm.materializer.ensureRuntimeContributions(GRAPH_ID);
    warm.spies.getMarker.mockClear();

    // Second call on the same instance hits the cache before any read.
    await warm.materializer.ensureRuntimeContributions(GRAPH_ID);
    expect(warm.spies.getMarker).not.toHaveBeenCalled();
  });

  it("still materializes (with DDL) when the marker table is missing", async () => {
    const markers = new Map<string, ContributionMaterializationRow>();
    let tableExists = false;
    const ensureMarkerTable = vi.fn((): Promise<void> => {
      tableExists = true;
      return Promise.resolve();
    });
    const execDdl = vi.fn(
      (_statement: string): Promise<void> => Promise.resolve(),
    );
    // Faithful to the real backend: the marker SELECT throws until
    // `ensureMarkerTable` has created the table.
    const getMarker = vi.fn(
      (
        identity: ContributionMaterializationIdentity,
      ): Promise<ContributionMaterializationRow | undefined> => {
        if (!tableExists) return Promise.reject(MISSING_MARKER_TABLE_ERROR);
        return Promise.resolve(markers.get(markerKey(identity)));
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
      execDdl,
      ensureMarkerTable,
      getMarker,
      recordMarker,
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
    // The #152 regression: on Postgres the pre-check `getMarker` SELECT
    // fails wrapped, so the missing-table signal lives on `.cause`. Before
    // the cause-walking fix this rethrew and broke first boot.
    let tableExists = false;
    const ensureMarkerTable = vi.fn((): Promise<void> => {
      tableExists = true;
      return Promise.resolve();
    });
    const execDdl = vi.fn(
      (_statement: string): Promise<void> => Promise.resolve(),
    );
    const markers = new Map<string, ContributionMaterializationRow>();
    const getMarker = vi.fn(
      (
        identity: ContributionMaterializationIdentity,
      ): Promise<ContributionMaterializationRow | undefined> =>
        tableExists ?
          Promise.resolve(markers.get(markerKey(identity)))
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
      execDdl,
      ensureMarkerTable,
      getMarker,
      recordMarker,
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
