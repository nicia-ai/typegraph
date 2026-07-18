/**
 * Shared building blocks for the
 * `typegraph_contribution_materializations` durable-marker table on
 * both SQLite and Postgres backends (#135).
 *
 * Independent sibling of `index-materializations.ts`. It deliberately
 * mirrors that module's shape — dialect timestamp adapter, raw-row
 * mapper, insert/upsert value builders, the `materialized_at` COALESCE
 * preservation rule for failed re-attempts — but stays a separate
 * module because the two status tables have different identities:
 * declared indexes key on a database-global physical index name,
 * #129 contributions key on `(graph_id, logical_name, owner,
 * table_name)`. The declared-index path is untouched by #135; a future
 * PR may migrate it onto this contribution model.
 */

import { sql } from "drizzle-orm";

import {
  StoreNotInitializedError,
  type StoreNotInitializedReason,
} from "../../errors";
import { type FulltextStrategy } from "../../query/dialect/fulltext-strategy";
import { type SqlDialect } from "../../query/dialect/types";
import {
  type VectorSlot,
  type VectorStrategy,
} from "../../query/dialect/vector-strategy";
import { sortedReplacer } from "../../schema/canonical";
import { sha256Hex } from "../../utils/hash";
import { isMissingTableError } from "../../utils/sql-errors";
import { formatPostgresTimestamp, nowIso } from "../row-mappers";
import type { StrategyTableContribution } from "../table-contribution";
import {
  type ContributionMaterializationIdentity,
  type ContributionMaterializationRow,
  createBackendOverlay,
  type RecordContributionMaterializationParams,
  type TransactionBackend,
} from "../types";
import { runtimeStrategyContributions } from "./ddl";

/**
 * Bridges the dialect-specific timestamp column representation to the
 * canonical ISO-8601 strings used by the row/param types. `string` for
 * SQLite TEXT, `Date` for Postgres TIMESTAMPTZ — identical contract to
 * the index-materialization adapter, kept separate so the two status
 * subsystems stay independent.
 */
type ContributionMaterializationTimestampAdapter<TEncoded> = Readonly<{
  /** Convert a stored column value to ISO-8601 (or `undefined`). */
  decode(value: unknown): string | undefined;
  /** Convert an ISO-8601 string to the value Drizzle expects on insert. */
  encode(value: string): TEncoded;
}>;

export const SQLITE_CONTRIBUTION_MAT_TIMESTAMPS: ContributionMaterializationTimestampAdapter<string> =
  {
    decode: (value) => (typeof value === "string" ? value : undefined),
    encode: (value) => value,
  };

export const POSTGRES_CONTRIBUTION_MAT_TIMESTAMPS: ContributionMaterializationTimestampAdapter<Date> =
  {
    decode: formatPostgresTimestamp,
    encode: (value) => new Date(value),
  };

/**
 * Raw shape Drizzle returns for one row of
 * `typegraph_contribution_materializations`. The caller has already
 * narrowed via the typed table query; this just spells out the
 * dialect-shared field set so `mapContributionMaterializationRow` can
 * decode it.
 */
type RawContributionMaterializationRow = Readonly<{
  graphId: string;
  logicalName: string;
  owner: string;
  tableName: string;
  signature: string;
  materializedAt: unknown;
  lastAttemptedAt: unknown;
  lastError: string | null;
}>;

export function mapContributionMaterializationRow(
  row: RawContributionMaterializationRow,
  decode: (value: unknown) => string | undefined,
): ContributionMaterializationRow {
  const lastAttemptedAt = decode(row.lastAttemptedAt);
  if (lastAttemptedAt === undefined) {
    throw new Error(
      `contribution materialization row missing required ` +
        `last_attempted_at: ${row.graphId}/${row.logicalName}`,
    );
  }
  return {
    graphId: row.graphId,
    logicalName: row.logicalName,
    owner: row.owner,
    tableName: row.tableName,
    signature: row.signature,
    materializedAt: decode(row.materializedAt),
    lastAttemptedAt,
    lastError: row.lastError ?? undefined,
  };
}

/**
 * Build the column values for the upsert. Timestamp columns are encoded
 * through the adapter so the dialect's Drizzle column type gets the
 * value-shape it expects.
 */
