/**
 * "Holds", in its two forms: the believed set of the whole graph
 * ({@link believedFactsInOwnTransaction},
 * {@link believedFactsInCallerTransaction}) and the commit-time assert that
 * named facts are in it ({@link assertFactsHold}). Both judge with
 * `computeSupportSnapshot`, so there is one support predicate; they differ
 * only in how much of the graph they load.
 */
import type { GraphDef } from "../core/define-graph";
import {
  ConfigurationError,
  FactNotHoldingError,
  type FactNotHoldingFailure,
  type FactNotHoldingJustification,
  type FactNotHoldingPremise,
  type FactNotHoldingReason,
} from "../errors";
import {
  enterTransactionOperation,
  type Operation,
} from "../store/operation-scope";
import { type TransactionContext } from "../store/types";
import { compareStrings } from "../utils/compare";
import { type NormalizedConfig } from "./config";
import {
  keyToRef,
  refKey,
  rowKey,
  sortedReferences,
  uniqueNodeReferences,
} from "./keys";
import {
  acquireCallerTransactionReadLocks,
  acquireCapabilityReadLock,
  acquireCapabilityWriteLocks,
} from "./locks";
import { type CapabilityScope, type TransactionScopeResolver } from "./scope";
import { runInProvenanceSection } from "./section";
import {
  appendGroupedValue,
  availableSourceKeys,
  computeSupportSnapshot,
  type SupportGraph,
  type SupportSnapshot,
} from "./support";
import { loadSupportClosure, loadSupportGraph } from "./support-read";
import {
  type NodeKind,
  type ProvenanceFactRef,
  type ProvenanceNodeRef,
  type SurvivedVia,
} from "./types";

const ASSERT_HOLDS_OPERATION = "provenance.assertHolds()";

/**
 * Every believed fact of the graph, read in a transaction the capability
 * opened for this read alone, under the per-graph write lock alone.
 */
export async function believedFactsInOwnTransaction<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
>(
  scope: CapabilityScope,
  tx: TransactionContext<G>,
): Promise<readonly ProvenanceFactRef<G, FactKind>[]> {
  const operation = enterTransactionOperation(tx);
  await acquireCapabilityReadLock(operation, scope.graphId);
  return readBelievedFacts<G, FactKind>(scope, operation);
}

/**
 * Every believed fact of the graph, read in the caller's transaction: under
 * the schema-version fence and the per-graph write lock when that transaction
 * can write, so a write after the read keeps the canonical lock order, or
 * under the graph lock alone when it is read-only. A transaction that can
 * write must also prove that its reads observe every earlier holder of the
 * graph lock, or it is refused before the first read, naming `operation`.
 *
 * The read holds the transaction's provenance section shared (`./section.ts`),
 * so it is refused before any statement while a retraction verb runs on the
 * same transaction, and a verb started while it reads is refused.
 */
export function believedFactsInCallerTransaction<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
>(
  scope: CapabilityScope,
  tx: TransactionContext<G>,
  operation: string,
): Promise<readonly ProvenanceFactRef<G, FactKind>[]> {
  return runInProvenanceSection(
    tx,
    { graphId: scope.graphId, operation, mode: "shared" },
    async (readOperation) => {
      await acquireCallerTransactionReadLocks(tx, operation);
      return readBelievedFacts<G, FactKind>(scope, readOperation);
    },
  );
}

async function readBelievedFacts<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
>(
  scope: CapabilityScope,
  operation: Operation,
): Promise<readonly ProvenanceFactRef<G, FactKind>[]> {
  const graph = await loadSupportGraph(
    operation.backend,
    scope.registry,
    scope.graphId,
    scope.config,
    scope.batchPointRead,
  );
  const snapshot = computeSupportSnapshot(
    graph,
    availableSourceKeys(graph.sourceRows, scope.config.retractedField),
  );
  return sortedReferences<G, FactKind>(snapshot.believedFactKeys);
}

