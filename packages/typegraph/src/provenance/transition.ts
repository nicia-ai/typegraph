import {
  isLiveNodeRow,
  isTombstonedNodeRow,
  type LiveNodeRow,
  type NodeRow,
  type TransactionOptions,
} from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import { ConfigurationError, NodeNotFoundError } from "../errors";
import { type NodeDeletePolicy } from "../store/operations/node-write-pipeline";
import {
  transactionBackend,
  transactionDeleteNodeWithPolicy,
  transactionReviveNode,
} from "../store/runtime-port";
import type { HistoryStore } from "../store/store";
import {
  type DynamicNodeCollection,
  type TransactionContext,
} from "../store/types";
import { compareStrings } from "../utils/compare";
import { type NormalizedConfig } from "./config";
import {
  keyToRef,
  refKey,
  sortedReferences,
  uniqueNodeReferences,
} from "./keys";
import { acquireCapabilityWriteLocks } from "./locks";
import { type CapabilityScope, type TransactionScopeResolver } from "./scope";
import {
  availableSourceKeys,
  computeSupportSnapshot,
  type SourceRetractedState,
  sourceRetractedState,
  type SupportSnapshot,
} from "./support";
import { loadSupportGraph } from "./support-read";
import {
  type NodeKind,
  type ProvenanceNodeRef,
  type ProvenanceSourceInput,
  type RetractionReport,
} from "./types";

type SourceRow = Readonly<{
  source: ProvenanceNodeRef;
  row: NodeRow;
}>;

function buildReport<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
>(
  before: SupportSnapshot,
  after: SupportSnapshot,
  affected: ReadonlySet<string>,
  closing: ReadonlyMap<string, LiveNodeRow>,
): RetractionReport<G, FactKind, JustificationKind> {
  const believedBefore = [...before.believedFactKeys];
  // Every fact the transition closes, which is what `closing` IS — not a
  // re-derivation over what was believed beforehand. A fact that was already
  // unsupported when this transition reached it still loses its currency here,
  // so it is named here.
  const died = sortedReferences<G, FactKind>(closing.keys());
  const unaffected = sortedReferences<G, FactKind>(
    believedBefore.filter((key) => !affected.has(key)),
  );
  const survivedVia = [...affected]
    .filter((key) => after.supportedFactKeys.has(key))
    .toSorted((left, right) => compareStrings(left, right))
    .map((key) => ({
      fact: keyToRef<G, FactKind>(key),
      via: sortedReferences<G, JustificationKind>(
        after.firingJustificationKeysByFact.get(key) ?? [],
      ),
    }));
  return { died, survivedVia, unaffected };
}

/** The affected fact rows matching both predicates, keyed by fact. */
function selectAffectedFactRows<T extends NodeRow>(
  snapshot: SupportSnapshot,
  affected: ReadonlySet<string>,
  isTargetKey: (key: string) => boolean,
  isTargetRow: (row: NodeRow) => row is T,
): ReadonlyMap<string, T> {
  const rows = new Map<string, T>();
  for (const [key, row] of snapshot.facts) {
    if (!affected.has(key)) continue;
    if (!isTargetKey(key)) continue;
    if (!isTargetRow(row)) continue;
    rows.set(key, row);
  }
  return rows;
}

/**
 * THE set of facts this transition closes: affected by it, unsupported in the
 * post-transition snapshot, and still a live row.
 *
 * Computed ONCE per transition and handed to both consumers — the close pass
 * that tombstones these rows and the report that names them in `died` — rather
 * than spelled twice. A report that re-derived its own answer (previously
 * "believed before and unsupported after") could omit a row the close pass
 * tombstones: a fact found live but ALREADY unsupported when the transition
 * reaches it is closed, and an unnamed close is invisible data loss.
 */
function closingFactRows(
  snapshot: SupportSnapshot,
  affected: ReadonlySet<string>,
): ReadonlyMap<string, LiveNodeRow> {
  return selectAffectedFactRows(
    snapshot,
    affected,
    (key) => !snapshot.supportedFactKeys.has(key),
    isLiveNodeRow,
  );
}

/**
 * A belief-status close: the canonical soft delete WITHOUT delete-behavior
 * enforcement or composition cascade. Closing a fact's currency is not a
 * domain delete, so its connected edges neither block the close (`restrict`)
 * nor get removed (`cascade` / `disconnect`) — every edge survives untouched,
 * so a later reopen restores the same neighbourhood. No part is cascaded
 * either: the REQUIRED parts of a closed whole are closed by this same
 * transition instead, because the support computation makes a required part
 * support-dependent on its whole, so they arrive here as facts of their own,
 * and an optional part is left alone.
 */
const FACT_CURRENCY_CLOSE_POLICY: NodeDeletePolicy = {
  enforceDeleteBehavior: false,
  cascadeComposition: false,
};