export function buildContributionInsertValues<TEncoded>(
  params: RecordContributionMaterializationParams,
  encode: (value: string) => TEncoded,
): Readonly<{
  graphId: string;
  logicalName: string;
  owner: string;
  tableName: string;
  signature: string;
  materializedAt: TEncoded | undefined;
  lastAttemptedAt: TEncoded;
  lastError: string | undefined;
}> {
  return {
    graphId: params.graphId,
    logicalName: params.logicalName,
    owner: params.owner,
    tableName: params.tableName,
    signature: params.signature,
    materializedAt:
      params.materializedAt === undefined ?
        undefined
      : encode(params.materializedAt),
    lastAttemptedAt: encode(params.attemptedAt),
    lastError: params.error,
  };
}

/**
 * Build the `set` clause for the upsert's ON CONFLICT DO UPDATE.
 *
 * The identity columns are the conflict target (composite primary key)
 * so they are never in the set clause. `materializedAt` uses `COALESCE`
 * to preserve any prior successful timestamp when this attempt failed
 * (`materializedAt === undefined`); on success the new timestamp wins.
 * Identical preservation rule to `buildMaterializationOnConflictSet`,
 * keeping a stale/failed boot retry from erasing the historical
 * success another replica recorded.
 */
export function buildContributionOnConflictSet(
  materializedAtColumn: unknown,
  paramsMaterializedAt: string | undefined,
): Readonly<Record<string, ReturnType<typeof sql>>> {
  const materializedAtSet =
    paramsMaterializedAt === undefined ?
      sql`COALESCE(excluded.${sql.identifier("materialized_at")}, ${materializedAtColumn})`
    : sql`excluded.${sql.identifier("materialized_at")}`;
  return {
    signature: sql`excluded.${sql.identifier("signature")}`,
    materializedAt: materializedAtSet,
    lastAttemptedAt: sql`excluded.${sql.identifier("last_attempted_at")}`,
    lastError: sql`excluded.${sql.identifier("last_error")}`,
  };
}

/**
 * Canonical hash of a resolved contribution's drift surface:
 * `{ dialect, owner, logicalName, tableName, createDdl }`. #129
 * guarantees `createDdl` is deterministic for a given resolved
 * configuration, so this hash is a meaningful staleness discriminant.
 * A strategy swap (different `owner`) or a DDL change on the same
 * logical slot changes the signature → detectable drift. 32 hex chars
 * because it is compared against an externally-stored signature.
 */
function contributionSignatureInput(
  dialect: SqlDialect,
  identity: Readonly<{
    owner: string;
    logicalName: string;
    tableName: string;
  }>,
  createDdl: readonly string[],
): string {
  const hashable = {
    dialect,
    owner: identity.owner,
    logicalName: identity.logicalName,
    tableName: identity.tableName,
    createDdl,
  };
  return JSON.stringify(hashable, sortedReplacer);
}

/**
 * Whether a contribution is usable on the current connection, derived
 * from its durable marker row and the freshly-computed signature.
 *
 * - `missing`: no row — never initialized.
 * - `failed`: the last recorded attempt errored. Boot may retry; the
 *   hot path must refuse.
 * - `stale`: a row exists but its recorded signature no longer matches
 *   (strategy swap / DDL drift). Refuse rather than silently
 *   re-materialize on a hot path.
 * - `initialized`: signature matches, a successful `materializedAt` is
 *   recorded, and the last attempt did not error.
 */
// The non-initialized states are exactly `StoreNotInitializedError`'s
// reasons — derive the union so the two cannot drift apart and the
// assert can pass the state straight through as the error reason.
type ContributionMaterializationState =
  "initialized" | StoreNotInitializedReason;

function evaluateContributionState(
  row: ContributionMaterializationRow | undefined,
  signature: string,
): ContributionMaterializationState {
  if (row === undefined) return "missing";
  if (row.lastError !== undefined) return "failed";
  if (row.signature !== signature) return "stale";
  if (row.materializedAt === undefined) return "missing";
  return "initialized";
}

function identityOf(
  graphId: string,
  contribution: StrategyTableContribution,
): ContributionMaterializationIdentity {
  return {
    graphId,
    logicalName: contribution.logicalName,
    owner: contribution.owner,
    tableName: contribution.tableName,
  };
}

