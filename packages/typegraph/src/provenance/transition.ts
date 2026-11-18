import type { BATCH_POINT_READ } from "../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../backend/capabilities/resolve";
import {
  isLiveNodeRow,
  isTombstonedNodeRow,
  type LiveNodeRow,
  type NodeRow,
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
 * Brings fact currency in line with the post-transition support snapshot —
 * but only for the facts the transition could have affected (those reachable
 * from the flipped sources through justification edges). Facts outside that
 * set are never touched: an unsupported live fact elsewhere in the graph
 * (e.g. one whose justification edges have not been linked yet) is not this
 * transition's business, and silently tombstoning it would be invisible data
 * loss the report cannot even mention.
 *
 * Closes run before reopens: a reopen re-checks uniqueness, and the unique
 * key it needs may still be held by a fact this same transition is about to
 * close — closing first makes a legal transition order-independent.
 *
 * Which rows the close pass writes is NOT decided here: the caller resolves
 * them once through {@link closingFactRows} and hands the same map to the
 * report, so every tombstone this pass writes is named in `died`.
 *
 * Both passes go through the transaction's own node operations — the one
 * in-frame delete and revive owners — so each fact takes exactly the steps
 * any node delete or revival owes (uniqueness, embeddings, fulltext, identity
 * detach on close and restore on reopen) under the transaction's buffered
 * hook runner, which defers every success hook until the transition's COMMIT.
 * One fact at a time: the writes share the transaction's one connection.
 */
async function synchronizeFactCurrency<G extends GraphDef>(
  tx: TransactionContext<G>,
  snapshot: SupportSnapshot,
  affected: ReadonlySet<string>,
  closing: ReadonlyMap<string, LiveNodeRow>,
): Promise<void> {
  // The rows the caller already resolved through `closingFactRows`, so the
  // pass that writes and the report that names them cannot disagree.
  for (const row of closing.values()) {
    await transactionDeleteNodeWithPolicy(
      tx,
      { kind: row.kind, id: row.id },
      FACT_CURRENCY_CLOSE_POLICY,
    );
  }
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

export async function runTransition<
  G extends GraphDef,
  SourceKind extends NodeKind<G>,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
>(
  store: HistoryStore<G>,
  config: NormalizedConfig,
  sources: readonly ProvenanceSourceInput<G, SourceKind>[],
  retracted: boolean,
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>,
): Promise<RetractionReport<G, FactKind, JustificationKind>> {
  const uniqueSources = uniqueNodeReferences(sources);
  for (const source of uniqueSources) {
    if (config.sourceKinds.includes(source.kind)) continue;
    throw new ConfigurationError(
      `Provenance retraction source must be one of: ${config.sourceKinds.join(", ")}.`,
      { expectedKinds: config.sourceKinds, actualKind: source.kind },
    );
  }

  return store.transaction(async (tx) => {
    const backend = transactionBackend(tx);
    // Serialize the whole read-compute-write transition per graph BEFORE the
    // first read. `store.transaction` itself takes no lock (write operations
    // acquire it at their own boundaries), but a transition's support
    // snapshot must not race a concurrent transition or history write, so
    // the capability's write locks are acquired explicitly up front.
    await acquireCapabilityWriteLocks(tx, "provenance retraction transition");
    const rows = await Promise.all(
      uniqueSources.map((source) =>
        backend.getNode(store.graphId, source.kind, source.id),
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
      store.registry,
      store.graphId,
      config,
      batchPointRead,
    );
    const availableBefore = availableSourceKeys(
      supportGraph.sourceRows,
      config.retractedField,
    );
    const before = computeSupportSnapshot(supportGraph, availableBefore);

    const nextState: SourceRetractedState =
      retracted ? "retracted" : "available";
    const availableAfter = new Set(availableBefore);
    for (const { source, row } of sourceRows) {
      const currentState = sourceRetractedState(row, config.retractedField);
      if (currentState === nextState) continue;
      await setSourceRetractionState(tx, config, source, retracted);
      // Mirror the flip in the in-memory availability so `after` matches the
      // source rows now persisted, without re-reading the whole graph.
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
    await synchronizeFactCurrency(tx, after, affected, closing);
    return buildReport<G, FactKind, JustificationKind>(
      before,
      after,
      affected,
      closing,
    );
  });
}
