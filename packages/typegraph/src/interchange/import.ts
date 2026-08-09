/**
 * Graph data import functionality.
 *
 * Imports nodes and edges from the interchange format into a store,
 * with configurable conflict resolution and validation.
 *
 * ## A write asserts EVERY component its verdict read
 *
 * `onConflict: "update"` is a read-then-write pair: this module PROBES the
 * stored row, decides from what it finds, and then writes. Under PostgreSQL
 * READ COMMITTED a concurrent `hardDelete` + recreate re-resolves the probed key
 * between those two statements, so any part of the verdict that is not restated
 * in the UPDATE's own `WHERE` is a decision that can land on a row it was never
 * computed for — and the import reports success, because the write did affect a
 * row. The failure is invisible and only appears under a race, which is why it
 * has taken three rounds to enumerate:
 *
 *  - the edge's KIND — the probe is keyed on `(graph_id, id)` alone, so the row
 *    under an id may be a different edge entirely;
 *  - the edge's ENDPOINTS — kind is not an identity, and an upsert that resolved
 *    an edge BY its endpoints must say so;
 *  - the effective `valid_from` of BOTH entities — {@link
 *    validateUpdateValidityWindow} decides from the stored lower bound, so a
 *    recreate carrying a different one turns that verdict into a write that
 *    ignores the document's `validFrom` or persists `valid_to < valid_from`.
 *
 * The rest of what these legs read, and where each is asserted:
 *
 *  - the row EXISTS (the `getNode` / `getEdge` probe): restated as the
 *    `(graph_id, kind, id)` / `(graph_id, id)` predicate every UPDATE carries.
 *  - the row is LIVE (`isLiveNodeRow` / `deleted_at === undefined`, which is what
 *    routes a tombstone to `skipped` instead of to the update): restated as the
 *    `deleted_at IS NULL` conjunction on the non-resurrecting UPDATE leg. Import
 *    never resurrects, so it never builds the `IS NOT NULL` leg.
 *  - `onConflict: "skip"` / `"error"`: verdict-independent by construction —
 *    they write nothing.
 *  - the row's PROPS, read as the `oldProps` side of the uniqueness diff: the
 *    ONE input with no portable SQL predicate behind it (a props blob is TEXT on
 *    SQLite and `jsonb` on PostgreSQL, and neither comparison is stable under
 *    key reordering). It is bounded rather than asserted: the sidecar writes now
 *    run AFTER the primary update returns a row (see `applyNodeUpdate`), so a
 *    verdict-invalidating recreate that changes the lower bound takes the
 *    sidecars with it. The residual window is a recreate that reproduces the
 *    probed `valid_from` exactly while changing props — noted here so the next
 *    round starts from the list rather than from the symptom.
 */
import type { z } from "zod";

import {
  acquireSerializedStreamLease,
  type SerializedStreamKind,
  type SnapshotExportContention,
  snapshotExportContention,
} from "../backend/transaction-resource";
import {
  type GraphBackend,
  isLiveNodeRow,
  type LiveNodeRow,
  rowPropsToObject,
  type TransactionBackend,
} from "../backend/types";
import { validateEdgeEndpoints } from "../constraints";
import {
  getEdgeKinds,
  getNodeKinds,
  type GraphDef,
} from "../core/define-graph";
import {
  type EdgeRegistration,
  type NodeRegistration,
  type UniqueConstraint,
} from "../core/types";
import {
  ConfigurationError,
  DatabaseOperationError,
  IdentityContradictionError,
  IMMUTABLE_VALIDITY_LOWER_BOUND_CODE,
  INVERTED_VALIDITY_WINDOW_CODE,
  NodeNotFoundError,
  UniquenessError,
  ValidationError,
} from "../errors";
import {
  IDENTITY_IMPORT_FAILED_ASSERTION,
  IDENTITY_IMPORT_PROGRESS,
} from "../identity/service";
import { type KindRegistry } from "../registry/kind-registry";
import { checkUniquenessConstraints } from "../store/claims/node-claims";
import {
  createNodeBatchValidationBackend,
  type NodeCreateDraft,
  primeBatchValidationCaches,
} from "../store/operations/node-operations";
import {
  applyNodeInsertSideEffects,
  applyNodeInsertSideEffectsBatch,
  applyNodeUpdate,
  type NodeWriteContext,
} from "../store/operations/node-write-pipeline";
import { runInWriteTransaction } from "../store/operations/write-transaction";
import { type GraphWriteLock } from "../store/recorded-capture/clock";
import { storeBackend, storeRuntime } from "../store/runtime-port";
import { type Store } from "../store/store";
import {
  assertOrderedValidityWindow,
  assertWritableValidityWindow,
  validateOptionalCanonicalIsoDate,
  type ValidityLowerBoundFence,
} from "../utils/date";
import { createDataKeyedBag, hasOwnKey } from "../utils/object";
import { encodeTupleKey } from "../utils/tuple-key";
import { exportStreamBackend } from "./stream-source";
import {
  type GraphData,
  type GraphDataHeader,
  GraphDataHeaderSchema,
  type GraphInterchangeChunk,
  type ImportError,
  type ImportOptions,
  ImportOptionsSchema,
  type ImportResult,
  type InterchangeEdge,
  type InterchangeIdentityAssertion,
  InterchangeIdentitySchema,
  type InterchangeNode,
  type ResolvedImportOptions,
  type UnknownPropertyStrategy,
} from "./types";

// ============================================================
// Import Function
// ============================================================

/**
 * Import graph data into a store.
 *
 * Nodes are imported first to satisfy edge reference validation.
 * The import runs within a transaction for atomicity when supported.
 *
 * Refused with a typed {@link ConfigurationError} when the target writes through
 * a serialized database connection another long-lived interchange operation
 * holds — the same refusal, codes and `details.heldBy` / `details.requested` as
 * {@link importGraphStream}. Hand-rolling a stream as `for await (const chunk of
 * exportGraphStream(source)) await importGraph(target, ...)` on one such
 * connection is therefore refused on the first chunk instead of nesting a write
 * transaction inside the export's open snapshot.
 *
 * @param store - The graph store to import into
 * @param data - Graph data in interchange format
 * @param options - Import configuration
 * @returns Import statistics and any errors
 *
 * @example
 * ```typescript
 * const result = await importGraph(store, data, {
 *   onConflict: "update",
 *   onUnknownProperty: "strip",
 * });
 *
 * console.log(`Created ${result.nodes.created} nodes`);
 * ```
 */
export async function importGraph<G extends GraphDef>(
  store: Store<G>,
  data: GraphData,
  rawOptions: ImportOptions,
): Promise<ImportResult> {
  // Parse ONCE at the public boundary: schema defaults (batchSize, ...)
  // only exist after parsing, and every internal stage reads them
  // directly.
  const options = ImportOptionsSchema.parse(rawOptions);
  return withImportStreamLease(store, () =>
    importGraphData(store, data, options),
  );
}

/**
 * Claims the target connection's exclusive stream lease for the whole of `run`,
 * or refuses with the holder named.
 *
 * GRANULARITY: an in-memory import is not one long-lived transaction — it is a
 * write transaction followed by a best-effort statistics refresh — but it IS one
 * long-lived operation on the connection, and it faces exactly the hazard the
 * streaming guard exists for: an export snapshot holding the single connection
 * this import must write on, or opening midway through it. A lease for the whole
 * call is the simplest claim that covers every write the call makes, so that is
 * what it takes.
 *
 * Claimed at each PUBLIC boundary that writes a whole import — this function's
 * own {@link importGraph} and `trustedImportGraphStream` — and nowhere else.
 * {@link importGraphStream} already holds the lease for its chunk loop and calls
 * {@link importGraphData} directly, so a per-chunk import is never refused by
 * the stream that issued it.
 */
export async function withImportStreamLease<G extends GraphDef, T>(
  store: Store<G>,
  run: () => Promise<T>,
): Promise<T> {
  const lease = acquireSerializedStreamLease(
    storeBackend(store),
    "import-stream",
  );
  if (!lease.acquired) {
    throw serializedStreamRefusal({
      graphId: store.graphId,
      requested: "import-stream",
      heldBy: lease.heldBy,
    });
  }
  try {
    return await run();
  } finally {
    lease.release();
  }
}

async function importGraphData<G extends GraphDef>(
  store: Store<G>,
  data: GraphData,
  options: ResolvedImportOptions,
): Promise<ImportResult> {
  // Reject an identity payload aimed at an identity-disabled graph, and
  // runtime-validate the (bounded) identity section, BEFORE any entity write —
  // see assertIdentityImportSupported / validateIdentitySection.
  assertIdentityImportSupported(store, data.identity !== undefined);
  validateIdentitySection(data.identity);

  const result = emptyImportResult();

  const errors: ImportError[] = [];
  const graph = store.graph;
  const graphId = store.graphId;
  const backend = storeBackend(store);
  const runtime = storeRuntime(store);
  const registry = store.registry;

  // Build lookup maps for schema validation
  const nodeSchemas = buildNodeSchemaMap(graph);
  const edgeSchemas = buildEdgeSchemaMap(graph);

  // Track imported node IDs for reference validation
  const importedNodeIds = new Set<string>();

  // One transaction on a transactional backend; runs directly otherwise, with
  // the per-graph write lock taken before any row work — see
  // runInWriteTransaction for the shared lock-before-rows contract every
  // writer follows.
  await runInWriteTransaction(
    {
      graphId,
      schemaVersion: store.introspect().schemaVersion,
      historyEnabled: store.historyEnabled,
      revisionTrackingEnabled: store.revisionTrackingEnabled,
      revisionSchema: store.revisionSchema,
    },
    backend,
    async (target, lock) => {
      await runtime.lockIdentityImportTarget(target);
      await processNodes(
        target,
        graphId,
        registry,
        data.nodes,
        nodeSchemas,
        options,
        result,
        errors,
        importedNodeIds,
        lock,
      );
      await runtime.foldImportedIdentityNodes(
        target,
        data.nodes
          .filter((node) =>
            importedNodeIds.has(makeNodeKey(node.kind, node.id)),
          )
          .map((node) => ({ kind: node.kind, id: node.id })),
      );
      await processEdges(
        target,
        graphId,
        registry,
        data.edges,
        edgeSchemas,
        nodeSchemas,
        options,
        result,
        errors,
        importedNodeIds,
      );
      if (data.identity !== undefined) {
        await importIdentitySection(
          runtime,
          target,
          graphId,
          data.identity,
          result,
          errors,
        );
      }
    },
  );

  // A bulk load runs against stale planner statistics until ANALYZE runs
  // (documented regressions: 0.5ms → 5ms traversals on Postgres, 0.9ms →
  // 23ms fulltext on SQLite), so a mutating import refreshes them once,
  // after the transaction commits.
  //
  // Best-effort: by this point the import is committed, so a failed
  // statistics refresh must not convert the completed (non-atomic on some
  // backends, non-retryable) import into a thrown failure — it degrades to
  // a warning, and the caller can run `store.refreshStatistics()`.
  await refreshStatisticsAfterImport(store, options, result, "importGraph");

  return {
    ...result,
    success: errors.length === 0,
    errors,
  };
}

