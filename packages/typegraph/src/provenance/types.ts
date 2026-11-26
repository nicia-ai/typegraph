import type { GraphDef } from "../core/define-graph";
import {
  type PolymorphicNodeReference,
  type TransactionContext,
} from "../store/types";

export type NodeKind<G extends GraphDef> = Extract<keyof G["nodes"], string>;
export type EdgeKind<G extends GraphDef> = Extract<keyof G["edges"], string>;

export type ProvenanceNodeRef<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
> = Readonly<{
  kind: K;
  id: string;
}>;

/**
 * What the retraction verbs accept for a source of kind `K`: a
 * {@link ProvenanceNodeRef}, or the {@link PolymorphicNodeReference} a
 * polymorphic query row over one of those kinds carries, whose `kind` is the
 * general `string`. The runtime refuses a kind outside the configured source
 * kinds with `ConfigurationError`.
 */
export type ProvenanceSourceInput<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
> = ProvenanceNodeRef<G, K> | PolymorphicNodeReference<G["nodes"][K]["type"]>;

/**
 * What `assertHolds` accepts for a fact of kind `K`: the same two shapes
 * {@link ProvenanceSourceInput} accepts for a source, so the node a
 * transaction has just created and a polymorphic query row both name a fact
 * directly. The runtime refuses a kind outside the configured fact kinds with
 * `ConfigurationError`.
 */
export type ProvenanceFactInput<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
> = ProvenanceNodeRef<G, K> | PolymorphicNodeReference<G["nodes"][K]["type"]>;

export type ProvenanceJustificationRef<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
> = ProvenanceNodeRef<G, K>;
export type ProvenanceFactRef<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
> = ProvenanceNodeRef<G, K>;

export type ProvenanceSourceConfig<G extends GraphDef = GraphDef> =
  | Readonly<{
      kind: NodeKind<G>;
      retractedField?: string;
    }>
  | Readonly<{
      kinds: readonly NodeKind<G>[];
      retractedField?: string;
    }>;

export type ProvenanceRetractionConfig<G extends GraphDef = GraphDef> =
  Readonly<{
    source: ProvenanceSourceConfig<G>;
    justification: Readonly<{ kind: NodeKind<G> }>;
    fact: Readonly<{ kinds: readonly NodeKind<G>[] }>;
    premiseOf: Readonly<{ kind: EdgeKind<G> }>;
    derives: Readonly<{ kind: EdgeKind<G> }>;
  }>;

/**
 * Extracts the node kind(s) referenced by a provenance role config, whether
 * declared as a single `{ kind }` or a `{ kinds }` array. Falls back to the
 * full `NodeKind<G>` union when neither shape is present (e.g. a role config
 * that also carries unrelated fields, matched structurally).
 */
export type KindsFromRef<G extends GraphDef, Ref> =
  Ref extends Readonly<{ kind: infer K }> ? Extract<K, NodeKind<G>>
  : Ref extends Readonly<{ kinds: readonly (infer K)[] }> ?
    Extract<K, NodeKind<G>>
  : NodeKind<G>;

export type SourceKindsFromConfig<
  G extends GraphDef,
  C extends ProvenanceRetractionConfig<G>,
> = KindsFromRef<G, C["source"]>;

export type FactKindsFromConfig<
  G extends GraphDef,
  C extends ProvenanceRetractionConfig<G>,
> = KindsFromRef<G, C["fact"]>;

export type JustificationKindFromConfig<
  G extends GraphDef,
  C extends ProvenanceRetractionConfig<G>,
> = KindsFromRef<G, C["justification"]>;

export type SurvivedVia<
  G extends GraphDef = GraphDef,
  FactKind extends NodeKind<G> = NodeKind<G>,
  JustificationKind extends NodeKind<G> = NodeKind<G>,
> = Readonly<{
  fact: ProvenanceFactRef<G, FactKind>;
  via: readonly ProvenanceJustificationRef<G, JustificationKind>[];
}>;

