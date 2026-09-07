/**
 * Pluggable working-copy strategy: how `branch()` produces an isolated,
 * independently-mutable copy of a base store.
 *
 * The P0 default is a faithful CLONE via streamed public interchange
 * ({@link cloneWorkingCopyStrategy}): `exportGraphStream` the base, then
 * `importGraphStream` into a fresh store on a caller-provided backend. IDs are
 * preserved by interchange, so the diff engine (T3) can key on stable ids across
 * base and fork. This leverages public entrypoints only, needs zero schema
 * changes, and behaves identically across SQLite and Postgres.
 *
 * INTERCHANGE FIDELITY LIMITATION (verified, design §13.x): the interchange
 * `meta` schema has no `deletedAt` field, so a base row that is already
 * soft-deleted would round-trip into the clone as LIVE (its tombstone lost). A
 * resurrected row would then read as a spurious `new` node in the fork's diff —
 * the base row is non-live, so `diffNodeKind` takes its `!isLive(base)` branch and
 * reports the (live, clone-resurrected) row as an addition — silently re-creating a
 * deleted node on commit. We therefore export with `includeDeleted: false`: the
 * clone carries only the base's LIVE state, exactly what `branch()` needs. The
 * merge state-diff is still computed against the ORIGINAL base store (live rows
 * only) as the immutable reference, never against the clone (clones regenerate
 * `created_at`/`updated_at`, which would otherwise destabilize `base@V`).
 *
 * `includeTemporal: true` carries `validFrom`/`validTo` through unchanged,
 * preserving the base's exact valid-time window on the clone: create-time
 * paths default an omitted `validFrom` to the row's own creation instant
 * (see #240) — except for a BORN-ENDED row, whose stated `validTo` at or before
 * the write instant leaves it with no lower bound at all (see #407) — and
 * export/import round-trip a still-open-left `valid_from` (a born-ended row, or
 * one that predates the #240 fix) as an explicit `null` rather than silently
 * dropping it — see `InterchangeNodeSchema.validFrom`'s doc.
 * Without either half of this, the clone's re-import would re-stamp the
 * affected base rows to the CLONE's creation instant instead — narrowing
 * their validity window and making `asOf` reads on the fork diverge from
 * identical reads on the base for any instant between the row's real
 * creation and the clone.
 *
 * Logical-namespace (copy-on-write within one backend, no full data copy) is a
 * future strategy slot — see the `WorkingCopyStrategy` interface — deferred past
 * P0.
 *
 * A second bundled strategy, {@link forkedWorkingCopyStrategy}, targets a
 * fork-capable host instead: the working copy is a database-level fork (a file
 * copy, a `CREATE DATABASE ... TEMPLATE`, a hosting product's branch call)
 * rather than a streamed-interchange replay, so none of the fidelity
 * limitations above apply to it — see its own doc comment.
 */

import { computeBaseVersion } from "./base-version";
import { BranchError } from "./errors";
import type {
  GraphBackend,
  GraphDef,
  Store,
  StoreOptions,
} from "./typegraph-internal";
import {
  createStore,
  createStoreWithSchema,
  exportGraph,
  exportGraphStream,
  importGraph,
  importGraphStream,
  snapshotExportContention,
  storeBackend,
  wrapWithManagedClose,
} from "./typegraph-internal";

/**
 * Batch size for the clone's `importGraphStream` pass. Large enough to keep
 * round-trips low on demo-scale graphs; correctness is independent of the value.
 */
const CLONE_IMPORT_BATCH_SIZE = 1000;

/**
 * How `branch()` materializes a working copy of a base store.
 *
 * `create` receives the live base store and returns a fresh, independently
 * mutable {@link Store} over the SAME graph definition, seeded with the base's
 * current state. Mutating the returned store MUST NOT affect the base.
 *
 * The single method is the only extension point: alternative strategies
 * (e.g. a future logical-namespace copy-on-write within one backend) implement
 * the same contract.
 */
export type WorkingCopyStrategy<G extends GraphDef> = Readonly<{
  create: (baseStore: Store<G>) => Promise<Store<G>>;
}>;