/**
 * Imports a header-first stream of bounded interchange chunks.
 *
 * Each chunk is committed through the same implementation as an in-memory
 * {@link importGraph}, so validation and conflict semantics stay identical; the
 * chunk calls skip only that function's own lease claim, which this loop already
 * holds on their behalf.
 * Chunks are individually atomic on transactional backends; a consumer needing
 * all-or-nothing behavior can import into a disposable working-copy backend and
 * publish it only after this function succeeds.
 *
 * Nodes must precede edges. Once a node chunk commits, edge validation reads the
 * target store rather than retaining every imported node id in memory.
 *
 * Refused with a typed {@link ConfigurationError} when the target writes through
 * a serialized database connection that another long-lived interchange stream
 * already holds — either because this stream came from a snapshot export on that
 * connection, or because ANY export snapshot or streaming import holds it when
 * the first chunk arrives (which covers a stream the caller has wrapped). The
 * error's `details.heldBy` names the holder's kind and `details.code` the
 * condition: `INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT` (or
 * `INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT`) behind an export snapshot,
 * `INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS` behind another import.
 *
 * Once accepted, the import holds that connection's one stream lease for the
 * whole call — every chunk AND the trailing statistics refresh, which is a
 * write like any other — so any export snapshot or second import that tries to
 * start while a write of this import is still to come is the side refused, and
 * this import keeps running instead of stalling against a transaction it can
 * never write past.
 *
 * Connections we cannot observe are not detected: two clients dialed at one
 * server, or two SQLite handles on one file, are independent and are not
 * refused. Neither is a connection whose driver we cannot positively identify as
 * single-connection — see the residual gap documented in
 * `backend/transaction-resource.ts`.
 */
export async function importGraphStream<G extends GraphDef>(
  store: Store<G>,
  chunks: AsyncIterable<GraphInterchangeChunk>,
  rawOptions: ImportOptions,
): Promise<ImportResult> {
  const options = ImportOptionsSchema.parse(rawOptions);
  const sourceBackend = exportStreamBackend(chunks);
  const targetBackend = storeBackend(store);
  // Whether this export would hold the connection the import writes through is
  // decided by the single owner of that predicate — including the
  // `transactions: false` abstention, where nothing is held open and refusing
  // would refuse work that succeeds.
  const contention =
    sourceBackend === undefined ? undefined : (
      snapshotExportContention(sourceBackend, targetBackend)
    );
  if (contention !== undefined) {
    throw serializedStreamRefusal({
      graphId: store.graphId,
      requested: "import-stream",
      heldBy: "export-snapshot",
      detector: contention,
    });
  }
  const result = emptyImportResult();
  let header: GraphDataHeader | undefined;
  let receivedEdges = false;
  let receivedIdentity = false;
  let releaseImportLease: (() => void) | undefined;

  try {
    for await (const chunk of chunks) {
      // The pre-flight check above needs the stream to still identify its source
      // backend, which any user wrapper (a delegating generator, `Readable.from`,
      // a tee) erases. By the time the FIRST chunk arrives the export's snapshot
      // transaction is already open and the registry says so itself, so a wrapped
      // stream fails the same way an unwrapped one does instead of stalling
      // behind a transaction that cannot end until this loop does.
      //
      // The claim is EXCLUSIVE and its check-and-register is one synchronous
      // section inside `acquireSerializedStreamLease`, so the two long-lived
      // streams can never both conclude the connection was free — and the
      // holder it reports may be an export snapshot OR another streaming
      // import, which nests its chunk transactions inside this one's just as
      // fatally. Whoever gets here second is refused; an export starting
      // mid-import is refused by `exportGraphStream` claiming the same lease, so
      // an import whose earlier chunks are already committed is never aborted
      // for someone else's stream. Nothing between the claim and the assignment
      // can throw, so the `finally` below owns every release path.
      if (releaseImportLease === undefined) {
        const lease = acquireSerializedStreamLease(
          targetBackend,
          "import-stream",
        );
        if (!lease.acquired) {
          throw serializedStreamRefusal({
            graphId: store.graphId,
            requested: "import-stream",
            heldBy: lease.heldBy,
          });
        }
        releaseImportLease = lease.release;
      }
      switch (chunk.type) {
        case "header": {
          if (header !== undefined) {
            throw new Error(
              "Graph interchange stream emitted more than one header.",
            );
          }
          // The header is bounded, so validate it at the runtime stream
          // boundary. In particular, an invalid identity profile/mode must not
          // slip through merely because the stream's identity assertion chunk is
          // empty.
          validateStreamHeader(chunk.header);
          // Reject an identity-bearing header aimed at an identity-disabled
          // graph before any chunk is processed, matching importGraph's guard.
          assertIdentityImportSupported(
            store,
            chunk.header.identity !== undefined,
          );
          header = chunk.header;
          break;
        }
        case "nodes": {
          if (header === undefined) {
            throw new Error(
              "Graph interchange stream must start with a header.",
            );
          }
          if (receivedEdges || receivedIdentity) {
            throw new Error(
              `Graph interchange stream cannot emit nodes after ${
                receivedEdges ? "edges" : "identity assertions"
              }.`,
            );
          }
          if (chunk.nodes.length === 0) break;
          mergeImportResult(
            result,
            await importGraphData(
              store,
              graphDataForChunk(header, chunk.nodes, [], []),
              {
                ...options,
                refreshStatistics: false,
              },
            ),
          );
          throwIfStreamChunkFailed(result, options);
          break;
        }
        case "edges": {
          if (header === undefined) {
            throw new Error(
              "Graph interchange stream must start with a header.",
            );
          }
          if (receivedIdentity) {
            throw new Error(
              "Graph interchange stream cannot emit edges after identity assertions.",
            );
          }
          receivedEdges = true;
          if (chunk.edges.length === 0) break;
          mergeImportResult(
            result,
            await importGraphData(
              store,
              graphDataForChunk(header, [], chunk.edges, []),
              {
                ...options,
                refreshStatistics: false,
              },
            ),
          );
          throwIfStreamChunkFailed(result, options);
          break;
        }
        case "identity": {
          if (header === undefined) {
            throw new Error(
              "Graph interchange stream must start with a header.",
            );
          }
          if (header.identity === undefined) {
            throw new Error(
              "Graph interchange stream emitted identity rows without an identity header.",
            );
          }
          receivedIdentity = true;
          if (chunk.assertions.length === 0) break;
          mergeImportResult(
            result,
            await importGraphData(
              store,
              graphDataForChunk(header, [], [], chunk.assertions),
              { ...options, refreshStatistics: false },
            ),
          );
          throwIfStreamChunkFailed(result, options);
          break;
        }
      }
    }
    if (header === undefined) {
      throw new Error(
        "Graph interchange stream ended before emitting a header.",
      );
    }
    // The trailing ANALYZE is a WRITE on the target connection, exactly like
    // the chunks were, so it belongs inside the lease rather than after it.
    // Releasing at the end of the chunk loop instead left this write outside
    // every guard: on a serialized connection an export snapshot opening in
    // that window takes the one connection ANALYZE has to run on and does not
    // give it back until the export ends, and the refresh's best-effort
    // handling swallowed the result as a warning. The lease now spans every
    // write this call makes — the same span `withImportStreamLease` gives
    // `importGraph`, whose refresh has always been inside it.
    await refreshStatisticsAfterImport(
      store,
      options,
      result,
      "importGraphStream",
    );
  } finally {
    // One release for every exit — the loop's, the missing-header throw, and
    // the refresh's — so "the lease lives exactly as long as the writes" holds
    // on the error paths too.
    releaseImportLease?.();
  }
  return { ...result, success: result.errors.length === 0 };
}

/**
 * The single owner of the refusal raised when two long-lived interchange streams
 * would run on one serialized database connection — from the import's pre-flight
 * check on the stream's own backend, from its mid-stream claim, and from
 * `exportGraphStream`'s claim alike, so every path states the same detected
 * condition in the same vocabulary.
 *
 * The CODE names the condition — which kind of stream holds the connection —
 * rather than which side was refused. `INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT`
 * is not a second condition: it reports that the object-identity DETECTOR
 * answered (one SQLite backend exporting into itself), which is worth telling
 * apart because the fix differs — pass a second backend, rather than await
 * whatever else is running. `details.heldBy`
 * and `details.requested` then say which pairing was actually refused, so a
 * same-kind refusal (import behind import, export behind export) is never
 * reported as something it is not:
 *
 * | holder          | code                                          |
 * | --------------- | --------------------------------------------- |
 * | export snapshot | `INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT` (or `INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT` when the object-identity detector answered) |
 * | import stream   | `INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS`   |
 *
 * Every message describes exactly what is detected. None claims anything about
 * connections we cannot observe (two clients dialed at the same server, two
 * SQLite handles on one file), which are independent and are not refused.
 */
export function serializedStreamRefusal(
  input: Readonly<{
    graphId: string;
    requested: SerializedStreamKind;
    heldBy: SerializedStreamKind;
    /**
     * Which detector found the holding export snapshot, when the import's
     * pre-flight — not the lease — is what answered. Only
     * `"same-sqlite-backend"` changes the code, because only that detector
     * identifies a distinguishable situation for the caller: the source and the
     * target are the same SQLite backend object, which no ordering can fix.
     */
    detector?: SnapshotExportContention;
  }>,
): ConfigurationError {
  const { graphId, requested, heldBy, detector } = input;
  const code =
    heldBy === "import-stream" ? SERIALIZED_IMPORT_IN_PROGRESS_CODE
    : detector === "same-sqlite-backend" ?
      "INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT"
    : "INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT";
  const { message, suggestion } = serializedStreamRefusalText(
    requested,
    heldBy,
  );
  return new ConfigurationError(
    message,
    { code, graphId, requested, heldBy },
    { suggestion },
  );
}