/**
 * The fulltext-touching methods the durable-marker gate wraps. The five
 * `upsert*`/`delete*`/`fulltextSearch` are optional (a graph with no
 * `searchable()` fields has none); `hardDeleteNode` is always present
 * because its cascade unconditionally deletes from the fulltext table.
 */
export type GatableFulltextBackend = Pick<
  TransactionBackend,
  | "upsertFulltext"
  | "deleteFulltext"
  | "upsertFulltextBatch"
  | "deleteFulltextBatch"
  | "fulltextSearch"
  | "hardDeleteNode"
>;

/**
 * The fulltext point-of-use gate, as the wrapped overrides only. Each
 * method asserts the durable contribution marker before delegating; an
 * optional method is wrapped only when present. `assert` performs only
 * a (cached) SELECT — never DDL — so it is safe inside an open
 * transaction. The single source of the gating contract: both the
 * non-tx backend and the tx-scoped {@link gateFulltext} consume it.
 */
export function gateFulltextMethods(
  source: GatableFulltextBackend,
  assert: (graphId: string) => Promise<void>,
): Partial<GatableFulltextBackend> {
  // Only assign an override when the raw method exists, so the "wrap
  // only what's defined" rule stays obvious instead of hiding behind
  // conditional spreads.
  const gated: {
    -readonly [K in keyof GatableFulltextBackend]?: GatableFulltextBackend[K];
  } = {};

  if (source.upsertFulltext) {
    const raw = source.upsertFulltext;
    gated.upsertFulltext = async (params) => {
      await assert(params.graphId);
      await raw(params);
    };
  }
  if (source.deleteFulltext) {
    const raw = source.deleteFulltext;
    gated.deleteFulltext = async (params) => {
      await assert(params.graphId);
      await raw(params);
    };
  }
  if (source.upsertFulltextBatch) {
    const raw = source.upsertFulltextBatch;
    gated.upsertFulltextBatch = async (params) => {
      // A genuine no-op call asserts nothing — the "empty input is
      // harmless" contract.
      if (params.rows.length === 0) return;
      await assert(params.graphId);
      await raw(params);
    };
  }
  if (source.deleteFulltextBatch) {
    const raw = source.deleteFulltextBatch;
    gated.deleteFulltextBatch = async (params) => {
      if (params.nodeIds.length === 0) return;
      await assert(params.graphId);
      await raw(params);
    };
  }
  if (source.fulltextSearch) {
    const raw = source.fulltextSearch;
    gated.fulltextSearch = async (params) => {
      await assert(params.graphId);
      return raw(params);
    };
  }
  // Unconditional: the hard-delete cascade deletes from the fulltext
  // table even for graphs that declare no `searchable()` fields.
  const rawHardDelete = source.hardDeleteNode;
  gated.hardDeleteNode = async (params) => {
    await assert(params.graphId);
    await rawHardDelete(params);
  };
  return gated;
}

/**
 * Tx-scoped variant: a {@link TransactionBackend} with its fulltext
 * methods gated. The tx-scoped backend exposes RAW fulltext methods (no
 * self-ensure); a transaction that never touches fulltext never
 * asserts, so non-fulltext transactions stay free of any fulltext-init
 * requirement.
 */
export function gateFulltext(
  tx: TransactionBackend,
  assert: (graphId: string) => Promise<void>,
): TransactionBackend {
  return createBackendOverlay<TransactionBackend>(
    tx,
    gateFulltextMethods(tx, assert),
  );
}

// ============================================================
// Materializer (#135) — the one place orchestration lives
// ============================================================

/**
 * The dialect-specific seams the materializer needs. Mirrors how the
 * index-materialization subsystem keeps orchestration dialect-agnostic
 * (`store/materialize-indexes.ts`) and leaves only thin primitives in
 * each backend.
 */