/**
 * Factory for a caller-provided backend. `branch()` stays backend-agnostic by
 * delegating backend construction to the caller: the clone strategy calls this
 * once per `create()` to obtain the fresh backend that backs the working copy.
 *
 * Returning a promise lets async backends (e.g. PGlite, which boots an
 * in-process Postgres engine) be constructed lazily at branch time.
 *
 * The returned backend MUST be EMPTY (no rows for the base graph): the clone
 * seeds it from the base via `importGraphStream` with `onConflict: "error"`, so a
 * pre-existing row is surfaced as a {@link BranchError} rather than silently
 * skipped (which would leave the working copy diverging from the base).
 * When the source store uses `revisionTracking`, the backend must also satisfy
 * that option's transactional revision-clock requirements because the clone
 * preserves the source's branchability contract.
 */
export type MakeBackend = () => Promise<GraphBackend>;

/**
 * The P0 default working-copy strategy: faithful clone via streamed interchange.
 *
 * On each `create(baseStore)`:
 *   1. `exportGraphStream(baseStore, { includeMeta: true, includeTemporal: true,
 *      includeDeleted: false })` — `includeMeta: true` carries
 *      `created_at`/`updated_at`; `includeTemporal: true` carries
 *      `validFrom`/`validTo` so the clone's valid-time window matches the base's
 *      exactly (see the fidelity note above); `includeDeleted: false` keeps the
 *      clone to LIVE rows only. Shipping soft-deleted rows is unsafe: the meta
 *      schema has no `deletedAt`, so they would import as live and resurrect on
 *      the fork's diff (see the fidelity note above). `branch()` only needs the
 *      base's live state.
 *   2. Create a fresh store over the caller-provided backend with the SAME graph
 *      definition via `createStoreWithSchema`.
 *   3. `importGraphStream(freshStore, data, { onConflict: "error", ... })` — ids are
 *      preserved so the diff engine can key on them. `onConflict: "error"`
 *      requires the backend to be EMPTY: a pre-existing row is a contract
 *      violation that must surface loudly, never be silently skipped (a skipped
 *      row would leave the clone diverging from the base, so the fork's diff would
 *      report phantom modifications/deletions). `importGraphStream` RETURNS
 *      `{ success, errors }` rather than throwing on a per-row rejection, so its
 *      result is checked and any failure fails the branch.
 *
 * The backend `makeBackend()` returns is opened here, so any failure AFTER it is
 * created closes it before rethrowing — only the success path hands the backend
 * (via the returned store) to the caller, who then owns its lifecycle.
 *
 * @param makeBackend - Constructs the fresh, EMPTY backend the working copy is
 *   built on.
 */
export function cloneWorkingCopyStrategy<G extends GraphDef>(
  makeBackend: MakeBackend,
): WorkingCopyStrategy<G> {
  return cloneWorkingCopyWithGraphStrategy(
    makeBackend,
    (baseStore) => baseStore.graph,
  );
}

/**
 * Working-copy strategy used by {@link ingestionBranch}. The clone is backed by
 * a mechanically-derived graph that omits node uniqueness declarations while
 * preserving every other graph contract, including lookup indexes.
 *
 * This strategy is deliberately not part of the public barrel. The opaque
 * ingestion handle is the only supported owner of a relaxed working copy.
 */
export function cloneIngestionWorkingCopyStrategy<G extends GraphDef>(
  makeBackend: MakeBackend,
): WorkingCopyStrategy<G> {
  return cloneWorkingCopyWithGraphStrategy(makeBackend, (baseStore) =>
    graphWithoutNodeUniqueness(baseStore.graph),
  );
}

function cloneWorkingCopyWithGraphStrategy<G extends GraphDef>(
  makeBackend: MakeBackend,
  graphForClone: (baseStore: Store<G>) => G,
): WorkingCopyStrategy<G> {
  return {
    create: async (baseStore: Store<G>): Promise<Store<G>> => {
      const backend = await makeBackend();
      try {
        const [freshStore] = await createStoreWithSchema(
          graphForClone(baseStore),
          backend,
          {
            // Keep descendants branchable with the same O(1) anchor contract,
            // but do not copy recorded-time history into the disposable fork.
            revisionTracking: baseStore.revisionTrackingEnabled,
          },
        );
        const exportOptions = {
          includeMeta: true,
          includeTemporal: true,
          includeDeleted: false,
          batchSize: CLONE_IMPORT_BATCH_SIZE,
        } as const;
        const importOptions = {
          onConflict: "error",
          onUnknownProperty: "error",
          validateReferences: true,
          batchSize: CLONE_IMPORT_BATCH_SIZE,
        } as const;
        // When the fresh backend writes through the connection the base's
        // snapshot export would hold, streaming is exactly what the import
        // guard refuses — so ask that guard's own predicate, and materialize
        // the export instead of streaming it when it says so.
        const result =
          (
            snapshotExportContention(
              storeBackend(baseStore),
              storeBackend(freshStore),
            ) === undefined
          ) ?
            await importGraphStream(
              freshStore,
              exportGraphStream(baseStore, exportOptions),
              importOptions,
            )
          : await importGraph(
              freshStore,
              await exportGraph(baseStore, exportOptions),
              importOptions,
            );
        if (!result.success) {
          throw new BranchError(
            "Clone import failed: the working copy could not be seeded from the base store. The backend returned by makeBackend() must be empty.",
            { details: { errors: result.errors } },
          );
        }
        return freshStore;
      } catch (error) {
        // The backend was opened above; close it on any failure so its
        // connection / file handle / in-process engine cannot leak. A close
        // failure must not mask the original error.
        try {
          await backend.close();
        } catch {
          // Intentionally ignored — surface the original branch failure.
        }
        throw error;
      }
    },
  };
}