/**
 * The refusal code for "a streaming import holds the connection this stream
 * needs", in either of the two orders it can be discovered.
 */
const SERIALIZED_IMPORT_IN_PROGRESS_CODE =
  "INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS";

/**
 * What each of the four pairings actually does to the one connection. Each
 * message names both streams, because "a stream already holds this connection"
 * is not actionable without knowing which one.
 */
function serializedStreamRefusalText(
  requested: SerializedStreamKind,
  heldBy: SerializedStreamKind,
): Readonly<{ message: string; suggestion: string }> {
  if (heldBy === "export-snapshot") {
    return requested === "import-stream" ?
        {
          message:
            "A snapshot export cannot be streamed into a target that writes through the same serialized database connection: the export's read transaction holds that connection open for the whole stream, so this import can never take the writer slot it needs.",
          suggestion:
            "Export to a file first, or import the stream into an independent backend.",
        }
      : {
          message:
            "A snapshot export cannot open on a serialized database connection while another snapshot export is streaming from it: the second export's read transaction would have to nest inside the first one on the single connection they share.",
          suggestion:
            "Await the export already in flight before starting the next one, or export from an independent backend.",
        };
  }
  return requested === "export-snapshot" ?
      {
        message:
          "A snapshot export cannot open on a serialized database connection while a streaming import is writing through it: the export's read transaction would hold the one connection the import's next chunk has to write on.",
        suggestion:
          "Await the import before exporting, or export from an independent backend.",
      }
    : {
        message:
          "A streaming import cannot open on a serialized database connection while another streaming import is writing through it: the two imports commit their chunks on the single connection they share, so the second one's chunk transaction would have to nest inside the first one's.",
        suggestion:
          "Await the import already in flight before starting the next one, or import into an independent backend.",
      };
}

function throwIfStreamChunkFailed(
  result: ImportResult,
  options: ResolvedImportOptions,
): void {
  if (options.onStreamChunkError === "continue" || result.errors.length === 0) {
    return;
  }
  throw new Error(
    "Graph interchange stream aborted after a chunk reported import errors. " +
      'Earlier chunks remain committed; use onStreamChunkError: "continue" for best-effort ingestion.',
  );
}

/**
 * Rejects an identity payload aimed at an identity-disabled graph BEFORE any
 * entity write. The internal identity import coordinator raises the same
 * typed `ConfigurationError` (code `IDENTITY_IMPORT_REQUIRES_PROFILE`), but only
 * after `processNodes`/`processEdges` have run — a partial write on a
 * non-transactional backend — and only for a NON-empty assertions array (an
 * empty envelope short-circuits and silently succeeds there). This guard fires
 * first and regardless of assertion count.
 */
function assertIdentityImportSupported<G extends GraphDef>(
  store: Store<G>,
  hasIdentitySection: boolean,
): void {
  if (hasIdentitySection && store.graph.identity === undefined) {
    throw new ConfigurationError(
      "Cannot import identity assertions into an identity-disabled graph.",
      { code: "IDENTITY_IMPORT_REQUIRES_PROFILE", graphId: store.graphId },
    );
  }
}

/**
 * Runtime-validates just the identity section of an otherwise pre-typed
 * `GraphData`. {@link importGraph} deliberately trusts the type for the
 * (potentially graph-sized) node and edge arrays to preserve its per-row
 * performance, but a JS caller can still smuggle an out-of-domain `relation` or
 * a non-canonical timestamp straight into SQL — which SQLite accepts and
 * PostgreSQL rejects, a backend-parity divergence. The identity section is
 * bounded, so parsing only it closes that gap without the whole-envelope cost.
 */
function validateIdentitySection(identity: GraphData["identity"]): void {
  if (identity === undefined) return;
  const parsed = InterchangeIdentitySchema.safeParse(identity);
  if (parsed.success) return;
  throw new ValidationError(
    `Invalid identity interchange section: ${parsed.error.message}`,
    {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    },
    { cause: parsed.error },
  );
}

/**
 * An identity assertion is neither a node nor an edge, so it carries its own
 * `entityType`. The identity analogue of a node or edge kind is the relation
 * asserted, and the entity id is the assertion id. A failure that cannot be
 * attributed to a document assertion — which the coordinator's own error
 * details should always allow — falls back to naming the target graph, so the
 * entry still reaches the caller rather than being dropped or rethrown.
 */
const IDENTITY_IMPORT_ERROR_ENTITY_TYPE = "identity";
const IDENTITY_IMPORT_ERROR_PATH = "identity.assertions";
const UNATTRIBUTED_IDENTITY_ERROR_KIND = "assertion";
const IDENTITY_IMPORT_ID_CONFLICT_CODE = "IDENTITY_IMPORT_ID_CONFLICT";

function identityImportError(
  assertion: InterchangeIdentityAssertion | undefined,
  graphId: string,
  message: string,
): ImportError {
  const path =
    assertion === undefined ?
      IDENTITY_IMPORT_ERROR_PATH
    : `${IDENTITY_IMPORT_ERROR_PATH}[${assertion.id}]`;
  return {
    entityType: IDENTITY_IMPORT_ERROR_ENTITY_TYPE,
    kind: assertion?.relation ?? UNATTRIBUTED_IDENTITY_ERROR_KIND,
    id: assertion?.id ?? graphId,
    error: `${path}: ${message}`,
  };
}

function isIdConflictError(error: unknown): error is ConfigurationError {
  return (
    error instanceof ConfigurationError &&
    error.details["code"] === IDENTITY_IMPORT_ID_CONFLICT_CODE
  );
}

function touchesRef(
  assertion: InterchangeIdentityAssertion,
  ref: Readonly<{ kind: string; id: string }>,
): boolean {
  return (
    (assertion.a.kind === ref.kind && assertion.a.id === ref.id) ||
    (assertion.b.kind === ref.kind && assertion.b.id === ref.id)
  );
}

/**
 * Converts a per-document identity failure into an {@link ImportError}, or
 * returns `undefined` for anything that is not one — a configuration or
 * programming fault must still propagate.
 */
function asIdentityImportError(
  assertions: readonly InterchangeIdentityAssertion[],
  graphId: string,
  error: unknown,
): ImportError | undefined {
  // The coordinator tags the error with the id of the assertion it was
  // APPLYING — exact attribution. The endpoint heuristics below are only the
  // fallback for an untagged error: they pick the first assertion touching
  // the endpoints, which is wrong whenever an earlier assertion over the same
  // pair succeeded.
  const tagged = taggedAssertion(assertions, error);
  if (error instanceof NodeNotFoundError) {
    const ref = error.details;
    const assertion =
      tagged ?? assertions.find((candidate) => touchesRef(candidate, ref));
    return identityImportError(assertion, graphId, error.message);
  }
  if (error instanceof IdentityContradictionError) {
    const { a, b } = error.details;
    const assertion =
      tagged ??
      assertions.find(
        (candidate) => touchesRef(candidate, a) && touchesRef(candidate, b),
      );
    return identityImportError(assertion, graphId, error.message);
  }
  if (isIdConflictError(error)) {
    const assertion = assertions.find(
      (candidate) => candidate.id === error.details["assertionId"],
    );
    return identityImportError(assertion, graphId, error.message);
  }
  if (isIdentityAssertionValidationError(error)) {
    const issue = error.details.issues[0];
    const message =
      issue === undefined ?
        error.message
      : `${error.message} (${issue.message})`;
    return identityImportError(
      assertions.find((candidate) => candidate.id === issue?.assertionId),
      graphId,
      message,
    );
  }
  return undefined;
}

/**
 * The assertion the coordinator tagged onto the error via
 * `IDENTITY_IMPORT_FAILED_ASSERTION` — exact, structural attribution for any
 * error shape.
 */
function taggedAssertion(
  assertions: readonly InterchangeIdentityAssertion[],
  error: unknown,
): InterchangeIdentityAssertion | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const id = (error as Record<PropertyKey, unknown>)[
    IDENTITY_IMPORT_FAILED_ASSERTION
  ];
  if (typeof id !== "string") return undefined;
  return assertions.find((candidate) => candidate.id === id);
}

/**
 * A `ValidationError` the identity import coordinator raised about assertion
 * CONTENT (ended rows in state mode, out-of-bounds validity windows, unknown
 * kinds, unnormalized pairs, self-assertions). Every issue it emits is pathed
 * at `identity.assertions` and carries the offending assertion's id
 * structurally in `assertionId` — attribution never parses the
 * human-readable message. A validation error shaped any other way is a
 * document-shape or programming fault and must still propagate.
 */
function isIdentityAssertionValidationError(
  error: unknown,
): error is ValidationError {
  return (
    error instanceof ValidationError &&
    error.details.issues.length > 0 &&
    error.details.issues.every(
      (issue) =>
        issue.path === "identity.assertions" && issue.assertionId !== undefined,
    )
  );
}

/**
 * Applies the identity section, recording a per-document failure in
 * `result.errors` instead of aborting the whole import.
 *
 * {@link importGraph} promises `{ success: false, errors }` for content the
 * target rejects, and the node and edge paths honor that by recording the
 * offending row and moving on. The identity coordinator instead throws, so a
 * missing endpoint, a contradiction against the target graph, or a reused
 * assertion id escaped the transaction and turned a rejected assertion into a
 * thrown import — discarding the valid node and edge work alongside it.
 *
 * Assertions the coordinator applied before the failing one stay committed,
 * exactly as rows accepted before a failing node do. The tagged error carries
 * the coordinator's completed counts so the returned result describes those
 * durable partial effects accurately.
 */