export type ContributionMaterializerDeps = Readonly<{
  dialect: SqlDialect;
  fulltextStrategy: FulltextStrategy;
  fulltextTableName: string;
  /**
   * Active vector strategy, or `undefined` when vector support is
   * disabled. When present, its per-`(kind, field)` `ownedTables(slot)`
   * contributions ride this same durable-marker machinery — boot
   * materializes them under the privileged role, the runtime hot path
   * asserts them with a SELECT (never DDL), exactly like fulltext.
   */
  vectorStrategy: VectorStrategy | undefined;
  /** Run one raw DDL statement (dialect's `execute`/`run` of `sql.raw`). */
  execDdl: (statement: string) => Promise<void>;
  /** Idempotently create the `contribution_materializations` table. */
  ensureMarkerTable: () => Promise<void>;
  /** Read every contribution marker for one graph in a single query. */
  getMarkers: (
    graphId: string,
  ) => Promise<readonly ContributionMaterializationRow[]>;
  recordMarker: (
    params: RecordContributionMaterializationParams,
  ) => Promise<void>;
  /**
   * Delete a marker row by identity. Used when a contribution's physical
   * table is torn down out-of-band (vector-field reclaim) so a later
   * re-provision sees "missing" and re-creates the table rather than
   * trusting an orphaned "initialized" marker.
   */
  deleteMarker: (
    identity: ContributionMaterializationIdentity,
  ) => Promise<void>;
}>;

export type ContributionMaterializer = Readonly<{
  /** Canonical durable-marker writer: every `runtimeEnsure` contribution. */
  ensureRuntimeContributions: (graphId: string) => Promise<void>;
  /**
   * Hot-path / transaction gate: resolve the durable markers once per
   * backend instance (cached) and throw `StoreNotInitializedError` on
   * the first missing/stale/failed contribution. Zero DDL, zero writes.
   */
  assertInitialized: (graphId: string) => Promise<void>;
  /**
   * Privileged materializer for one vector slot's `ownedTables`
   * contribution(s): creates the per-`(kind, field)` table and records
   * its durable marker, idempotently. Pass `{ force: true }` to bypass
   * the drift-guard and overwrite the marker at the current signature —
   * the sanctioned path for `reembedVectorField`'s deliberate
   * dimension change. Pass `{ onDrift: "skip" }` to leave a drifted slot
   * untouched (warn, no marker write, no throw) instead of refusing —
   * the boot/evolve path, where the declared shape may have moved ahead
   * of a `reembedVectorField` the operator has not run yet. No-op when
   * vector support is disabled.
   */
  ensureVectorSlot: (
    slot: VectorSlot,
    options?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
  ) => Promise<void>;
  /** Batch form used by boot to share marker reads across every vector slot. */
  ensureVectorSlots: (
    slots: readonly VectorSlot[],
    options?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
  ) => Promise<void>;
  /**
   * Hot-path gate for one vector slot: SELECT-only marker assert over
   * the slot's `ownedTables` contribution(s), cached per backend
   * instance. Throws `StoreNotInitializedError` when the slot is
   * missing/stale/failed. No-op when vector support is disabled.
   */
  assertVectorSlot: (slot: VectorSlot) => Promise<void>;
  /** Batch form used by verified attach to perform one marker read. */
  assertVectorSlots: (slots: readonly VectorSlot[]) => Promise<void>;
  /**
   * Forget a vector slot: delete its `ownedTables` contribution
   * marker(s) and evict the per-instance cache. Called after the slot's
   * physical table is dropped (vector-field reclaim) so a future
   * `ensureVectorSlot` re-creates the table instead of trusting an
   * orphaned marker. No-op when vector support is disabled.
   */
  dropVectorSlot: (slot: VectorSlot) => Promise<void>;
}>;

// NUL separator for the per-instance contribution cache key: collision-safe
// across arbitrary graph ids / names (a printable delimiter could appear in a
// caller-supplied graph id).
const CONTRIBUTION_KEY_SEPARATOR = String.fromCodePoint(0);

function contributionKey(
  graphId: string,
  contribution: Readonly<{
    owner: string;
    logicalName: string;
    tableName: string;
  }>,
): string {
  return [
    graphId,
    contribution.owner,
    contribution.logicalName,
    contribution.tableName,
  ].join(CONTRIBUTION_KEY_SEPARATOR);
}

