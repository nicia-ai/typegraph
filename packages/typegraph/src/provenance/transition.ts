import {
  isLiveNodeRow,
  isTombstonedNodeRow,
  type LiveNodeRow,
  type NodeRow,
  type TransactionOptions,
} from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import { ConfigurationError, NodeNotFoundError } from "../errors";
import {
  enterTransactionOperation,
  type Operation,
} from "../store/operation-scope";
import { cascadeDeletionOrder } from "../store/operations/composition-cascade";
import { type NodeDeletePolicy } from "../store/operations/node-write-pipeline";
import {
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
import { runInProvenanceSection } from "./section";
import {
  availableSourceKeys,
  compositionDepthRounds,
  type CompositionExistenceDependencies,
  computeSupportSnapshot,
  type SourceRetractedState,
  sourceRetractedState,
  type SupportSnapshot,
} from "./support";
import { loadSupportGraph, readCurrentSourceRows } from "./support-read";
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
  for (const [key, row] of snapshot.currencyRows) {
    if (!affected.has(key)) continue;
    if (!isTargetKey(key)) continue;
    if (!isTargetRow(row)) continue;
    rows.set(key, row);
  }
  return rows;
}

/**
 * THE set of facts this transition closes: affected by it, not standing in the
 * post-transition snapshot (unsupported, or a required part outside its window
 * whose whole falls), and still a live row — live by the composition liveness
 * rule ({@link isLiveNodeRow}), whatever the row's validity window.
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
    (key) => !snapshot.standingKeys.has(key),
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
 * support-dependent on its whole, so they arrive here as facts of their own —
 * a required part outside its validity window as a row that stands while its
 * whole does (`partsOutsideWindow`, `./support.ts`) — and an optional part
 * is left alone.
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
 *
 * Every required part closes before its whole — at any depth, across fact
 * kinds — in the composition cascade's own leaf-first order
 * ({@link cascadeDeletionOrder}), never in configured fact-kind order: the
 * verb takes no savepoint, so a caller that catches a failure between two
 * closes and commits keeps the first, and a closed whole above a still-live
 * required part is a `compositionExistence` violation.
 */
async function closeFacts<G extends GraphDef>(
  tx: TransactionContext<G>,
  dependencies: CompositionExistenceDependencies,
  closing: ReadonlyMap<string, LiveNodeRow>,
): Promise<void> {
  const partsFirst = cascadeDeletionOrder(
    compositionDepthRounds(dependencies, closing),
  );
  for (const row of partsFirst) {
    await transactionDeleteNodeWithPolicy(
      tx,
      { kind: row.kind, id: row.id },
      FACT_CURRENCY_CLOSE_POLICY,
    );
  }
}

/**
 * The reopen candidates without every required part whose fact whole stays
 * closed after this pass: a whole that is a tombstoned fact row and is not
 * itself reopened here, at any depth up the part's chain.
 *
 * Support judges a required part by its fact whole's SUPPORT, not its row, so
 * a whole can be supported and still closed: a caller that caught a failure
 * between a verb's source flip and the whole's reopen, and committed, keeps
 * exactly that prefix. A later transition that reaches only the part (through
 * a source of the part's own) must not reopen it there, or a required part
 * goes live under a closed whole. The part stays closed, its support standing,
 * until a transition reopens the whole, which reopens the part with it.
 * A whole that is not a fact is judged live by support itself.
 */
function withoutPartsOfClosedWholes<T extends NodeRow>(
  snapshot: SupportSnapshot,
  dependencies: CompositionExistenceDependencies,
  reopening: ReadonlyMap<string, T>,
): ReadonlyMap<string, T> {
  const wholeOpens = (partKey: string, visited: Set<string>): boolean => {
    if (!dependencies.requiredPartFactKeys.has(partKey)) return true;
    const wholeKey = dependencies.wholeKeyByPartKey.get(partKey);
    if (wholeKey === undefined || visited.has(wholeKey)) return true;
    const whole = snapshot.currencyRows.get(wholeKey);
    if (whole === undefined || isLiveNodeRow(whole)) return true;
    visited.add(wholeKey);
    return reopening.has(wholeKey) && wholeOpens(wholeKey, visited);
  };
  const kept = new Map<string, T>();
  for (const [key, row] of reopening) {
    if (wholeOpens(key, new Set([key]))) kept.set(key, row);
  }
  return kept;
}