export type RetractionReport<
  G extends GraphDef = GraphDef,
  FactKind extends NodeKind<G> = NodeKind<G>,
  JustificationKind extends NodeKind<G> = NodeKind<G>,
> = Readonly<{
  died: readonly ProvenanceFactRef<G, FactKind>[];
  survivedVia: readonly SurvivedVia<G, FactKind, JustificationKind>[];
  unaffected: readonly ProvenanceFactRef<G, FactKind>[];
}>;

export type RetractionCapability<
  G extends GraphDef = GraphDef,
  SourceKind extends NodeKind<G> = NodeKind<G>,
  FactKind extends NodeKind<G> = NodeKind<G>,
  JustificationKind extends NodeKind<G> = NodeKind<G>,
> = Readonly<{
  /**
   * Retracts one source: sets its retracted flag, recomputes support and
   * closes the facts that lose it.
   *
   * With no `tx` it runs in a transaction of its own and commits it. With
   * `tx` it runs on that transaction and neither commits nor rolls it back:
   * its writes are part of the caller's transaction exactly as any other write
   * on it — visible to the transaction's later reads, `holding(tx)` and
   * `assertHolds(tx, …)`, counted in its receipts, recorded at its revision,
   * and reported to hooks under that context's hook contract: at commit in
   * `store.transaction()` / `transactionWithReceipt()`, but as each write
   * completes in an adopted `withRecordedTransaction()` /
   * `withEvolvedTransaction()` context, before the native commit or
   * rollback. Either way it takes the schema-version fence, then the
   * per-graph write lock, before its first read.
   *
   * Its support reads must see every write committed before the lock was
   * granted, so on PostgreSQL a `tx` must run at read committed: the
   * isolation is the one the lock statement observed on `tx`'s session, and
   * a snapshot isolation (repeatable read, serializable), whose snapshot can
   * predate another session's retraction, is refused before the first
   * support read with the transaction still usable. Without `tx` the
   * transition opens its own transaction at read committed, whatever the
   * server's default.
   *
   * A failure on a caller's `tx` takes no savepoint: if the caller catches
   * it and commits, the writes the transition made before failing commit too.
   * Let the error leave the callback to discard them. In an adopted context
   * the native transaction must then be rolled back: committing it after the
   * callback rejected commits the callback's writes to the live rows, and
   * under TypeGraph-owned history capture leaves them out of recorded time
   * (issue #930); a backend with engine-native recorded time records them
   * itself.
   *
   * Pass a function, not the verb itself, to an array method:
   * `sources.map(provenance.retract)` passes each index as `tx`, which is
   * refused.
   *
   * @throws {ConfigurationError} when `tx` is not a transaction context
   *   (`PROVENANCE_TRANSACTION_ARGUMENT_INVALID`), when it does not belong to
   *   an active callback of the capability's store
   *   (`PROVENANCE_TRANSACTION_NOT_OWNED`), when another retraction verb of
   *   the same graph is still running on `tx`'s transaction
   *   (`PROVENANCE_TRANSITION_OVERLAPPING`, before any statement; only where
   *   the two calls' sessions are proven to share that transaction, and a
   *   verb on an unproven one re-reads the source flags after its writes and
   *   reconciles a change instead), or when a
   *   source's kind is not one of the configured source kinds.
   * @throws {UnsupportedBackendCapabilityError} in a `tx` opened with
   *   `accessMode: "read_only"`, before any statement; and, with capability
   *   `observedReadCommittedIsolation`, in a `tx` whose session cannot prove
   *   that its reads observe every earlier holder of the graph write lock,
   *   before the first support read.
   * @throws {StaleVersionError} on a store handle whose schema version is no
   *   longer the active one.
   * @throws {NodeNotFoundError} when a source has no current row.
   */
  retract: (
    source: ProvenanceSourceInput<G, SourceKind>,
    tx?: TransactionContext<G>,
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  /**
   * Retracts every source in one transition, reported as one
   * {@link RetractionReport}. Takes `tx`, and
   * refuses and fails, exactly as `retract` does.
   */
  retractMany: (
    sources: readonly ProvenanceSourceInput<G, SourceKind>[],
    tx?: TransactionContext<G>,
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  /**
   * Clears one source's retracted flag, recomputes support and reopens
   * the facts that regain it. Takes `tx`, and refuses and fails, exactly as
   * `retract` does.
   */
  unRetract: (
    source: ProvenanceSourceInput<G, SourceKind>,
    tx?: TransactionContext<G>,
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  /**
   * Clears every source's retracted flag in one transition. Takes `tx`,
   * and refuses and fails, exactly as `retract` does.
   */
  unRetractMany: (
    sources: readonly ProvenanceSourceInput<G, SourceKind>[],
    tx?: TransactionContext<G>,
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  /**
   * The facts currently believed: supported, and a live row.
   *
   * With no argument it reads in a transaction of its own, so the answer is a
   * point-in-time one that can stop being true before the caller's next
   * statement — not a write guard. That transaction never writes, so it takes
   * the per-graph write lock alone. With `tx` it runs the same whole-graph
   * computation on that transaction and sees the rows it has written. In a
   * read-write `tx` it takes the store's write locks in their canonical order
   * — the schema-version fence, then the per-graph write lock — so the
   * transaction's later writes cannot invert them; in a `tx` opened with
   * `accessMode: "read_only"` it takes the per-graph write lock alone. A
   * read-write `tx` must also run at read committed on PostgreSQL, as the
   * retraction verbs' must; a read-only `tx` at a snapshot isolation answers
   * as of its one snapshot.
   *
   * @throws {ConfigurationError} when `tx` does not belong to an active
   *   callback of the capability's store.
   * @throws {StaleVersionError} in a read-write `tx` on a store handle whose
   *   schema version is no longer the active one.
   * @throws {UnsupportedBackendCapabilityError} with capability
   *   `observedReadCommittedIsolation` in a read-write `tx` whose session
   *   cannot prove that its reads observe every earlier holder of the graph
   *   write lock, before the first read.
   */
  holding: (
    tx?: TransactionContext<G>,
  ) => Promise<readonly ProvenanceFactRef<G, FactKind>[]>;
  /**
   * The commit-time guard: every named fact is in `holding(tx)`, or the call
   * throws. Run it inside the write transaction, after the writes it guards.
   *
   * Returns one entry per distinct fact, in the order each was first named,
   * with the justifications currently firing for it in `via`. A fact that
   * already holds through another justification passes, so a caller that
   * means "the justification I just wrote fires" checks that it is in `via`.
   *
   * It takes the store's write locks in their canonical order — the
   * schema-version fence, then the per-graph write lock — before its first
   * read, so it needs a read-write transaction and may be called before or
   * after the transaction's own writes. It reads only what is behind the named
   * facts. An empty list is checked for transaction ownership only: it
   * returns an empty result, takes no lock, reads nothing, and is not refused
   * in a read-only transaction.
   *
   * @throws {FactNotHoldingError} naming every fact that does not hold; the
   *   rejection aborts the caller's transaction, and nothing is closed or
   *   reconciled.
   * @throws {ConfigurationError} when `tx` does not belong to an active
   *   callback of the capability's store, or a fact's kind is not one of the
   *   configured fact kinds.
   * @throws {UnsupportedBackendCapabilityError} in a transaction opened with
   *   `accessMode: "read_only"`; use `holding(tx)` there. And, with
   *   capability `observedReadCommittedIsolation`, in a transaction whose
   *   session cannot prove that its reads observe every earlier holder of the
   *   graph write lock (on PostgreSQL, one not at read committed), before the
   *   first read.
   */
  assertHolds: (
    tx: TransactionContext<G>,
    facts: readonly ProvenanceFactInput<G, FactKind>[],
  ) => Promise<readonly SurvivedVia<G, FactKind, JustificationKind>[]>;
}>;