/**
 * The commit-time guard behind `assertHolds`: every named fact is believed,
 * or one {@link FactNotHoldingError} names every one that is not.
 *
 * The refusals that need no read come first and take no lock: a transaction
 * the capability does not own, then a fact of a kind outside the configured
 * fact kinds. Only then are the capability's write locks taken, before the
 * first read, so the verdict cannot be invalidated by a concurrent retraction
 * and the caller's own writes take their locks in the canonical order whether
 * they come before or after this call. The judgment holds the transaction's
 * provenance section shared (`./section.ts`): a retraction verb running on
 * the same transaction refuses it before any statement, and a verb started
 * while it judges is refused, so no verb on the transaction can be between
 * its decision and its writes while the verdict is read.
 *
 * An empty list is checked for ownership only and returns `[]`: there is
 * nothing to judge, so it takes no lock, reads nothing, and is not refused in
 * a read-only transaction, whose refusal is a property of the write locks it
 * does not take.
 */
export async function assertFactsHold<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
>(
  resolveScope: TransactionScopeResolver<G>,
  tx: TransactionContext<G>,
  facts: readonly ProvenanceNodeRef[],
): Promise<readonly SurvivedVia<G, FactKind, JustificationKind>[]> {
  const scope = resolveScope(tx, ASSERT_HOLDS_OPERATION);
  const named = uniqueNodeReferences(facts);
  if (named.length === 0) return [];
  assertFactKinds(scope.config, named);

  return runInProvenanceSection(
    tx,
    {
      graphId: scope.graphId,
      operation: ASSERT_HOLDS_OPERATION,
      mode: "shared",
    },
    async (readOperation) => {
      await acquireCapabilityWriteLocks(tx, ASSERT_HOLDS_OPERATION);
      const graph = await loadSupportClosure(
        readOperation.backend,
        scope.registry,
        scope.graphId,
        scope.config,
        named,
        scope,
      );
      return judgeNamedFacts<G, FactKind, JustificationKind>(
        scope.config,
        graph,
        named,
      );
    },
  );
}

function assertFactKinds(
  config: NormalizedConfig,
  facts: readonly ProvenanceNodeRef[],
): void {
  for (const fact of facts) {
    if (config.factKinds.includes(fact.kind)) continue;
    throw new ConfigurationError(
      `Provenance assertHolds fact must be one of: ${config.factKinds.join(", ")}.`,
      { expectedKinds: config.factKinds, actualKind: fact.kind },
    );
  }
}

/**
 * Judges the named facts over a loaded support graph: each holds exactly when
 * it is in the snapshot's believed set. Returns one entry per named fact, in
 * the order given, or throws naming every fact that does not hold, sorted by
 * kind and id.
 *
 * Pure: the verdict and every failure reason are read from the one snapshot
 * and the graph it was computed over, so the two cannot disagree.
 *
 * @throws {FactNotHoldingError} when any named fact is not believed.
 */
function judgeNamedFacts<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
>(
  config: NormalizedConfig,
  graph: SupportGraph,
  facts: readonly ProvenanceNodeRef[],
): readonly SurvivedVia<G, FactKind, JustificationKind>[] {
  const available = availableSourceKeys(
    graph.sourceRows,
    config.retractedField,
  );
  const snapshot = computeSupportSnapshot(graph, available);
  const factKeys = facts.map((fact) => refKey(fact));

  const failingKeys = factKeys
    .filter((factKey) => !snapshot.believedFactKeys.has(factKey))
    .toSorted((left, right) => compareStrings(left, right));
  if (failingKeys.length > 0) {
    const evidence: VerdictEvidence = {
      config,
      graph,
      snapshot,
      available,
      currentSourceKeys: new Set(graph.sourceRows.map((row) => rowKey(row))),
      justificationKeysByFact: currentJustificationKeysByFact(graph),
    };
    throw new FactNotHoldingError({
      failures: failingKeys.map((factKey) =>
        describeFailure(evidence, factKey),
      ),
    });
  }

  return factKeys.map((factKey) => ({
    fact: keyToRef<G, FactKind>(factKey),
    via: sortedReferences<G, JustificationKind>(
      snapshot.firingJustificationKeysByFact.get(factKey) ?? [],
    ),
  }));
}