/**
 * A host-level handle to a forked database, produced by
 * {@link ForkedWorkingCopyOptions.fork} and released by its own `dispose`.
 *
 * `dispose` is OPTIONAL: some hosts have nothing left to release beyond the
 * connection `connect` opens on the fork (already composed into the returned
 * working copy's backend — see {@link forkedWorkingCopyStrategy}), while others
 * (a temporary file, a database created for this fork alone) need an explicit
 * teardown.
 */
export type ForkHandle = Readonly<{
  dispose?: () => Promise<void>;
}>;

/**
 * Configuration for {@link forkedWorkingCopyStrategy}.
 */
export type ForkedWorkingCopyOptions<
  G extends GraphDef,
  TFork extends ForkHandle,
> = Readonly<{
  /**
   * Produces a host-level fork of the database `baseStore` is on — the
   * caller's own fork API call (a file copy, a `CREATE DATABASE ... TEMPLATE`,
   * a hosting product's branch-database call). The fork MUST be byte-for-byte
   * identical to the base at the instant it is taken: `create()` asserts this
   * with `computeBaseVersion` and refuses otherwise (see
   * {@link forkedWorkingCopyStrategy}).
   */
  fork: (baseStore: Store<G>) => Promise<TFork>;
  /** Opens a backend on the fork `fork` produced. */
  connect: (fork: TFork) => Promise<GraphBackend>;
}>;

/**
 * Store options for a forked working copy: the SAME `history` /
 * `revisionTracking` configuration `baseStore` itself reports, read off its
 * own public getters — the same technique {@link cloneWorkingCopyStrategy}
 * uses to obtain `revisionTracking` for its own fresh store. A fork's
 * recorded-time relations are already physically present on the copied
 * database (unlike a clone's, which streamed interchange cannot carry), so
 * `history: true` is threaded through here where the clone strategy
 * deliberately withholds it (see its own fidelity note).
 */
function forkStoreOptions<G extends GraphDef>(
  baseStore: Store<G>,
): StoreOptions {
  return baseStore.historyEnabled ?
      { history: true }
    : { revisionTracking: baseStore.revisionTrackingEnabled };
}

/**
 * Working-copy strategy for a fork-capable host: `fork(baseStore)` asks the
 * host to produce a complete, independent copy of the underlying database —
 * not a public-interchange replay — and `connect(fork)` opens a backend on
 * that copy.
 *
 * Unlike {@link cloneWorkingCopyStrategy}, the working copy is never built
 * through `exportGraphStream`/`importGraphStream`, so none of that strategy's
 * interchange-fidelity limitations apply here: soft-deleted rows keep their
 * tombstones, `created_at`/`updated_at` and the `version` column carry over
 * unchanged, and — when the base has `history` enabled — the recorded
 * relations the fork physically carries answer `asOfRecorded` for instants
 * before the fork, which a clone cannot (streamed interchange never carries
 * recorded history).
 *
 * `create(baseStore)`:
 *   1. `fork(baseStore)` — the host-level fork call.
 *   2. `connect(fork)` — opens a backend on the fork. A failure here disposes
 *      the fork before rethrowing (mirroring the clone strategy's
 *      own-failure cleanup); a dispose failure never masks the original
 *      error.
 *   3. The connected backend's `close` is composed with the fork's `dispose`
 *      through `wrapWithManagedClose` (a `deriveBackend` overlay, never a
 *      spread), so the caller's single `close()` on the resulting store's
 *      backend releases both the connection and the fork.
 *   4. A fresh `Store` is attached with `createStore` — a zero-DDL attach,
 *      since the fork already carries the base's schema and rows — using
 *      {@link forkStoreOptions}.
 *   5. `computeBaseVersion` is compared between the fork's store and the base
 *      store: a fork must be the base, byte for byte, or it is not a fork.
 *      A mismatch closes the backend (releasing both the connection and the
 *      fork, mirroring step 3's composition) before refusing with a
 *      {@link BranchError}.
 *
 * @param options - `{ fork, connect }` — see {@link ForkedWorkingCopyOptions}.
 */