async function importIdentitySection<G extends GraphDef>(
  runtime: ReturnType<typeof storeRuntime<G>>,
  target: GraphBackend | TransactionBackend,
  graphId: string,
  identity: NonNullable<GraphData["identity"]>,
  result: ImportResult,
  errors: ImportError[],
): Promise<void> {
  try {
    const summary = await runtime.importIdentityAssertionsAtTarget(
      target,
      identity.assertions,
      identity.mode,
    );
    result.identity.created += summary.created;
    result.identity.skipped += summary.skipped;
  } catch (error) {
    const entry = asIdentityImportError(identity.assertions, graphId, error);
    if (entry === undefined) throw error;
    const progress = identityImportProgress(error);
    result.identity.created += progress.created;
    result.identity.skipped += progress.skipped;
    errors.push(entry);
  }
}

function identityImportProgress(
  error: unknown,
): Readonly<{ created: number; skipped: number }> {
  if (typeof error !== "object" || error === null) {
    return { created: 0, skipped: 0 };
  }
  const progress = (error as Record<PropertyKey, unknown>)[
    IDENTITY_IMPORT_PROGRESS
  ];
  if (
    typeof progress !== "object" ||
    progress === null ||
    !("created" in progress) ||
    typeof progress.created !== "number" ||
    !("skipped" in progress) ||
    typeof progress.skipped !== "number"
  ) {
    return { created: 0, skipped: 0 };
  }
  return { created: progress.created, skipped: progress.skipped };
}

function validateStreamHeader(header: GraphDataHeader): void {
  const parsed = GraphDataHeaderSchema.safeParse(header);
  if (parsed.success) return;
  throw new ValidationError(
    `Invalid graph interchange stream header: ${parsed.error.message}`,
    {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    },
    { cause: parsed.error },
  );
}

function emptyImportResult(): ImportResult {
  return {
    success: true,
    nodes: { created: 0, updated: 0, skipped: 0 },
    edges: { created: 0, updated: 0, skipped: 0 },
    identity: { created: 0, skipped: 0 },
    errors: [],
  };
}

function graphDataForChunk(
  header: GraphDataHeader,
  nodes: GraphData["nodes"],
  edges: GraphData["edges"],
  assertions: readonly InterchangeIdentityAssertion[],
): GraphData {
  const { identity, ...headerWithoutIdentity } = header;
  return {
    ...headerWithoutIdentity,
    nodes,
    edges,
    ...(identity === undefined ?
      {}
    : {
        identity: { ...identity, assertions: [...assertions] },
      }),
  };
}
function mergeImportResult(target: ImportResult, source: ImportResult): void {
  target.nodes.created += source.nodes.created;
  target.nodes.updated += source.nodes.updated;
  target.nodes.skipped += source.nodes.skipped;
  target.edges.created += source.edges.created;
  target.edges.updated += source.edges.updated;
  target.edges.skipped += source.edges.skipped;
  target.identity.created += source.identity.created;
  target.identity.skipped += source.identity.skipped;
  target.errors.push(...source.errors);
}

/**
 * Refreshes planner statistics after a mutating import.
 *
 * CALLED UNDER THE TARGET CONNECTION'S STREAM LEASE by every surface: ANALYZE
 * is a write, and a write that runs outside the lease can be stranded by an
 * export snapshot that takes the one connection it needs. `importGraph` holds
 * the lease through {@link withImportStreamLease} for its whole call;
 * `importGraphStream` holds its chunk-loop lease across this call too.
 *
 * Best-effort: by this point the import is committed, so a failed statistics
 * refresh must not convert the completed (non-atomic on some backends,
 * non-retryable) import into a thrown failure — it degrades to a warning, and
 * the caller can run `store.refreshStatistics()`.
 */
async function refreshStatisticsAfterImport<G extends GraphDef>(
  store: Store<G>,
  options: ResolvedImportOptions,
  result: ImportResult,
  surface: "importGraph" | "importGraphStream",
): Promise<void> {
  const mutationCount =
    result.nodes.created +
    result.nodes.updated +
    result.edges.created +
    result.edges.updated +
    result.identity.created;
  if ((options.refreshStatistics ?? true) && mutationCount > 0) {
    try {
      await store.refreshStatistics();
    } catch (error) {
      if (
        typeof console !== "undefined" &&
        typeof console.warn === "function"
      ) {
        console.warn(
          `[typegraph] ${surface} committed its rows but the follow-up ` +
            "statistics refresh failed; run store.refreshStatistics() to " +
            "give the planner fresh statistics.",
          error,
        );
      }
    }
  }
}

// ============================================================
// Schema Maps
// ============================================================

type NodeSchemaEntry = Readonly<{
  registration: NodeRegistration;
  schema: z.ZodObject<z.ZodRawShape>;
}>;

type EdgeSchemaEntry = Readonly<{
  registration: EdgeRegistration;
  schema: z.ZodObject<z.ZodRawShape>;
}>;

function buildNodeSchemaMap(
  graph: GraphDef,
): ReadonlyMap<string, NodeSchemaEntry> {
  const map = new Map<string, NodeSchemaEntry>();

  for (const kindName of getNodeKinds(graph)) {
    const registration = graph.nodes[kindName] as NodeRegistration;
    map.set(kindName, {
      registration,
      schema: registration.type.schema,
    });
  }

  return map;
}

function buildEdgeSchemaMap(
  graph: GraphDef,
): ReadonlyMap<string, EdgeSchemaEntry> {
  const map = new Map<string, EdgeSchemaEntry>();

  for (const kindName of getEdgeKinds(graph)) {
    const registration = graph.edges[kindName] as EdgeRegistration;
    map.set(kindName, {
      registration,
      schema: registration.type.schema,
    });
  }

  return map;
}

// ============================================================
// Node Processing
// ============================================================

async function processNodes(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  registry: KindRegistry,
  nodes: readonly InterchangeNode[],
  schemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ResolvedImportOptions,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
  lock: GraphWriteLock,
): Promise<void> {
  const batchSize = options.batchSize;

  for (let index = 0; index < nodes.length; index += batchSize) {
    const batch = nodes.slice(index, index + batchSize);
    await processNodeSlice(
      backend,
      graphId,
      registry,
      batch,
      schemas,
      options,
      result,
      errors,
      importedNodeIds,
      lock,
    );
  }
}

function recordNodeOutcome(
  node: InterchangeNode,
  outcome: ProcessResult,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
): void {
  switch (outcome.status) {
    case "created": {
      result.nodes.created++;
      importedNodeIds.add(makeNodeKey(node.kind, node.id));
      break;
    }
    case "updated": {
      result.nodes.updated++;
      importedNodeIds.add(makeNodeKey(node.kind, node.id));
      break;
    }
    case "skipped": {
      result.nodes.skipped++;
      // A live skipped row is still a valid edge endpoint; a tombstone
      // is not.
      if (outcome.liveTarget) {
        importedNodeIds.add(makeNodeKey(node.kind, node.id));
      }
      break;
    }
    case "error": {
      errors.push({
        entityType: "node",
        kind: node.kind,
        id: node.id,
        error: outcome.error,
      });
      break;
    }
  }
}

type NodeImportCandidate = Readonly<{
  node: InterchangeNode;
  schemaEntry: NodeSchemaEntry;
  props: Record<string, unknown>;
  draft: NodeCreateDraft;
}>;

/**
 * Processes one batchSize slice of nodes with batched round trips:
 * one `getNodes` per kind for existence, one `checkUniqueBatch` per
 * (constraint, kind) for uniqueness pre-checks (both priming the shared
 * batch validation caches), then one multi-row insert and one batched
 * side-effect pass for the accepted creates. Per-row semantics are
 * unchanged — conflicts route by `onConflict`, a uniqueness conflict is a
 * per-row error entry, and rows repeating an id already seen in the slice
 * defer to the per-row path after the flush (so they observe the first
 * occurrence's row exactly as the sequential implementation did).
 */