/**
 * The close half of bringing fact currency in line with the post-transition
 * support snapshot: tombstones exactly the rows the caller resolved once
 * through {@link closingFactRows} and hands the report too, so every tombstone
 * written here is named in `died`. Only facts the transition could have
 * affected (those reachable from the flipped sources through justification
 * edges) are ever touched: an unsupported live fact elsewhere in the graph
 * (e.g. one whose justification edges have not been linked yet) is not this
 * transition's business, and silently tombstoning it would be invisible data
 * loss the report cannot even mention.
 *
 * Both halves go through the transaction's own node operations — the one
 * in-frame delete and revive owners — so each fact takes exactly the steps
 * any node delete or revival owes (uniqueness, embeddings, fulltext, identity
 * detach on close and restore on reopen) under the transaction's buffered
 * hook runner, which defers every success hook until the transaction commits —
 * the transaction's own, or the caller's when it runs on one.
 * One fact at a time: the writes share the transaction's one connection.
 */
async function closeFacts<G extends GraphDef>(
  tx: TransactionContext<G>,
  closing: ReadonlyMap<string, LiveNodeRow>,
): Promise<void> {
  for (const row of closing.values()) {
    await transactionDeleteNodeWithPolicy(
      tx,
      { kind: row.kind, id: row.id },
      FACT_CURRENCY_CLOSE_POLICY,
    );
  }
}

/**
 * The reopen half ({@link closeFacts} states what both halves share): revives
 * every affected fact that is supported in the post-transition snapshot and
 * still tombstoned. It runs after the close pass, because a reopen re-checks
 * uniqueness and the unique key it needs may still be held by a fact this
 * same transition closes — closing first makes a legal transition
 * order-independent.
 */
async function reopenFacts<G extends GraphDef>(
  tx: TransactionContext<G>,
  snapshot: SupportSnapshot,
  affected: ReadonlySet<string>,
): Promise<void> {
  const reopening = selectAffectedFactRows(
    snapshot,
    affected,
    (key) => snapshot.supportedFactKeys.has(key),
    isTombstonedNodeRow,
  );
  for (const row of reopening.values()) {
    await transactionReviveNode(tx, { kind: row.kind, id: row.id });
  }
}

function getTransactionNodeCollection<G extends GraphDef>(
  tx: TransactionContext<G>,
  kind: string,
): DynamicNodeCollection {
  const collection = tx.getNodeCollection(kind);
  if (collection !== undefined) return collection;
  throw new ConfigurationError(
    `Provenance source kind "${kind}" is not available on this transaction.`,
    { kind },
  );
}

async function setSourceRetractionState<G extends GraphDef>(
  tx: TransactionContext<G>,
  config: NormalizedConfig,
  source: ProvenanceNodeRef,
  retracted: boolean,
): Promise<void> {
  const collection = getTransactionNodeCollection(tx, source.kind);
  await collection.update(source.id, { [config.retractedField]: retracted });
}

/**
 * What one retraction verb asks for: the sources to flip, the state to flip
 * them to, and the transaction to run in — `undefined` for one the transition
 * opens and commits itself — with the operation name a refusal on the
 * caller's transaction reports.
 */
export type TransitionRequest<
  G extends GraphDef,
  SourceKind extends NodeKind<G>,
> = Readonly<{
  sources: readonly ProvenanceSourceInput<G, SourceKind>[];
  retracted: boolean;
  tx: TransactionContext<G> | undefined;
  operation: string;
}>;

/** What the write-lock refusal names when the transition owns its transaction. */
const OWN_TRANSACTION_OPERATION = "provenance retraction transition";

/**
 * The isolation a transition opens its own transaction at. The support reads
 * must observe every transition committed before this one took the graph
 * lock, and only an isolation that takes a fresh snapshot per statement does:
 * asked for explicitly, so a server or role default of repeatable read or
 * serializable cannot leave the transition reading a snapshot older than the
 * lock. The write locks still verify the isolation the lock statement
 * observed, so a wrapper that drops this option is refused, not trusted.
 * SQLite ignores the option; its single writer needs none.
 */
const OWN_TRANSACTION_OPTIONS = {
  isolationLevel: "read_committed",
} as const satisfies TransactionOptions;

function assertSourceKinds(
  config: NormalizedConfig,
  sources: readonly ProvenanceNodeRef[],
): void {
  for (const source of sources) {
    if (config.sourceKinds.includes(source.kind)) continue;
    throw new ConfigurationError(
      `Provenance retraction source must be one of: ${config.sourceKinds.join(", ")}.`,
      { expectedKinds: config.sourceKinds, actualKind: source.kind },
    );
  }
}

/**
 * Runs one retraction transition, in a transaction of its own or in the
 * caller's.
 *
 * With no `tx` it opens a transaction on `store` and commits it. With a `tx`
 * the transaction is first resolved through `resolveScope`, the one owner of
 * the decision every caller-transaction entry point of the capability makes
 * (another store's or graph's transaction, or one kept past its callback, is
 * refused before any statement), and the transition runs on it without
 * committing or rolling back: its writes are the caller's, under the caller's
 * buffered hooks, receipt and recorded revision, and the caller's commit or
 * rollback decides them.
 *
 * The refusals that need no read come first either way — the transaction's
 * ownership, then a source of a kind outside the configured source kinds —
 * and both paths then run {@link transitionInTransaction}, so the locks,
 * reads, writes and report are one implementation.
 */