/** What a failure reason is derived from: the verdict's own inputs and outputs. */
type VerdictEvidence = Readonly<{
  config: NormalizedConfig;
  graph: SupportGraph;
  snapshot: SupportSnapshot;
  available: ReadonlySet<string>;
  /** Sources with a current row, retracted or not. */
  currentSourceKeys: ReadonlySet<string>;
  /** The current justifications deriving each fact, firing or not. */
  justificationKeysByFact: ReadonlyMap<string, readonly string[]>;
}>;

function currentJustificationKeysByFact(
  graph: SupportGraph,
): ReadonlyMap<string, readonly string[]> {
  const justificationKeysByFact = new Map<string, string[]>();
  for (const [justificationKey, factKeys] of graph.supportEdges
    .factsByJustification) {
    if (!graph.roles.justifications.has(justificationKey)) continue;
    for (const factKey of factKeys) {
      appendGroupedValue(justificationKeysByFact, factKey, justificationKey);
    }
  }
  return justificationKeysByFact;
}

function describeFailure(
  evidence: VerdictEvidence,
  factKey: string,
): FactNotHoldingFailure {
  const reason = failureReason(evidence, factKey);
  return {
    fact: keyToRef(factKey),
    reason,
    justifications:
      reason === "no-firing-justification" ?
        (evidence.justificationKeysByFact.get(factKey) ?? [])
          .toSorted((left, right) => compareStrings(left, right))
          .map((justificationKey) =>
            describeStalledJustification(evidence, justificationKey),
          )
      : [],
  };
}

/**
 * Why a fact that is not believed is not. The cases are tested in this order,
 * and the last three exclude one another:
 *
 * 1. it has no row at the read instant;
 * 2. it is supported, so the only thing missing is a live row;
 * 3. no current justification derives it;
 * 4. justifications derive it and none fires;
 * 5. one fires, so what holds it back is the one other condition of support —
 *    a required composition part needs a supported (or, for a whole that is
 *    not a fact, live) whole.
 */
function failureReason(
  evidence: VerdictEvidence,
  factKey: string,
): FactNotHoldingReason {
  const { snapshot } = evidence;
  if (!snapshot.facts.has(factKey)) return "not-current";
  if (snapshot.supportedFactKeys.has(factKey)) return "tombstoned";
  if (!evidence.justificationKeysByFact.has(factKey)) return "no-justification";
  if (!snapshot.firingJustificationKeysByFact.has(factKey)) {
    return "no-firing-justification";
  }
  return "composition-whole-unsupported";
}

function describeStalledJustification(
  evidence: VerdictEvidence,
  justificationKey: string,
): FactNotHoldingJustification {
  const premiseKeys =
    evidence.graph.supportEdges.premisesByJustification.get(justificationKey) ??
    [];
  return {
    justification: keyToRef(justificationKey),
    premises: premiseKeys
      .toSorted((left, right) => compareStrings(left, right))
      .flatMap((premiseKey) => describeFailingPremise(evidence, premiseKey)),
  };
}

/**
 * The failing premise this key names, or nothing when the premise is in the
 * supported set. A fact premise is `"unsupported"` without saying why. A
 * source premise is `"retracted"` when its current row carries the flag, and
 * `"not-current"` otherwise: sources are loaded in current mode, so a missing,
 * soft-deleted and validity-expired source are one case here.
 */
function describeFailingPremise(
  evidence: VerdictEvidence,
  premiseKey: string,
): readonly FactNotHoldingPremise[] {
  const premise = keyToRef(premiseKey);
  if (evidence.config.factKinds.includes(premise.kind)) {
    return evidence.snapshot.supportedFactKeys.has(premiseKey) ?
        []
      : [{ premise, reason: "unsupported" }];
  }
  if (evidence.available.has(premiseKey)) return [];
  return [
    {
      premise,
      reason:
        evidence.currentSourceKeys.has(premiseKey) ?
          "retracted"
        : "not-current",
    },
  ];
}