async function processNodeSlice(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  registry: KindRegistry,
  batch: readonly InterchangeNode[],
  schemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ResolvedImportOptions,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
  lock: GraphWriteLock,
): Promise<void> {
  const record = (node: InterchangeNode, outcome: ProcessResult): void => {
    recordNodeOutcome(node, outcome, result, errors, importedNodeIds);
  };

  // Pass 1 (synchronous): kind + property + validity validation, and
  // in-slice duplicate deferral.
  const candidates: NodeImportCandidate[] = [];
  const deferred: InterchangeNode[] = [];
  const seenKeys = new Set<string>();
  for (const node of batch) {
    const schemaEntry = schemas.get(node.kind);
    if (!schemaEntry) {
      record(node, {
        status: "error",
        error: `Unknown node kind: ${node.kind}`,
      });
      continue;
    }
    const propsResult = validateProperties(
      node.properties,
      schemaEntry.schema,
      options.onUnknownProperty,
    );
    if (!propsResult.success) {
      record(node, { status: "error", error: propsResult.error });
      continue;
    }
    const validityError = validateValidityWindow(node);
    if (validityError !== undefined) {
      record(node, { status: "error", error: validityError });
      continue;
    }
    const key = makeNodeKey(node.kind, node.id);
    if (seenKeys.has(key)) {
      deferred.push(node);
      continue;
    }
    seenKeys.add(key);
    candidates.push({
      node,
      schemaEntry,
      props: propsResult.data,
      draft: {
        kind: node.kind,
        id: node.id,
        // Interchange rows always carry an explicit id.
        idProvided: true,
        nodeKind: schemaEntry.registration.type,
        uniqueConstraints: schemaEntry.registration.unique ?? [],
        validatedProps: propsResult.data,
        // NodeCreateDraft.validFrom is string | undefined (never null) — it
        // only feeds batch validation-cache priming, which never inspects
        // it, so normalizing the explicit-NULL sentinel away here is inert.
        // The actual insert (buildImportInsertParams) reads node.validFrom
        // directly and preserves the null.
        validFrom: node.validFrom ?? undefined,
        validTo: node.validTo,
      },
    });
  }

  // Prime the validation caches with batched reads, then route each row
  // against memory in input order.
  const {
    backend: validationBackend,
    registerPendingNode,
    registerPendingUniqueEntries,
    registerAppliedNodeUpdate,
    seedNodeRow,
    seedUniqueRow,
  } = createNodeBatchValidationBackend(graphId, registry, backend);
  await primeBatchValidationCaches(
    { graphId, registry },
    candidates.map((candidate) => candidate.draft),
    backend,
    { seedNodeRow, seedUniqueRow },
  );

  const writeContext = { graphId, registry, lock };
  const accepted: NodeImportCandidate[] = [];
  for (const candidate of candidates) {
    const { node, schemaEntry, props } = candidate;
    const uniqueConstraints = schemaEntry.registration.unique ?? [];
    const existing = await validationBackend.getNode(
      graphId,
      node.kind,
      node.id,
    );

    if (existing) {
      switch (options.onConflict) {
        case "skip": {
          record(node, {
            status: "skipped",
            liveTarget: isLiveNodeRow(existing),
          });
          break;
        }
        case "error": {
          record(node, {
            status: "error",
            error: `Node already exists: ${node.kind}:${node.id}`,
          });
          break;
        }
        case "update": {
          if (!isLiveNodeRow(existing)) {
            // Import never resurrects a tombstone — see processNode.
            record(node, { status: "skipped", liveTarget: false });
            break;
          }
          const updateWindow = validateUpdateValidityWindow(
            node,
            existing.valid_from,
          );
          if (!updateWindow.ok) {
            record(node, { status: "error", error: updateWindow.error });
            break;
          }
          const updateError = await updateImportedNode(
            writeContext,
            // The pending-aware overlay, not the raw backend: the update's
            // uniqueness pre-check must see a unique value already reserved by
            // an unflushed create EARLIER in this slice, so it degrades to a
            // per-row error exactly as the sequential path does — rather than
            // claiming the key on the real backend and colliding with that
            // create at flush (which would throw and roll back the whole
            // import). Writes still delegate to the real backend.
            validationBackend,
            node,
            {
              existing,
              schema: schemaEntry.registration.type.schema,
              validatedProps: props,
              uniqueConstraints,
              windowFence: updateWindow.value,
            },
          );
          if (updateError === undefined) {
            // The update mutated the real backend's uniqueness rows directly;
            // reconcile the shared prime caches so a later create in this
            // slice sees the post-update reservation state (matching the
            // sequential path). See registerAppliedNodeUpdate.
            registerAppliedNodeUpdate(
              node.kind,
              node.id,
              rowPropsToObject(existing.props),
              props,
              uniqueConstraints,
            );
          }
          record(
            node,
            updateError === undefined ?
              { status: "updated" }
            : { status: "error", error: updateError },
          );
          break;
        }
      }
      continue;
    }

    const uniquenessResult = await catchUniquenessError(() =>
      checkUniquenessConstraints(
        { graphId, registry, backend: validationBackend },
        node.kind,
        node.id,
        props,
        uniqueConstraints,
      ),
    );
    if (!uniquenessResult.ok) {
      record(node, { status: "error", error: uniquenessResult.error });
      continue;
    }

    registerPendingNode(buildImportInsertParams(graphId, candidate));
    registerPendingUniqueEntries(node.kind, node.id, props, uniqueConstraints);
    accepted.push(candidate);
  }

  // Flush the accepted creates: one multi-row insert, then the batched
  // side effects (uniqueness entries, fulltext, embeddings).
  if (accepted.length > 0) {
    const insertParamsList = accepted.map((candidate) =>
      buildImportInsertParams(graphId, candidate),
    );
    if (backend.insertNodesBatch === undefined) {
      for (const params of insertParamsList) {
        await backend.insertNode(params);
      }
    } else {
      await backend.insertNodesBatch(insertParamsList);
    }
    await applyNodeInsertSideEffectsBatch(
      writeContext,
      accepted.map((candidate) => ({
        kind: candidate.node.kind,
        id: candidate.node.id,
        schema: candidate.schemaEntry.registration.type.schema,
        props: candidate.props,
        uniqueConstraints: candidate.schemaEntry.registration.unique ?? [],
      })),
      backend,
    );
    for (const candidate of accepted) {
      record(candidate.node, { status: "created" });
    }
  }

  // In-slice duplicate ids run per-row AFTER the flush so they observe the
  // first occurrence's committed row, exactly as the sequential path did.
  for (const node of deferred) {
    record(
      node,
      await processNode(
        backend,
        graphId,
        registry,
        node,
        schemas,
        options,
        lock,
      ),
    );
  }
}

function buildImportInsertParams(
  graphId: string,
  candidate: NodeImportCandidate,
): Parameters<GraphBackend["insertNode"]>[0] {
  const { node, props } = candidate;
  return {
    graphId,
    kind: node.kind,
    id: node.id,
    props,
    ...(node.validFrom !== undefined && { validFrom: node.validFrom }),
    ...(node.validTo !== undefined && { validTo: node.validTo }),
  };
}

type ProcessResult =
  | { status: "created" }
  | { status: "updated" }
  /**
   * `liveTarget` distinguishes "skipped because a LIVE row already exists"
   * (a valid edge endpoint) from "skipped because the row is a tombstone"
   * (which must NOT be recorded as available — a live edge pointing at a
   * soft-deleted node violates the endpoint-liveness invariant the
   * collection API enforces).
   */
  | { status: "skipped"; liveTarget: boolean }
  | { status: "error"; error: string };

/**
 * What a guard hands back when its refusal is a PER-ROW fact: either the value
 * the guard produced, or the message recorded against that row while the import
 * keeps going. Shared by the uniqueness guard and the window guard so the two
 * per-row recoveries have one shape.
 */
type PerRowGuardResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: string }>;

/**
 * Runs `fn` and reports a `UniquenessError` as a per-row result instead of
 * letting it abort the whole import — the same recovery both the node
 * uniqueness pre-check and the update path need. Any other error still
 * propagates.
 */
async function catchUniquenessError<T>(
  fn: () => Promise<T>,
): Promise<PerRowGuardResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof UniquenessError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/**
 * The stable prefix on every per-row refusal caused by an import UPDATE whose
 * target stopped matching the row this import made its decision from.
 *
 * The node counterpart of {@link EDGE_IDENTITY_CONFLICT_CODE}. Nodes need no
 * identity code — their probe is kind-scoped and they have no endpoints — but
 * they do share the temporal half of the class: the update verdict is computed
 * from the PROBED row's `valid_from`, and a concurrent hard delete + recreate
 * can replace it between the probe and the write.
 */
const NODE_UPDATE_TARGET_CHANGED_CODE =
  "INTERCHANGE_NODE_UPDATE_TARGET_CHANGED";

/**
 * Updates an existing node under the effective validity lower bound this import
 * checked it carries, and reports a write that landed on nothing as a per-row
 * error.
 *
 * THE SINGLE OWNER of the node update leg, called by both the batched slice and
 * the sequential fallback, so the assertion cannot be threaded through one and
 * forgotten on the other.
 *
 * The `windowFence` is what makes the import's own window check
 * ({@link validateUpdateValidityWindow}) binding rather than advisory. When that
 * check reads the STORED `valid_from` — because the document stated a lower
 * bound to compare against it, or a lone `validTo` to invert against it — it
 * hands back an `expectedValidFrom` predicate, and a read-then-write pair keyed
 * on `(graph_id, kind, id)` alone would otherwise re-resolve that key between the
 * two under PostgreSQL READ COMMITTED: a concurrent hard delete + recreate could
 * leave the write applying a verdict computed for a row that no longer exists —
 * the document's `validFrom` silently ignored, or a `valid_to` persisted below
 * the new row's `valid_from`. The fence puts the bound in the UPDATE's own
 * `WHERE`.
 *
 * A document naming NEITHER bound gets an empty fence, and that is the point: its
 * verdict never looked at the row's lower bound, so a recreate that moved the
 * bound changed nothing this write decided, and refusing the props update would
 * refuse a write the equivalent `store.nodes.*.update` performs. The
 * `deleted_at IS NULL` fence of the live-row update still applies.
 */
async function updateImportedNode(
  writeContext: NodeWriteContext,
  backend: GraphBackend | TransactionBackend,
  node: InterchangeNode,
  args: Readonly<{
    existing: LiveNodeRow;
    schema: z.ZodType;
    validatedProps: Record<string, unknown>;
    uniqueConstraints: readonly UniqueConstraint[];
    windowFence: ValidityLowerBoundFence;
  }>,
): Promise<string | undefined> {
  try {
    const result = await catchUniquenessError(() =>
      applyNodeUpdate(
        writeContext,
        {
          existing: args.existing,
          schema: args.schema,
          validatedProps: args.validatedProps,
          uniqueConstraints: args.uniqueConstraints,
          ...args.windowFence,
          ...(node.validTo !== undefined && { validTo: node.validTo }),
        },
        backend,
      ),
    );
    return result.ok ? undefined : result.error;
  } catch (error) {
    if (
      !(error instanceof DatabaseOperationError) ||
      error.details.reason !== "no_row_returned"
    ) {
      throw error;
    }
    return (
      `${NODE_UPDATE_TARGET_CHANGED_CODE}: Node "${node.kind}:${node.id}" was ` +
      "not updated: no live node matching the id and the validity bound this " +
      "import checked remained when the write ran, so the row changed or was " +
      "removed after it was checked. Re-export the source and retry."
    );
  }
}

/**
 * The stable prefix on every per-row refusal caused by an incoming edge naming
 * an id that a DIFFERENT edge already occupies, so a caller can recognize the
 * condition without parsing prose — the same `CODE: message` idiom the validity
 * window refusals use.
 *
 * ONE code for the whole immutable-identity class — kind AND endpoints — rather
 * than a second code for endpoint mismatches. The condition is a single fact
 * ("the row under this id is not the edge this document describes"), the
 * recovery is a single action ("give it a distinct id, or import it under the
 * identity the stored row carries"), and a caller that had to match two prefixes
 * to catch one condition would eventually match only one. The message names
 * which components differ; the prefix says what class of thing went wrong.
 *
 * The token still reads `…_KIND_CONFLICT` because it is a PUBLISHED, branchable
 * prefix (documented in `interchange.md`) and renaming it would silently break
 * every caller filtering on it; the constant is named for what it now covers.
 */
const EDGE_IDENTITY_CONFLICT_CODE = "INTERCHANGE_EDGE_KIND_CONFLICT";

/** The immutable identity of a stored edge, as the probe reports it. */
type StoredEdgeIdentity = Readonly<{
  kind: string;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
}>;