export async function runTransition<
  G extends GraphDef,
  SourceKind extends NodeKind<G>,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
>(
  store: HistoryStore<G>,
  storeScope: CapabilityScope,
  resolveScope: TransactionScopeResolver<G>,
  request: TransitionRequest<G, SourceKind>,
): Promise<RetractionReport<G, FactKind, JustificationKind>> {
  const uniqueSources = uniqueNodeReferences(request.sources);
  const { tx } = request;
  if (tx === undefined) {
    assertSourceKinds(storeScope.config, uniqueSources);
    return store.transaction(
      (ownTransaction) =>
        transitionInTransaction<G, FactKind, JustificationKind>(
          storeScope,
          ownTransaction,
          uniqueSources,
          request.retracted,
          OWN_TRANSACTION_OPERATION,
        ),
      OWN_TRANSACTION_OPTIONS,
    );
  }
  const scope = resolveScope(tx, request.operation);
  assertSourceKinds(scope.config, uniqueSources);
  return transitionInTransaction<G, FactKind, JustificationKind>(
    scope,
    tx,
    uniqueSources,
    request.retracted,
    request.operation,
  );
}

async function transitionInTransaction<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
>(
  scope: CapabilityScope,
  tx: TransactionContext<G>,
  uniqueSources: readonly ProvenanceNodeRef[],
  retracted: boolean,
  operation: string,
): Promise<RetractionReport<G, FactKind, JustificationKind>> {
  const { config } = scope;
  const backend = transactionBackend(tx);
  // Serialize the whole read-compute-write transition per graph BEFORE the
  // first read. A transaction takes no lock until a write needs one (write
  // operations acquire it at their own boundaries), but a transition's
  // support snapshot must not race a concurrent transition or history write,
  // so the capability's write locks — the schema-version fence, then the
  // graph write lock — are acquired explicitly up front. A read-only
  // transaction is refused there, before any statement, and a session whose
  // reads could miss a transition committed before the lock (a PostgreSQL
  // snapshot isolation) before the first read.
  await acquireCapabilityWriteLocks(tx, operation);
  const rows = await Promise.all(
    uniqueSources.map((source) =>
      backend.getNode(scope.graphId, source.kind, source.id),
    ),
  );
  const sourceRows = uniqueSources.map((source, index): SourceRow => {
    const sourceRow = rows[index];
    if (sourceRow === undefined || sourceRow.deleted_at !== undefined) {
      throw new NodeNotFoundError(source.kind, source.id);
    }
    return { source, row: sourceRow };
  });

  // Load the provenance graph once. Its structure (justifications, facts,
  // premise/derive edges) is identical before and after the transition — only
  // source availability changes — so the pre- and post-flip snapshots share
  // this read instead of scanning the whole graph twice per retraction.
  const supportGraph = await loadSupportGraph(
    backend,
    scope.registry,
    scope.graphId,
    config,
    scope.batchPointRead,
  );
  const availableBefore = availableSourceKeys(
    supportGraph.sourceRows,
    config.retractedField,
  );
  const before = computeSupportSnapshot(supportGraph, availableBefore);

  // Decide the whole transition from the one read before writing anything:
  // the sources that flip, the availability they leave, and the facts whose
  // currency changes with it.
  const nextState: SourceRetractedState = retracted ? "retracted" : "available";
  const flipping = sourceRows.filter(
    ({ row }) => sourceRetractedState(row, config.retractedField) !== nextState,
  );
  const availableAfter = new Set(availableBefore);
  for (const { source } of flipping) {
    if (nextState === "available") {
      availableAfter.add(refKey(source));
    } else {
      availableAfter.delete(refKey(source));
    }
  }
  const after = computeSupportSnapshot(supportGraph, availableAfter);
  const affected = after.affectedFactKeys(
    uniqueSources,
    before.supportedFactKeys,
  );
  const closing = closingFactRows(after, affected);

  // Write in the one order whose every prefix leaves no fact live without
  // live support, because the verb takes no savepoint (a TypeGraph-owned one's
  // rollback would undo overlapping calls' writes): a caller that catches a
  // failure partway and commits keeps the prefix. The facts that lose their
  // support close first, while their sources still stand; then the source
  // flags flip — any subset of the flips leaves a fact at least as supported
  // as all of them do, so a fact a retraction leaves without support is
  // already closed, and a restoration only adds support to facts still
  // closed; then the facts that regain support reopen. A
  // prefix can leave a fact closed whose support stands, never one live
  // without it, and re-running the verb completes the transition.
  await closeFacts(tx, closing);
  for (const { source } of flipping) {
    await setSourceRetractionState(tx, config, source, retracted);
  }
  await reopenFacts(tx, after, affected);
  return buildReport<G, FactKind, JustificationKind>(
    before,
    after,
    affected,
    closing,
  );
}