export function forkedWorkingCopyStrategy<
  G extends GraphDef,
  TFork extends ForkHandle,
>(options: ForkedWorkingCopyOptions<G, TFork>): WorkingCopyStrategy<G> {
  return {
    create: async (baseStore: Store<G>): Promise<Store<G>> => {
      const fork = await options.fork(baseStore);
      let connectedBackend: GraphBackend;
      try {
        connectedBackend = await options.connect(fork);
      } catch (error) {
        try {
          await fork.dispose?.();
        } catch {
          // Intentionally ignored — surface the original connect failure.
        }
        throw error;
      }
      const backend = wrapWithManagedClose(connectedBackend, async () => {
        await fork.dispose?.();
      });
      try {
        const forkStore = createStore(
          baseStore.graph,
          backend,
          forkStoreOptions(baseStore),
        );
        const [forkVersion, baseVersion] = await Promise.all([
          computeBaseVersion(forkStore),
          computeBaseVersion(baseStore),
        ]);
        if (forkVersion !== baseVersion) {
          throw new BranchError(
            "Fork does not match its base: computeBaseVersion disagrees " +
              "between the forked store and the base store it was forked " +
              "from. A working-copy fork must be byte-for-byte identical to " +
              "its base at the instant it is taken.",
            { details: { forkVersion, baseVersion } },
          );
        }
        return forkStore;
      } catch (error) {
        try {
          await backend.close();
        } catch {
          // Intentionally ignored — surface the original branch failure.
        }
        throw error;
      }
    },
  };
}

/**
 * Derives the honest persisted schema for an ingestion working copy.
 *
 * The graph's node and edge types are unchanged, so retaining `G` is sound for
 * collection inputs and outputs. Only the registrations' node uniqueness slice
 * is removed. Extension documents are rewritten too: they are the durable
 * source used to reconstruct extension kinds on reload, so leaving their
 * declarations intact would silently restore uniqueness after a restart.
 *
 * What "node uniqueness is deferred" means at the level the store enforces it:
 * a row's reservations are whatever
 * {@link file://../store/claims/node-claims.ts nodeClaimEntries} says its kind
 * owes, and `unique` is the ONLY input to that list's uniqueness family. So
 * removing it removes exactly the uniqueness claim entries and nothing else —
 * the disjointness entries the same list carries come from the registry's
 * declared pairs, which this derivation does not touch, and they stay enforced
 * on the clone during staging. `tests/graph-merge/ingestion-branch.test.ts`
 * asserts that split through `nodeClaimEntries` itself rather than restating it.
 */
function graphWithoutNodeUniqueness<G extends GraphDef>(graph: G): G {
  const nodes = Object.fromEntries(
    Object.entries(graph.nodes).map(([name, registration]) => {
      const { unique: _omitted, ...withoutUnique } = registration;
      return [name, Object.freeze(withoutUnique)] as const;
    }),
  );
  const extension =
    graph.extension?.nodes === undefined ?
      graph.extension
    : Object.freeze({
        ...graph.extension,
        nodes: Object.freeze(
          Object.fromEntries(
            Object.entries(graph.extension.nodes).map(([name, node]) => {
              const { unique: _omitted, ...withoutUnique } = node;
              return [name, Object.freeze(withoutUnique)] as const;
            }),
          ),
        ),
      });

  // `G`'s data types are unchanged. Its registration-level constraint-name
  // phantom is intentionally retained so branch nodes remain assignable to the
  // canonical graph's merge types; the ingestion handle omits constraint lookup
  // methods whose declarations no longer exist physically.
  return Object.freeze({
    ...graph,
    nodes: Object.freeze(nodes),
    extension,
  });
}