/**
 * Whether an existing row is actually the edge this document is describing.
 *
 * THE SINGLE OWNER of that decision, consulted by both edge-import paths (the
 * batched slice and the per-row fallback) before ANY conflict strategy runs.
 *
 * Edge ids are graph-global while every interchange edge states a kind AND both
 * endpoints, and the existence probe (`getEdge` / `getEdges`) is keyed on
 * `(graph_id, id)` alone — so an incoming edge whose id is already taken by a
 * DIFFERENT edge finds that row and, without this check, was treated as the same
 * edge by all three strategies: `update` wrote the incoming props onto the other
 * row with nothing in `result.errors`, and `skip` counted the document's edge as
 * already present when nothing matching was ever there. Both are silent, and the
 * id is unique per graph, so the incoming edge cannot be created under it
 * either. Reporting is the only honest outcome.
 *
 * Compares the FULL immutable identity — kind and all four endpoint components —
 * not kind alone. Kind is not an identity: an id already held by an edge of the
 * same kind pointing somewhere else is just as much "not this edge", and a
 * kind-only comparison reported `updated: 1` while overwriting that row's props
 * and silently retaining its old endpoints (endpoints are immutable, so the
 * document's stated `from`/`to` were simply discarded). Every component is
 * checked because every component is immutable for a given row.
 *
 * Deliberately checked ABOVE the `onConflict` switch rather than inside each
 * arm: the question "is this the same edge?" is prior to "what do we do about
 * the same edge?", and answering it per-arm is how two of the three arms came
 * to answer it differently.
 *
 * Nodes need no equivalent: their probe is `getNode(graphId, kind, id)`, which
 * is kind-scoped, and a node has no endpoints — so a cross-kind id collision
 * simply reads as absent there.
 */
function edgeIdentityConflict(
  edge: InterchangeEdge,
  existing: StoredEdgeIdentity,
): string | undefined {
  const differences = [
    ...(existing.kind === edge.kind ?
      []
    : [`kind "${existing.kind}" (document states "${edge.kind}")`]),
    ...((
      existing.from_kind === edge.from.kind && existing.from_id === edge.from.id
    ) ?
      []
    : [
        `from "${existing.from_kind}:${existing.from_id}" (document states ` +
          `"${edge.from.kind}:${edge.from.id}")`,
      ]),
    ...(existing.to_kind === edge.to.kind && existing.to_id === edge.to.id ?
      []
    : [
        `to "${existing.to_kind}:${existing.to_id}" (document states ` +
          `"${edge.to.kind}:${edge.to.id}")`,
      ]),
  ];
  if (differences.length === 0) return undefined;
  return (
    `${EDGE_IDENTITY_CONFLICT_CODE}: Edge "${edge.id}" already exists with a ` +
    `different immutable identity — ${differences.join("; ")}. Edge ids are ` +
    "unique per graph, so the incoming edge can neither update nor be created " +
    "under that id. Give it a distinct id, or import it under the identity the " +
    "stored row already carries."
  );
}

/**
 * Updates an existing edge under the full immutable identity the caller checked
 * it carries, and reports a write that landed on nothing as a per-row error.
 *
 * All five identity components are stated so the predicate lives in the UPDATE's
 * own `WHERE` — the contract on {@link UpdateEdgeParams}, and the only placement
 * a concurrent hard-delete-and-recreate cannot slip past, because a
 * read-then-write pair keyed on `(graph_id, id)` alone re-resolves that id
 * between the probe and the write under PostgreSQL READ COMMITTED. Omitting them
 * made the import's own identity check advisory: correct until raced.
 *
 * The endpoints move together with `kind` rather than being left out because
 * they are "less likely" to be raced: the window is the same window, and this
 * import HAS checked all five against a row it read, which is exactly the
 * precondition {@link UpdateEdgeParams} states for asserting them.
 *
 * The effective `valid_from` joins them for a DIFFERENT reason, and the doc on
 * {@link UpdateEdgeParams.expectedValidFrom} spells it out: the five identity
 * components are asserted because they are immutable, the bound because it is
 * NOT. {@link validateUpdateValidityWindow} decides from the row's stored
 * `valid_from` — whether the document may state a lower bound this update will
 * not apply, and whether its `validTo` sits above the bound the row keeps — so a
 * recreate that satisfies all five identity components while carrying a
 * different bound would still land a verdict computed for a row that is gone.
 *
 * Which is why the bound arrives as the guard's own `windowFence` rather than as
 * a value this function re-derives: it is present exactly when the verdict read
 * it. A document naming neither `validFrom` nor `validTo` read nothing, so it is
 * fenced on identity alone and a recreate that only moved the bound no longer
 * refuses its props update.
 *
 * When the predicate does match nothing, the backend reports it as a
 * `no_row_returned` {@link DatabaseOperationError}. By then this import has
 * already checked the identity against a row it read, so reaching here means the
 * target changed underneath us — a per-row fact about one edge, not a reason to
 * abort an import whose earlier rows are already written.
 */
async function updateImportedEdge(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  edge: InterchangeEdge,
  props: Readonly<Record<string, unknown>>,
  windowFence: ValidityLowerBoundFence,
): Promise<string | undefined> {
  try {
    await backend.updateEdge({
      graphId,
      id: edge.id,
      kind: edge.kind,
      fromKind: edge.from.kind,
      fromId: edge.from.id,
      toKind: edge.to.kind,
      toId: edge.to.id,
      props,
      ...windowFence,
      ...(edge.validTo !== undefined && { validTo: edge.validTo }),
    });
    return undefined;
  } catch (error) {
    if (
      !(error instanceof DatabaseOperationError) ||
      error.details.reason !== "no_row_returned"
    ) {
      throw error;
    }
    return (
      `${EDGE_IDENTITY_CONFLICT_CODE}: Edge "${edge.id}" of kind "${edge.kind}" ` +
      `from "${edge.from.kind}:${edge.from.id}" to "${edge.to.kind}:${edge.to.id}" ` +
      "was not updated: no live edge matching the identity and the validity " +
      "bound this import checked remained when the write ran, so the row " +
      "changed or was removed after it was checked. Re-export the source and " +
      "retry."
    );
  }
}

/**
 * Runs a window guard and reports its refusal as a per-row error message
 * (recorded in the import result) instead of throwing, so one malformed row does
 * not abort the whole import. On success the guard's own verdict comes back, so
 * a write leg fences on what the guard decided rather than on a second spelling
 * of it. A window refusal that carries a stable issue code —
 * {@link INVERTED_VALIDITY_WINDOW_CODE} or
 * {@link IMMUTABLE_VALIDITY_LOWER_BOUND_CODE} — is prefixed with it, so the
 * refusal is recognizable without parsing prose.
 */