/**
 * The reopen half ({@link closeFacts} states what both halves share): revives
 * every affected fact that is supported in the post-transition snapshot and
 * still tombstoned. It runs after the close pass, because a reopen re-checks
 * uniqueness and the unique key it needs may still be held by a fact this
 * same transition closes — closing first makes a legal transition
 * order-independent.
 *
 * Every whole reopens before its required parts: the exact reverse of the
 * close pass's leaf-first order, so a caught failure between two reopens
 * leaves a part closed under a live whole, never live under a closed one.
 * For the same reason a required part whose whole stays closed after this
 * pass is not reopened at all ({@link withoutPartsOfClosedWholes}).
 */
async function reopenFacts<G extends GraphDef>(
  tx: TransactionContext<G>,
  dependencies: CompositionExistenceDependencies,
  snapshot: SupportSnapshot,
  affected: ReadonlySet<string>,
): Promise<void> {
  const reopening = withoutPartsOfClosedWholes(
    snapshot,
    dependencies,
    selectAffectedFactRows(
      snapshot,
      affected,
      (key) => snapshot.standingKeys.has(key),
      isTombstonedNodeRow,
    ),
  );
  const wholesFirst = cascadeDeletionOrder(
    compositionDepthRounds(dependencies, reopening),
  ).toReversed();
  for (const row of wholesFirst) {
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

/**
 * Runs one transition on `tx` as the exclusive holder of its graph's
 * provenance section on that native transaction (`runInProvenanceSection`,
 * `./section.ts`). A transition decides its writes from one support read;
 * another transition on the same transaction is not excluded by the graph
 * lock this one holds, so two that overlapped would each decide from a read
 * that predates the other's writes (two retractions of a fact's two sources
 * would each keep it live on the other's support). An overlapping verb,
 * `holding(tx)` or `assertHolds(tx)` is refused before any statement.
 *
 * The refusal holds only where the sessions share their native transaction's
 * state, which is only on proof (`session.native`): two adoptions of one
 * caller-begun transaction on a connection-level handle (better-sqlite3)
 * each get a state of their own and are not refused. The transition is
 * therefore also correct without the refusal: it re-reads the availability
 * it decided from after its writes and reconciles a change
 * ({@link transitionInExclusiveSection}).
 */
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
  // The transition's own reads go through one operation of the session the
  // context carries: the session `store.transaction` opened for the
  // own-transaction form, the caller's for the caller-transaction form. The
  // writes it makes through `tx` enter their own operations of that session.
  return runInProvenanceSection(
    tx,
    { graphId: scope.graphId, operation, mode: "exclusive" },
    () =>
      transitionInExclusiveSection<G, FactKind, JustificationKind>(
        scope,
        tx,
        enterTransactionOperation(tx),
        uniqueSources,
        retracted,
        operation,
      ),
  );
}

/**
 * Runs the transition, then makes sure the availability it decided from is
 * still the transaction's. A verb on another session of the same native
 * transaction that shares no state with this one (an unproven adoption, see
 * {@link transitionInTransaction}) can flip a source flag between this
 * transition's support read and its writes, and this transition then decided
 * from a stale view: retracting a fact's two sources at once would each keep
 * the fact live on the support the other removes.
 *
 * The database decides it, not a lock: after its own writes the transition
 * re-reads every source flag (`readCurrentSourceRows`) on the same
 * transaction, which sees every write made on it so far. When the
 * availability differs from the one it decided, it runs a reconcile pass,
 * which is the verb re-run with nothing left to flip: a fresh support read,
 * then the closes and reopens that bring every fact reachable from its
 * sources in line with the current flags. Of two overlapping transitions,
 * the later re-read follows both flag writes (each transition writes its
 * flags before it re-reads), so at least that one reconciles, and every fact
 * whose support depends on both is reachable from both. A reconcile pass
 * writes no flag, so each further pass answers a flag written by another
 * verb since the previous read, and the loop ends once they stop.
 */
async function transitionInExclusiveSection<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
>(
  scope: CapabilityScope,
  tx: TransactionContext<G>,
  transitionOperation: Operation,
  uniqueSources: readonly ProvenanceNodeRef[],
  retracted: boolean,
  operation: string,
): Promise<RetractionReport<G, FactKind, JustificationKind>> {
  const { config } = scope;
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
  const { backend } = transitionOperation;
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
  const nextState: SourceRetractedState = retracted ? "retracted" : "available";
  const flipping = sourceRows.filter(
    ({ row }) => sourceRetractedState(row, config.retractedField) !== nextState,
  );

  let pass = await runTransitionPass<G, FactKind, JustificationKind>(
    scope,
    tx,
    backend,
    uniqueSources,
    { flipping, retracted },
  );
  let report = pass.report;
  for (;;) {
    const current = availableSourceKeys(
      await readCurrentSourceRows(backend, scope.graphId, config),
      config.retractedField,
    );
    if (sameKeys(current, pass.decidedAvailability)) return report;
    pass = await runTransitionPass<G, FactKind, JustificationKind>(
      scope,
      tx,
      backend,
      uniqueSources,
      { flipping: [], retracted },
    );
    report = reconciledReport(report, pass.report);
  }
}

/** One pass's report and the source availability it decided its writes on. */
type TransitionPass<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
> = Readonly<{
  report: RetractionReport<G, FactKind, JustificationKind>;
  decidedAvailability: ReadonlySet<string>;
}>;

function sameKeys(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

/**
 * The report of a transition that reconciled: every fact any of its passes
 * closed, the support standing after the last pass, and the facts the first
 * pass found believed and out of its reach (every pass reaches the same
 * facts: the graph's structure is the same, only flags moved).
 */
function reconciledReport<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
>(
  earlier: RetractionReport<G, FactKind, JustificationKind>,
  reconcile: RetractionReport<G, FactKind, JustificationKind>,
): RetractionReport<G, FactKind, JustificationKind> {
  const died = new Map(
    [...earlier.died, ...reconcile.died].map((fact) => [refKey(fact), fact]),
  );
  return {
    died: [...died.entries()]
      .toSorted(([left], [right]) => compareStrings(left, right))
      .map(([, fact]) => fact),
    survivedVia: reconcile.survivedVia,
    unaffected: earlier.unaffected,
  };
}

/**
 * One decide-then-write pass of a transition: one support read, then the
 * closes, `flipping`'s flag writes and the reopens it decides from that
 * read. A reconcile pass flips nothing.
 */
async function runTransitionPass<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
>(
  scope: CapabilityScope,
  tx: TransactionContext<G>,
  backend: Operation["backend"],
  uniqueSources: readonly ProvenanceNodeRef[],
  writes: Readonly<{ flipping: readonly SourceRow[]; retracted: boolean }>,
): Promise<TransitionPass<G, FactKind, JustificationKind>> {
  const { config } = scope;
  const { flipping, retracted } = writes;
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

  // Decide the whole pass from the one read before writing anything: the
  // availability the flips leave, and the facts whose currency changes with
  // it.
  // The flips stand in for the stored flags of the same validity-filtered
  // rows the before availability read, so a flipped source outside its
  // window stays available to nothing.
  const nextState: SourceRetractedState = retracted ? "retracted" : "available";
  const availableAfter = availableSourceKeys(
    supportGraph.sourceRows,
    config.retractedField,
    new Map(flipping.map(({ source }) => [refKey(source), nextState])),
  );
  const after = computeSupportSnapshot(supportGraph, availableAfter);
  const affected = after.affectedFactKeys(uniqueSources, before.standingKeys);
  const closing = closingFactRows(after, affected);

  // Write in the one order whose every prefix leaves no fact live without
  // live support, because the verb takes no savepoint (a TypeGraph-owned one's
  // rollback would undo overlapping calls' writes): a caller that catches a
  // failure partway and commits keeps the prefix. The facts that lose their
  // support close first, while their sources still stand; then the source
  // flags flip — any subset of the flips leaves a fact at least as supported
  // as all of them do, so a fact a retraction leaves without support is
  // already closed, and a restoration only adds support to facts still
  // closed; then the facts that regain support reopen. Within the close pass
  // every required part closes before its whole, and within the reopen pass
  // every whole reopens before its parts. A prefix can leave a fact closed
  // whose support stands, never one live without it nor a required part live
  // under a closed whole, and re-running the verb completes the transition.
  const dependencies = supportGraph.compositionDependencies;
  await closeFacts(tx, dependencies, closing);
  for (const { source } of flipping) {
    await setSourceRetractionState(tx, config, source, retracted);
  }
  await reopenFacts(tx, dependencies, after, affected);
  return {
    report: buildReport<G, FactKind, JustificationKind>(
      before,
      after,
      affected,
      closing,
    ),
    decidedAvailability: availableAfter,
  };
}
