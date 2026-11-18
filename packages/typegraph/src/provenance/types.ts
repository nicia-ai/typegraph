import type { GraphDef } from "../core/define-graph";
import {
  type PolymorphicNodeReference,
  type TransactionContext,
} from "../store/types";

export type NodeKind<G extends GraphDef> = Extract<keyof G["nodes"], string>;
type EdgeKind<G extends GraphDef> = Extract<keyof G["edges"], string>;

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
type KindsFromRef<G extends GraphDef, Ref> =
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
  retract: (
    source: ProvenanceSourceInput<G, SourceKind>,
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  retractMany: (
    sources: readonly ProvenanceSourceInput<G, SourceKind>[],
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  unRetract: (
    source: ProvenanceSourceInput<G, SourceKind>,
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  unRetractMany: (
    sources: readonly ProvenanceSourceInput<G, SourceKind>[],
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  /**
   * The facts currently believed: supported, and a live row.
   *
   * With no argument it reads in a transaction of its own, so the answer is a
   * point-in-time one that can stop being true before the caller's next
   * statement — not a write guard. With `tx` it runs the same whole-graph
   * computation on that transaction and sees the rows it has written. Either
   * way it takes the per-graph write lock and nothing else, so it runs in a
   * read-only transaction.
   *
   * @throws {ConfigurationError} when `tx` does not belong to an active
   *   callback of the capability's store.
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
   * facts. An empty list returns an empty result and takes no lock.
   *
   * @throws {FactNotHoldingError} naming every fact that does not hold; the
   *   rejection aborts the caller's transaction, and nothing is closed or
   *   reconciled.
   * @throws {ConfigurationError} when `tx` does not belong to an active
   *   callback of the capability's store, or a fact's kind is not one of the
   *   configured fact kinds.
   * @throws {UnsupportedBackendCapabilityError} in a transaction opened with
   *   `accessMode: "read_only"`; use `holding(tx)` there.
   */
  assertHolds: (
    tx: TransactionContext<G>,
    facts: readonly ProvenanceFactInput<G, FactKind>[],
  ) => Promise<readonly SurvivedVia<G, FactKind, JustificationKind>[]>;
}>;