export function createContributionMaterializer(
  deps: ContributionMaterializerDeps,
): ContributionMaterializer {
  const { dialect, fulltextStrategy, fulltextTableName } = deps;

  // Positive-only cache keyed per contribution identity
  // (`graphId | owner | logicalName | tableName`), holding the SIGNATURE the
  // marker was last observed materialized at on this connection. A cache hit
  // requires the freshly-computed signature to match the cached one, so a
  // changed shape (dimension, metric, storage DDL) on the same instance
  // misses the cache and falls through to the drift-guard / stale verdict —
  // the warm cache can never bless a contribution whose shape moved.
  // Per-contribution (not per-graph) so each per-`(kind, field)` vector slot
  // caches independently and the hot-path assert stays a small DDL-string
  // comparison plus `Map.get` after the first SELECT. Missing/stale/failed
  // verdicts are never cached, so a concurrent boot that fixes the state is
  // picked up on the next call.
  const initializedSignatures = new Map<string, string>();
  // Computing the durable signature requires WebCrypto. Keep the canonical
  // DDL beside its digest so the hot path only compares the current DDL
  // strings. A same-instance shape change produces a mismatch and therefore
  // a fresh canonical input + digest; unchanged contributions reuse the
  // settled promise without serialization or new crypto work. The cache key
  // already covers every non-DDL signature field (owner/logical/table), while
  // dialect is fixed for the lifetime of this materializer.
  const computedSignatures = new Map<
    string,
    Readonly<{ createDdl: readonly string[]; signature: Promise<string> }>
  >();

  async function resolveContributionSignature(
    key: string,
    contribution: StrategyTableContribution,
  ): Promise<string> {
    const cached = computedSignatures.get(key);
    const cachedCreateDdl = cached?.createDdl;
    const cachedSignature = cached?.signature;
    if (
      cachedCreateDdl?.length === contribution.createDdl.length &&
      cachedSignature !== undefined &&
      contribution.createDdl.every(
        (statement, index) => cachedCreateDdl[index] === statement,
      )
    ) {
      return cachedSignature;
    }

    const input = contributionSignatureInput(
      dialect,
      contribution,
      contribution.createDdl,
    );
    const entry = {
      createDdl: [...contribution.createDdl],
      signature: sha256Hex(input, 16),
    } as const;
    computedSignatures.set(key, entry);
    try {
      return await entry.signature;
    } catch (error) {
      if (computedSignatures.get(key) === entry) {
        computedSignatures.delete(key);
      }
      throw error;
    }
  }

  function runtimeContributions(): readonly StrategyTableContribution[] {
    return runtimeStrategyContributions(fulltextStrategy, fulltextTableName);
  }

  async function materializeOne(
    graphId: string,
    contribution: StrategyTableContribution,
    signature: string,
    existing: ContributionMaterializationRow | undefined,
    options?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
  ): Promise<"materialized" | "drift-skipped"> {
    const force = options?.force === true;
    const identity = identityOf(graphId, contribution);

    // Already materialized at this exact shape — nothing to do. `force`
    // re-runs the DDL and re-stamps the marker even on a match: the path
    // `reembedVectorField` relies on after it has recreated the table.
    if (
      !force &&
      evaluateContributionState(existing, signature) === "initialized"
    ) {
      return "materialized";
    }
    const priorSuccess = existing?.materializedAt !== undefined;

    // Drift after a *recorded success*: the table physically exists with
    // the OLD shape, so the idempotent `CREATE ... IF NOT EXISTS` would
    // no-op and we'd silently bless the new signature against a stale
    // table. Refuse loudly instead — mirrors the index materializer's
    // signature-drift handling. (A row with no prior success, or one
    // whose last attempt errored, falls through and re-runs the DDL.)
    // `force` deliberately bypasses this — the caller has already dropped
    // and recreated the table at the new shape (`reembedVectorField`).
    if (!force && priorSuccess && existing.signature !== signature) {
      // `onDrift: "skip"` (boot/evolve): leave the slot exactly as it is —
      // marker untouched (so old-shape reads keep their verdict), nothing
      // cached, no throw. Writes to the new shape fail as `stale` until
      // `store.reembedVectorField` recreates storage and force-restamps.
      if (options?.onDrift === "skip") {
        console.warn(
          `[typegraph] contribution "${contribution.logicalName}" (table ` +
            `"${contribution.tableName}") is provisioned at a different ` +
            `shape than the current declaration — left untouched. Writes ` +
            `to it will fail until store.reembedVectorField(kind, ` +
            `fieldPath) recreates the storage at the new shape.`,
        );
        return "drift-skipped";
      }
      const error = new Error(
        `Contribution "${contribution.logicalName}" (owner ` +
          `"${contribution.owner}", table "${contribution.tableName}") was ` +
          `already materialized with a different signature. The recorded ` +
          `physical shape is stale relative to the current strategy/DDL — ` +
          `migrate or drop the table and retry, or restore the original ` +
          `strategy.`,
      );
      await deps.recordMarker({
        ...identity,
        signature,
        attemptedAt: nowIso(),
        materializedAt: undefined,
        error: error.message,
      });
      throw error;
    }

    const attemptedAt = nowIso();
    try {
      for (const statement of contribution.createDdl) {
        await deps.execDdl(statement);
      }
    } catch (error) {
      await deps.recordMarker({
        ...identity,
        signature,
        attemptedAt,
        materializedAt: undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    await deps.recordMarker({
      ...identity,
      signature,
      attemptedAt,
      materializedAt: attemptedAt,
      error: undefined,
    });
    return "materialized";
  }

  function indexMarkerRows(
    graphId: string,
    rows: readonly ContributionMaterializationRow[],
  ): ReadonlyMap<string, ContributionMaterializationRow> {
    return new Map(
      rows.map((row) => [contributionKey(graphId, row), row] as const),
    );
  }

  /**
   * Read every marker for a graph in one round trip. A missing marker table
   * is its own verdict so boot can create it while hot-path asserts translate
   * it to `StoreNotInitializedError`. All other database faults propagate.
   */
  async function readMarkerRows(graphId: string): Promise<
    | Readonly<{
        kind: "rows";
        rows: ReadonlyMap<string, ContributionMaterializationRow>;
      }>
    | Readonly<{ kind: "missing-table"; error: unknown }>
  > {
    try {
      return {
        kind: "rows",
        rows: indexMarkerRows(graphId, await deps.getMarkers(graphId)),
      };
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      return { kind: "missing-table", error };
    }
  }

  /**
   * Privileged materialize over an arbitrary contribution set. Per
   * contribution: skip if cached at the current signature; else (unless
   * `force`) a read-only
   * pre-check short-circuits the whole pending set when every marker is
   * already initialized at its current signature, so a warm graph stays
   * DDL-free — the marker `CREATE TABLE IF NOT EXISTS` itself would fail
   * on a connection that can't run DDL (#149). Otherwise ensure the
   * marker table and `materializeOne` each pending contribution. `force`
   * re-runs the DDL and re-stamps the marker unconditionally (drift-guard
   * bypassed) — the `reembedVectorField` recreate path.
   */
  async function ensureContributions(
    graphId: string,
    contributions: readonly StrategyTableContribution[],
    options?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
  ): Promise<void> {
    const force = options?.force === true;
    const entries = await Promise.all(
      contributions.map(async (contribution) => {
        const key = contributionKey(graphId, contribution);
        return {
          contribution,
          key,
          signature: await resolveContributionSignature(key, contribution),
        };
      }),
    );
    // A cache hit requires the signature to match — a contribution whose
    // shape changed on this instance falls through to the drift-guard.
    const pending =
      force ? entries : (
        entries.filter(
          (entry) => initializedSignatures.get(entry.key) !== entry.signature,
        )
      );
    if (pending.length === 0) return;

    const initialRead = force ? undefined : await readMarkerRows(graphId);
    if (
      !force &&
      initialRead?.kind === "rows" &&
      pending.every(
        (entry) =>
          evaluateContributionState(
            initialRead.rows.get(entry.key),
            entry.signature,
          ) === "initialized",
      )
    ) {
      for (const entry of pending) {
        initializedSignatures.set(entry.key, entry.signature);
      }
      return;
    }

    await deps.ensureMarkerTable();
    // Preserve the original race check after marker-table bootstrap, but
    // refresh every pending contribution in one query rather than one query
    // per slot.
    const existingRows = indexMarkerRows(
      graphId,
      await deps.getMarkers(graphId),
    );
    for (const entry of pending) {
      const outcome = await materializeOne(
        graphId,
        entry.contribution,
        entry.signature,
        existingRows.get(entry.key),
        {
          force,
          ...(options?.onDrift === undefined ?
            {}
          : { onDrift: options.onDrift }),
        },
      );
      // A drift-skipped contribution is deliberately NOT cached: nothing
      // was materialized at this signature, and asserts must keep reading
      // it as stale until reembedVectorField restamps it.
      if (outcome === "materialized") {
        initializedSignatures.set(entry.key, entry.signature);
      }
    }
  }

  /**
   * SELECT-only gate over an arbitrary contribution set: throws
   * `StoreNotInitializedError` on the first missing/stale/failed
   * contribution (or a never-bootstrapped marker table). Caches each
   * confirmed-initialized contribution BY SIGNATURE so the steady state is a
   * crypto-free DDL-string comparison + `Map.get`. A shape change on the same
   * instance computes a fresh signature, misses the initialized cache, and
   * surfaces as `stale`. Never runs DDL or writes.
   */
  async function assertContributions(
    graphId: string,
    contributions: readonly StrategyTableContribution[],
  ): Promise<void> {
    const entries = await Promise.all(
      contributions.map(async (contribution) => {
        const key = contributionKey(graphId, contribution);
        return {
          contribution,
          key,
          signature: await resolveContributionSignature(key, contribution),
        };
      }),
    );
    const pending = entries.filter(
      (entry) => initializedSignatures.get(entry.key) !== entry.signature,
    );
    if (pending.length === 0) return;

    const read = await readMarkerRows(graphId);
    if (read.kind === "missing-table") {
      const first = pending[0];
      if (first === undefined) return;
      throw new StoreNotInitializedError(graphId, "missing", {
        cause: read.error,
        details: { logicalName: first.contribution.logicalName },
      });
    }

    for (const entry of pending) {
      const { contribution, key, signature } = entry;
      const state = evaluateContributionState(read.rows.get(key), signature);
      if (state !== "initialized") {
        throw new StoreNotInitializedError(graphId, state, {
          details: { logicalName: contribution.logicalName },
        });
      }
      initializedSignatures.set(key, signature);
    }
  }

  async function ensureRuntimeContributions(graphId: string): Promise<void> {
    await ensureContributions(graphId, runtimeContributions());
  }

  async function assertInitialized(graphId: string): Promise<void> {
    await assertContributions(graphId, runtimeContributions());
  }

  async function ensureVectorSlot(
    slot: VectorSlot,
    options?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
  ): Promise<void> {
    await ensureVectorSlots([slot], options);
  }

  async function assertVectorSlot(slot: VectorSlot): Promise<void> {
    await assertVectorSlots([slot]);
  }

  function groupVectorContributions(
    slots: readonly VectorSlot[],
  ): ReadonlyMap<string, readonly StrategyTableContribution[]> {
    const grouped = new Map<string, readonly StrategyTableContribution[]>();
    if (deps.vectorStrategy === undefined) return grouped;
    for (const slot of slots) {
      grouped.set(slot.graphId, [
        ...(grouped.get(slot.graphId) ?? []),
        ...deps.vectorStrategy.ownedTables(slot),
      ]);
    }
    return grouped;
  }

  async function ensureVectorSlots(
    slots: readonly VectorSlot[],
    options?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
  ): Promise<void> {
    for (const [graphId, contributions] of groupVectorContributions(slots)) {
      await ensureContributions(graphId, contributions, options);
    }
  }

  async function assertVectorSlots(
    slots: readonly VectorSlot[],
  ): Promise<void> {
    for (const [graphId, contributions] of groupVectorContributions(slots)) {
      await assertContributions(graphId, contributions);
    }
  }

  async function dropVectorSlot(slot: VectorSlot): Promise<void> {
    if (deps.vectorStrategy === undefined) return;
    for (const contribution of deps.vectorStrategy.ownedTables(slot)) {
      await deps.deleteMarker(identityOf(slot.graphId, contribution));
      const key = contributionKey(slot.graphId, contribution);
      initializedSignatures.delete(key);
      computedSignatures.delete(key);
    }
  }

  return {
    ensureRuntimeContributions,
    assertInitialized,
    ensureVectorSlot,
    ensureVectorSlots,
    assertVectorSlot,
    assertVectorSlots,
    dropVectorSlot,
  };
}