function windowResultOf<T>(assert: () => T): PerRowGuardResult<T> {
  try {
    return { ok: true, value: assert() };
  } catch (error) {
    if (error instanceof ValidationError) {
      const coded = error.details.issues.find(
        (issue) =>
          issue.code === INVERTED_VALIDITY_WINDOW_CODE ||
          issue.code === IMMUTABLE_VALIDITY_LOWER_BOUND_CODE,
      );
      if (coded !== undefined) {
        return { ok: false, error: `${coded.code}: ${error.message}` };
      }
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** {@link windowResultOf} for a guard whose only output is its refusal. */
function windowErrorOf(assert: () => void): string | undefined {
  const result = windowResultOf(assert);
  return result.ok ? undefined : result.error;
}

/**
 * Validates an entity's validity window against the two contracts `create` /
 * `update` enforce: canonical fixed-width UTC ISO-8601 timestamps, so no import
 * write path can persist a `valid_from` / `valid_to` that later mis-sorts as
 * text against an `asOf` read coordinate, and non-negative window WIDTH, so no
 * import document can persist a row that stopped being true before it started.
 * Import writes straight to the backend rather than through the store
 * operations layer, so it carries its own copy of both — this is the only place
 * the guarantee exists for an imported row.
 *
 * The interchange schema enforces the timestamp contract at the parse boundary,
 * but `importGraph` accepts a pre-typed `GraphData` and does not re-parse it, so
 * this is also the guarantee for callers that bypass the schema.
 *
 * This is the INSERT-shaped half, judged before the existence probe so a
 * malformed document is refused whether or not the row already exists. The
 * update legs additionally call {@link validateUpdateValidityWindow}, which
 * needs the row.
 */
function validateValidityWindow(
  entity: Readonly<{
    kind: string;
    id: string;
    validFrom?: string | null | undefined;
    validTo?: string | undefined;
  }>,
): string | undefined {
  return windowErrorOf(() => {
    // null is a confirmed open-left window (see InterchangeNodeSchema's
    // validFrom doc), not a value to format-check — treat it like
    // "not provided" here, same as the canonical-date validator does.
    validateOptionalCanonicalIsoDate(
      entity.validFrom ?? undefined,
      "validFrom",
    );
    validateOptionalCanonicalIsoDate(entity.validTo, "validTo");
    // On an INSERT only a stated pair is judged — a lone historical validTo
    // means "born already ended", exactly as it does on `create` (see
    // assertWritableValidityWindow). `null` is a confirmed open-left window and
    // is not a lower bound at all.
    assertOrderedValidityWindow(
      `${entity.kind} "${entity.id}"`,
      entity.validFrom ?? undefined,
      entity.validTo,
    );
  });
}

/**
 * The UPDATE-shaped half, for `onConflict: "update"` against a row that already
 * exists. All four update legs — batched and sequential, nodes and edges — send
 * the document's `validTo` to an in-place update of a LIVE row while its stored
 * `valid_from` stays put, so the document's end is held to that bound exactly as
 * `store.nodes.*.update` holds a caller's. Without this an import could still
 * write the inverted row the direct update path refuses, and the insert-shaped
 * check above cannot see it: such a document may state no `validFrom` at all.
 *
 * The document's `validFrom` is judged here for the same reason: import never
 * sends it on an update, so a document stating a bound that differs from the
 * row's is stating one the write will not apply. That is refused per row —
 * `onConflict: "update"` re-importing a document whose rows were created at a
 * different instant now reports those rows instead of silently updating their
 * props under a bound it ignored. `null` is a confirmed open-left window rather
 * than a stated bound (see `InterchangeNodeSchema`'s `validFrom`) and asserts
 * nothing.
 *
 * Returns the guard's own {@link ValidityLowerBoundFence}, which all four update
 * legs carry verbatim into their write. Import used to assert the probed
 * `valid_from` unconditionally instead — a second spelling of a decision the
 * verdict owns — which refused a props-only document (one naming neither bound)
 * whenever a concurrent recreate moved a bound this verdict never looked at.
 */
function validateUpdateValidityWindow(
  entity: Readonly<{
    kind: string;
    id: string;
    validFrom?: string | null | undefined;
    validTo?: string | undefined;
  }>,
  storedValidFrom: string | undefined,
): PerRowGuardResult<ValidityLowerBoundFence> {
  const verdict = windowResultOf(() =>
    assertWritableValidityWindow(
      `${entity.kind} "${entity.id}"`,
      entity.validFrom ?? undefined,
      {
        effectiveValidFrom: storedValidFrom,
        appliesStatedValidFrom: false,
        // Import updates a LIVE row in place, so the effective bound is always
        // the one the row already stores.
        effectiveBoundIsStored: true,
      },
      entity.validTo,
    ),
  );
  return verdict.ok ?
      { ok: true, value: verdict.value.storedLowerBoundFence }
    : verdict;
}

async function processNode(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  registry: KindRegistry,
  node: InterchangeNode,
  schemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ResolvedImportOptions,
  lock: GraphWriteLock,
): Promise<ProcessResult> {
  // Validate kind exists
  const schemaEntry = schemas.get(node.kind);
  if (!schemaEntry) {
    return { status: "error", error: `Unknown node kind: ${node.kind}` };
  }

  // Validate and transform properties
  const propsResult = validateProperties(
    node.properties,
    schemaEntry.schema,
    options.onUnknownProperty,
  );

  if (!propsResult.success) {
    return { status: "error", error: propsResult.error };
  }

  const validityError = validateValidityWindow(node);
  if (validityError !== undefined) {
    return { status: "error", error: validityError };
  }

  const { registration } = schemaEntry;
  const uniqueConstraints = registration.unique ?? [];
  const writeContext = { graphId, registry, lock };

  // Check if node already exists
  const existing = await backend.getNode(graphId, node.kind, node.id);

  if (existing) {
    switch (options.onConflict) {
      case "skip": {
        return { status: "skipped", liveTarget: isLiveNodeRow(existing) };
      }
      case "error": {
        return {
          status: "error",
          error: `Node already exists: ${node.kind}:${node.id}`,
        };
      }
      case "update": {
        if (!isLiveNodeRow(existing)) {
          // A soft-deleted node is not updatable: import never resurrects a
          // tombstone, and running the live-row update pipeline here would
          // recreate uniqueness/embedding/fulltext rows for a node that
          // stays invisible — a uniqueness reservation held by a tombstoned
          // node would block live creates of the same value.
          return { status: "skipped", liveTarget: false };
        }
        const updateWindow = validateUpdateValidityWindow(
          node,
          existing.valid_from,
        );
        if (!updateWindow.ok) {
          return { status: "error", error: updateWindow.error };
        }
        // Route through the shared write step so the update maintains
        // uniqueness entries, embeddings, and fulltext — the collection API's
        // integrity, which a raw backend.updateNode would skip. Both per-row
        // recoveries below are safe to catch and commit past because every
        // `UniquenessError` `applyNodeUpdate` can raise comes from its plan or
        // its claim, both of which precede the row write (and the claim
        // compensates itself), and a write that landed on nothing wrote nothing
        // by definition.
        const updateError = await updateImportedNode(
          writeContext,
          backend,
          node,
          {
            existing,
            schema: registration.type.schema,
            validatedProps: propsResult.data,
            uniqueConstraints,
            windowFence: updateWindow.value,
          },
        );
        if (updateError !== undefined) {
          return { status: "error", error: updateError };
        }
        return { status: "updated" };
      }
    }
  }

  // Create new node. Pre-check uniqueness (as the collection create does) so a
  // conflict is a per-row error rather than an orphaned node row, then apply the
  // integrity side effects the raw backend.insertNode would otherwise bypass.
  const uniquenessResult = await catchUniquenessError(() =>
    checkUniquenessConstraints(
      { graphId, registry, backend },
      node.kind,
      node.id,
      propsResult.data,
      uniqueConstraints,
    ),
  );
  if (!uniquenessResult.ok) {
    return { status: "error", error: uniquenessResult.error };
  }

  await backend.insertNode({
    graphId,
    kind: node.kind,
    id: node.id,
    props: propsResult.data,
    ...(node.validFrom !== undefined && { validFrom: node.validFrom }),
    ...(node.validTo !== undefined && { validTo: node.validTo }),
  });
  await applyNodeInsertSideEffects(
    writeContext,
    {
      kind: node.kind,
      id: node.id,
      schema: registration.type.schema,
      props: propsResult.data,
      uniqueConstraints,
    },
    backend,
  );

  return { status: "created" };
}

// ============================================================
// Edge Processing
// ============================================================

async function processEdges(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  registry: KindRegistry,
  edges: readonly InterchangeEdge[],
  edgeSchemas: ReadonlyMap<string, EdgeSchemaEntry>,
  nodeSchemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ResolvedImportOptions,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
): Promise<void> {
  const batchSize = options.batchSize;

  for (let index = 0; index < edges.length; index += batchSize) {
    const batch = edges.slice(index, index + batchSize);
    await processEdgeSlice(
      backend,
      graphId,
      registry,
      batch,
      edgeSchemas,
      nodeSchemas,
      options,
      result,
      errors,
      importedNodeIds,
    );
  }
}

function recordEdgeOutcome(
  edge: InterchangeEdge,
  outcome: ProcessResult,
  result: ImportResult,
  errors: ImportError[],
): void {
  switch (outcome.status) {
    case "created": {
      result.edges.created++;
      break;
    }
    case "updated": {
      result.edges.updated++;
      break;
    }
    case "skipped": {
      result.edges.skipped++;
      break;
    }
    case "error": {
      errors.push({
        entityType: "edge",
        kind: edge.kind,
        id: edge.id,
        error: outcome.error,
      });
      break;
    }
  }
}

type EdgeImportCandidate = Readonly<{
  edge: InterchangeEdge;
  props: Record<string, unknown>;
}>;

/**
 * Processes one batchSize slice of edges with batched round trips: one
 * `getNodes` per endpoint kind for reference liveness, one `getEdges` for
 * existence, and one multi-row insert for the accepted creates. Per-row
 * semantics are unchanged; duplicate ids within a slice defer to the
 * per-row path after the flush.
 */
async function processEdgeSlice(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  registry: KindRegistry,
  batch: readonly InterchangeEdge[],
  edgeSchemas: ReadonlyMap<string, EdgeSchemaEntry>,
  nodeSchemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ResolvedImportOptions,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
): Promise<void> {
  const record = (edge: InterchangeEdge, outcome: ProcessResult): void => {
    recordEdgeOutcome(edge, outcome, result, errors);
  };

  // Pass 1 (synchronous): kind, endpoint-kind, endpoint-assignability,
  // property, and validity validation, plus in-slice duplicate deferral.
  const candidates: EdgeImportCandidate[] = [];
  const deferred: InterchangeEdge[] = [];
  const seenIds = new Set<string>();
  for (const edge of batch) {
    const schemaEntry = edgeSchemas.get(edge.kind);
    if (!schemaEntry) {
      record(edge, {
        status: "error",
        error: `Unknown edge kind: ${edge.kind}`,
      });
      continue;
    }
    if (!nodeSchemas.has(edge.from.kind)) {
      record(edge, {
        status: "error",
        error: `Unknown from node kind: ${edge.from.kind}`,
      });
      continue;
    }
    if (!nodeSchemas.has(edge.to.kind)) {
      record(edge, {
        status: "error",
        error: `Unknown to node kind: ${edge.to.kind}`,
      });
      continue;
    }
    const endpointError = validateEdgeEndpoints(
      edge.kind,
      edge.from.kind,
      edge.to.kind,
      schemaEntry.registration,
      registry,
    );
    if (endpointError !== undefined) {
      record(edge, { status: "error", error: endpointError.message });
      continue;
    }
    const propsResult = validateProperties(
      edge.properties,
      schemaEntry.schema,
      options.onUnknownProperty,
    );
    if (!propsResult.success) {
      record(edge, { status: "error", error: propsResult.error });
      continue;
    }
    const validityError = validateValidityWindow(edge);
    if (validityError !== undefined) {
      record(edge, { status: "error", error: validityError });
      continue;
    }
    if (seenIds.has(edge.id)) {
      deferred.push(edge);
      continue;
    }
    seenIds.add(edge.id);
    candidates.push({ edge, props: propsResult.data });
  }

  // Batch the endpoint-liveness reads: one getNodes per endpoint kind for
  // every key the import itself didn't create. Falls back to per-row
  // getNode inside the routing loop when the backend lacks getNodes.
  const liveEndpointKeys = new Set<string>();
  const checkedEndpointKeys = new Set<string>();
  if (options.validateReferences && backend.getNodes !== undefined) {
    const idsByKind = new Map<string, Set<string>>();
    for (const { edge } of candidates) {
      for (const endpoint of [edge.from, edge.to]) {
        const key = makeNodeKey(endpoint.kind, endpoint.id);
        if (importedNodeIds.has(key) || checkedEndpointKeys.has(key)) continue;
        checkedEndpointKeys.add(key);
        const ids = idsByKind.get(endpoint.kind) ?? new Set<string>();
        ids.add(endpoint.id);
        idsByKind.set(endpoint.kind, ids);
      }
    }
    for (const [kind, ids] of idsByKind) {
      const rows = await backend.getNodes(graphId, kind, [...ids]);
      for (const row of rows) {
        if (isLiveNodeRow(row)) {
          liveEndpointKeys.add(makeNodeKey(kind, row.id));
        }
      }
    }
  }

  const endpointIsLive = async (endpoint: {
    kind: string;
    id: string;
  }): Promise<boolean> => {
    const key = makeNodeKey(endpoint.kind, endpoint.id);
    if (importedNodeIds.has(key)) return true;
    if (checkedEndpointKeys.has(key)) return liveEndpointKeys.has(key);
    const row = await backend.getNode(graphId, endpoint.kind, endpoint.id);
    return row !== undefined && isLiveNodeRow(row);
  };

  // Batch the existence reads. Falls back to per-row getEdge when the
  // backend lacks getEdges.
  const existingById = new Map<
    string,
    Awaited<ReturnType<GraphBackend["getEdge"]>>
  >();
  if (candidates.length > 0 && backend.getEdges !== undefined) {
    const rows = await backend.getEdges(
      graphId,
      candidates.map((candidate) => candidate.edge.id),
    );
    for (const row of rows) {
      existingById.set(row.id, row);
    }
    for (const { edge } of candidates) {
      if (!existingById.has(edge.id)) existingById.set(edge.id, undefined);
    }
  }

  const accepted: EdgeImportCandidate[] = [];
  for (const candidate of candidates) {
    const { edge, props } = candidate;

    if (options.validateReferences) {
      if (!(await endpointIsLive(edge.from))) {
        record(edge, {
          status: "error",
          error: `From node not found: ${edge.from.kind}:${edge.from.id}`,
        });
        continue;
      }
      if (!(await endpointIsLive(edge.to))) {
        record(edge, {
          status: "error",
          error: `To node not found: ${edge.to.kind}:${edge.to.id}`,
        });
        continue;
      }
    }

    const existing =
      existingById.has(edge.id) ?
        existingById.get(edge.id)
      : await backend.getEdge(graphId, edge.id);

    if (existing) {
      // Prior to every strategy: a row occupying this id under a different
      // immutable identity is not this edge, and none of the three arms may
      // treat it as one.
      const identityConflict = edgeIdentityConflict(edge, existing);
      if (identityConflict !== undefined) {
        record(edge, { status: "error", error: identityConflict });
        continue;
      }
      switch (options.onConflict) {
        case "skip": {
          record(edge, {
            status: "skipped",
            liveTarget: existing.deleted_at === undefined,
          });
          break;
        }
        case "error": {
          record(edge, {
            status: "error",
            error: `Edge already exists: ${edge.id}`,
          });
          break;
        }
        case "update": {
          if (existing.deleted_at !== undefined) {
            record(edge, { status: "skipped", liveTarget: false });
            break;
          }
          const updateWindow = validateUpdateValidityWindow(
            edge,
            existing.valid_from,
          );
          if (!updateWindow.ok) {
            record(edge, { status: "error", error: updateWindow.error });
            break;
          }
          const updateError = await updateImportedEdge(
            backend,
            graphId,
            edge,
            props,
            updateWindow.value,
          );
          if (updateError !== undefined) {
            record(edge, { status: "error", error: updateError });
            break;
          }
          record(edge, { status: "updated" });
          break;
        }
      }
      continue;
    }

    accepted.push(candidate);
  }

  if (accepted.length > 0) {
    const insertParamsList = accepted.map(({ edge, props }) => ({
      graphId,
      id: edge.id,
      kind: edge.kind,
      fromKind: edge.from.kind,
      fromId: edge.from.id,
      toKind: edge.to.kind,
      toId: edge.to.id,
      props,
      ...(edge.validFrom !== undefined && { validFrom: edge.validFrom }),
      ...(edge.validTo !== undefined && { validTo: edge.validTo }),
    }));
    if (backend.insertEdgesBatch === undefined) {
      for (const params of insertParamsList) {
        await backend.insertEdge(params);
      }
    } else {
      await backend.insertEdgesBatch(insertParamsList);
    }
    for (const candidate of accepted) {
      record(candidate.edge, { status: "created" });
    }
  }

  for (const edge of deferred) {
    record(
      edge,
      await processEdge(
        backend,
        graphId,
        registry,
        edge,
        edgeSchemas,
        nodeSchemas,
        options,
        importedNodeIds,
      ),
    );
  }
}

async function processEdge(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  registry: KindRegistry,
  edge: InterchangeEdge,
  edgeSchemas: ReadonlyMap<string, EdgeSchemaEntry>,
  nodeSchemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ResolvedImportOptions,
  importedNodeIds: Set<string>,
): Promise<ProcessResult> {
  // Validate edge kind exists
  const schemaEntry = edgeSchemas.get(edge.kind);
  if (!schemaEntry) {
    return { status: "error", error: `Unknown edge kind: ${edge.kind}` };
  }

  // Validate endpoint kinds exist
  if (!nodeSchemas.has(edge.from.kind)) {
    return {
      status: "error",
      error: `Unknown from node kind: ${edge.from.kind}`,
    };
  }
  if (!nodeSchemas.has(edge.to.kind)) {
    return { status: "error", error: `Unknown to node kind: ${edge.to.kind}` };
  }

  // Validate endpoint kinds are allowed for this edge type. Uses the shared,
  // subclass-aware check (registry.isAssignableTo) that the collection API uses,
  // so an edge whose endpoint is a subclass of a declared kind — legal in the
  // store and emitted verbatim by export — imports cleanly instead of being
  // rejected by an exact-kind comparison.
  const endpointError = validateEdgeEndpoints(
    edge.kind,
    edge.from.kind,
    edge.to.kind,
    schemaEntry.registration,
    registry,
  );
  if (endpointError !== undefined) {
    return { status: "error", error: endpointError.message };
  }

  // Validate references exist (in DB or in import batch)
  if (options.validateReferences) {
    const fromKey = makeNodeKey(edge.from.kind, edge.from.id);
    const toKey = makeNodeKey(edge.to.kind, edge.to.id);

    // Check import batch first, then DB. The DB row must be LIVE: getNode
    // returns tombstones, and inserting an edge whose endpoint is
    // soft-deleted would bypass the endpoint-liveness invariant the
    // collection API enforces.
    if (!importedNodeIds.has(fromKey)) {
      const fromExists = await backend.getNode(
        graphId,
        edge.from.kind,
        edge.from.id,
      );
      if (fromExists === undefined || !isLiveNodeRow(fromExists)) {
        return {
          status: "error",
          error: `From node not found: ${edge.from.kind}:${edge.from.id}`,
        };
      }
    }

    if (!importedNodeIds.has(toKey)) {
      const toExists = await backend.getNode(graphId, edge.to.kind, edge.to.id);
      if (toExists === undefined || !isLiveNodeRow(toExists)) {
        return {
          status: "error",
          error: `To node not found: ${edge.to.kind}:${edge.to.id}`,
        };
      }
    }
  }

  // Validate and transform properties
  const propsResult = validateProperties(
    edge.properties,
    schemaEntry.schema,
    options.onUnknownProperty,
  );

  if (!propsResult.success) {
    return { status: "error", error: propsResult.error };
  }

  const validityError = validateValidityWindow(edge);
  if (validityError !== undefined) {
    return { status: "error", error: validityError };
  }

  // Check if edge already exists
  const existing = await backend.getEdge(graphId, edge.id);

  if (existing) {
    // Same prior question as the batched path, answered by the same owner.
    const identityConflict = edgeIdentityConflict(edge, existing);
    if (identityConflict !== undefined) {
      return { status: "error", error: identityConflict };
    }
    switch (options.onConflict) {
      case "skip": {
        return {
          status: "skipped",
          liveTarget: existing.deleted_at === undefined,
        };
      }
      case "error": {
        return { status: "error", error: `Edge already exists: ${edge.id}` };
      }
      case "update": {
        // Same contract as nodes: import never resurrects a tombstone, and
        // the backend's update targets live rows only.
        if (existing.deleted_at !== undefined) {
          return { status: "skipped", liveTarget: false };
        }
        const updateWindow = validateUpdateValidityWindow(
          edge,
          existing.valid_from,
        );
        if (!updateWindow.ok) {
          return { status: "error", error: updateWindow.error };
        }
        const updateError = await updateImportedEdge(
          backend,
          graphId,
          edge,
          propsResult.data,
          updateWindow.value,
        );
        if (updateError !== undefined) {
          return { status: "error", error: updateError };
        }
        return { status: "updated" };
      }
    }
  }

  // Create new edge
  await backend.insertEdge({
    graphId,
    id: edge.id,
    kind: edge.kind,
    fromKind: edge.from.kind,
    fromId: edge.from.id,
    toKind: edge.to.kind,
    toId: edge.to.id,
    props: propsResult.data,
    ...(edge.validFrom !== undefined && { validFrom: edge.validFrom }),
    ...(edge.validTo !== undefined && { validTo: edge.validTo }),
  });

  return { status: "created" };
}

// ============================================================
// Property Validation
// ============================================================

type ValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string };

function validateProperties(
  properties: Record<string, unknown>,
  schema: z.ZodObject<z.ZodRawShape>,
  unknownStrategy: UnknownPropertyStrategy,
): ValidationResult {
  try {
    // Get the schema's known keys
    const knownKeys = new Set(Object.keys(schema.shape));

    // Check for unknown properties
    const unknownKeys = Object.keys(properties).filter(
      (key) => !knownKeys.has(key),
    );

    if (unknownKeys.length > 0) {
      switch (unknownStrategy) {
        case "error": {
          return {
            success: false,
            error: `Unknown properties: ${unknownKeys.join(", ")}`,
          };
        }
        case "strip": {
          // Remove unknown properties
          // Data-keyed: `knownKeys` are schema-declared property names.
          const stripped = createDataKeyedBag<unknown>();
          for (const key of knownKeys) {
            if (hasOwnKey(properties, key)) {
              stripped[key] = properties[key];
            }
          }
          // Validate stripped properties
          const result = schema.safeParse(stripped);
          if (!result.success) {
            return {
              success: false,
              error: formatZodError(result.error),
            };
          }
          return {
            success: true,
            data: result.data,
          };
        }
        case "allow": {
          // Validate the known fields, then return the ORIGINAL properties
          // verbatim — unknown keys preserved, known values byte-for-byte.
          // Exported data already carries post-transform values, so
          // re-applying schema transforms here would corrupt every
          // export→import round trip whose transforms are not idempotent.
          // "allow" is the fidelity-preserving strategy; "strip" (and the
          // create path) remain the normalizing ones.
          const result = schema.safeParse(properties);
          if (!result.success) {
            return {
              success: false,
              error: formatZodError(result.error),
            };
          }
          return { success: true, data: properties };
        }
      }
    }

    // No unknown properties - standard validation
    const result = schema.safeParse(properties);
    if (!result.success) {
      return { success: false, error: formatZodError(result.error) };
    }

    return { success: true, data: result.data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Validation error: ${message}` };
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

// ============================================================
// Helpers
// ============================================================

function makeNodeKey(kind: string, id: string): string {
  return encodeTupleKey([kind, id]);
}
