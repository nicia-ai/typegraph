/**
 * Core type model for the graph-merge primitive.
 *
 * Finalized against TypeGraph's real generic machinery: the design's illustrative
 * `Node<G, K>` / `NodeId<NodeKinds<G>>` collapse onto TypeGraph's public
 * `Node` / `Edge` / `NodeId<NodeType>` / `EdgeId` (which are themselves branded
 * over `NodeType` / `EdgeType`). The merge surface is parameterized over
 * `G extends GraphDef` so `Store<G>` and `GraphBranch<G>` thread the caller's
 * concrete graph definition end-to-end.
 *
 * This module is pure type declarations plus the two branding helpers — no
 * runtime merge logic.
 */

import type {
  EdgeId,
  GraphDef,
  JsonValue,
  Node,
  NodeId,
  NodeType,
  Store,
} from "./typegraph-internal";

/**
 * Opaque identifier for a branch (working copy) of a base store. Branded so a
 * raw string cannot be passed where a deliberately-minted branch id is required.
 */
export type BranchId = string & Readonly<{ readonly __brand: "BranchId" }>;

/**
 * Opaque token identifying the immutable `base@V` a branch was forked from.
 * Combines a schema hash with a content fingerprint (computed in T3). Branded so
 * it cannot be confused with an arbitrary string.
 */
export type BaseVersion = string &
  Readonly<{ readonly __brand: "BaseVersion" }>;

/**
 * Mints a {@link BranchId} from a raw string. Centralizes the brand cast so the
 * unsafe assertion lives in exactly one place.
 */
export function asBranchId(value: string): BranchId {
  return value as BranchId;
}

/**
 * Mints a {@link BaseVersion} from a raw string. Centralizes the brand cast so
 * the unsafe assertion lives in exactly one place.
 */
export function asBaseVersion(value: string): BaseVersion {
  return value as BaseVersion;
}

/**
 * A working-copy handle for one branch: its id, the `base@V` it forked from, and
 * a {@link Store} over the branch's own backend.
 */
export type GraphBranch<G extends GraphDef> = Readonly<{
  id: BranchId;
  base: BaseVersion;
  store: Store<G>;
}>;

/**
 * Options for {@link GraphBranch} creation. `id` is optional — when omitted a
 * fresh id is generated.
 */
export type BranchOptions = Readonly<{
  id?: BranchId;
}>;

/**
 * Turns text into an embedding vector. Injected via {@link MergeOptions.embedder}
 * and used by the `vector` / `hybrid` similarity strategies to score candidate
 * pairs by cosine IN MEMORY — the staged candidate nodes are unindexed in the
 * working copy, so a backend ANN index cannot score them pairwise (see
 * `scorePair`). Exact in-memory cosine over real model vectors is both the right
 * scale for bounded candidate dedup and deterministic, which the merge contract
 * requires.
 *
 * Batched and async: given N texts it returns N vectors in the SAME order, each a
 * fixed-dimension `Float32Array` (every vector a given embedder returns shares one
 * length — the model's embedding dimension). The function MUST be deterministic —
 * the same text always yields the same vector — because the whole merge is
 * order-independent and reproducible. Vectors need NOT be pre-normalized; cosine
 * scoring normalizes internally.
 *
 * The concrete local model lives in the CONSUMER (the harness ships an
 * all-MiniLM-L6-v2 embedder); this package depends only on the function shape, so
 * it stays model-agnostic and lean inside the TypeGraph core package.
 */
export type Embedder = (
  texts: readonly string[],
) => Promise<readonly Float32Array[]>;

/**
 * Pluggable per-kind similarity strategy (design §8).
 *
 * - `vector` / `hybrid` score candidate pairs by cosine over an injected
 *   {@link Embedder} ({@link MergeOptions.embedder}), computed in memory; they
 *   fail with `SimilarityUnavailableError` when no embedder is configured.
 * - `fulltext` and `custom` run with ZERO embeddings — the cross-DB-safe
 *   default. `fulltext` uses an in-memory Sørensen–Dice trigram scorer (T6).
 *
 * The generic mirrors the design's `SimilarityStrategy<G, K>`: `K` constrains the
 * `custom` score function's node arguments to the resolved kind.
 */
export type SimilarityStrategy<
  G extends GraphDef = GraphDef,
  K extends NodeType = NodeType,
> =
  | Readonly<{
      kind: "hybrid";
      fields: readonly string[];
      weights?: Readonly<{ vector?: number; fulltext?: number }>;
      // Phantom binding to the caller's graph, matching the design's
      // `SimilarityStrategy<G, K>` two-parameter shape. Never set at runtime.
      readonly __graph?: G;
    }>
  | Readonly<{ kind: "vector"; field: string; readonly __graph?: G }>
  | Readonly<{
      kind: "fulltext";
      fields: readonly string[];
      readonly __graph?: G;
    }>
  | Readonly<{
      kind: "custom";
      score: (a: Node<K>, b: Node<K>) => number;
      readonly __graph?: G;
    }>;

/**
 * Per-kind entity-resolution configuration.
 */
export type ResolveConfig<
  G extends GraphDef = GraphDef,
  K extends NodeType = NodeType,
> = Readonly<{
  /**
   * Cheap exact-equality blocking key, evaluated before similarity to bound the
   * O(n²) candidate comparisons. Returning `undefined` places the node in the
   * shared `"unblocked"` bucket (compared all-vs-all within its kind).
   *
   * STAGED-vs-staged only: it is an arbitrary JS function, so it cannot be queried
   * against the committed base. To recall committed entities by a block key
   * (new-vs-base, the `baseKey` source §6.2), declare the key as a TypeGraph node
   * index and name it via {@link ResolveConfig.blockIndex} instead.
   */
  block?: (node: Node<K>) => string | undefined;
  /**
   * Name of a declared TypeGraph node index (`defineNodeIndex`) whose key is this
   * kind's NEW-vs-BASE block key (design §6.2). When set and the new-vs-base scope is
   * driven, the `baseKey` source issues an indexed `bulkFindByIndex` lookup of
   * committed nodes sharing each staged node's index key and proposes them as scored
   * candidate pairs (a shared block key is a candidate, not a definitional match).
   *
   * The index keys on real fields (a field-set + scope + optional partial-`where`), so
   * only a FIELD-SET block key migrates here; a transform key (`slice`/`soundex`/…)
   * stays on the staged-only {@link block}. Unused on the public snapshot `merge()`
   * path. An undeclared name surfaces a typed error at lookup time.
   */
  blockIndex?: string;
  /**
   * Bounded coarse candidate generation for the NO-KEY case (design §6.2, the
   * `keyless` source). A node whose {@link block} returns `undefined` (and has no
   * unique signature) lands in the shared `"unblocked"` bucket, which is otherwise
   * compared ALL-vs-all — an O(n²) cliff that `maxComparisonsPerKind` then truncates
   * to id-only. Set `keyless` to bound that bucket by single-pass SORTED-NEIGHBOURHOOD
   * instead: the unblocked nodes are sorted by their similarity-field text (tie-broken
   * by id) and each is proposed only against its next `window` neighbours — O(n·window),
   * deterministic. Unset preserves today's all-vs-all behaviour. Only the `"unblocked"`
   * bucket is affected; keyed `block()` buckets are unchanged.
   */
  keyless?: Readonly<{
    /** Forward-neighbour window: each unblocked node is paired with its next `window`
     * neighbours in the sort. Must be a positive integer. Larger → more recall, more
     * comparisons (→ all-vs-all as `window` ≥ bucket size). */
    window: number;
  }>;
  /** Similarity strategy (design §8). */
  similarity: SimilarityStrategy<G, K>;
  /** Candidate-merge threshold in `[0, 1]`. */
  threshold: number;
}>;

/**
 * A resolved cluster of node ids that the merge collapses into one canonical
 * survivor.
 */
export type ResolvedCluster = Readonly<{
  members: readonly NodeId<NodeType>[];
}>;

/**
 * Policy for resolving conflicting property values across cluster members.
 *
 * - `"flag"` keeps the canonical's value and records a {@link PropertyConflict}
 *   without auto-resolving.
 * - `"lastWriteWins"` picks by the stable branch/logical total order — NEVER
 *   wall-clock arrival.
 * - `"provenanceWeighted"` picks by per-branch trust weight.
 * - A function delegates the decision, returning the surviving {@link JsonValue}.
 */
export type PropertyConflictPolicy<G extends GraphDef = GraphDef> =
  | "flag"
  | "lastWriteWins"
  | "provenanceWeighted"
  | ((conflict: PropertyConflict<G>) => JsonValue);

/**
 * Policy for resolving an inherited node that is deleted by one branch and
 * modified by another (design §6.2).
 *
 * - `"deleteWins"` — the node is finally DELETED; the modification is discarded.
 * - `"modifyWins"` — the node is RESURRECTED; the modification survives.
 * - `"flag"` (default) — the **modification SURVIVES in the merged output** (as
 *   with `"modifyWins"`) AND an **unresolved {@link DeleteModifyConflict} is
 *   recorded** in `report.deleteModifyConflicts` for human review. `"flag"` is
 *   therefore NOT neutral — it keeps data and surfaces the disagreement, on the
 *   posture that a merge must never silently destroy the only branch still
 *   carrying data. Choose `"deleteWins"` to honor the delete by default instead.
 */
export type DeleteModifyPolicy = "deleteWins" | "modifyWins" | "flag";

/**
 * Behavior when `maxComparisonsPerKind` is exceeded for a kind.
 *
 * - `"error"` fails the merge with a typed error (default).
 * - `"mergeByIdOnly"` skips similarity for that kind, emits no candidate edges,
 *   and records a report warning.
 */
export type ComparisonCeilingPolicy = "error" | "mergeByIdOnly";

/**
 * Ontology type-reconciliation mode. `"off"` is a no-op (default); `"ontology"`
 * collapses compatible types to the most-specific via the public subClassOf
 * closure (T2a / T10).
 */
export type ReconcileTypesMode = "ontology" | "off";

/**
 * Map of node kind name → its {@link ResolveConfig}. Kinds omitted from this map
 * merge by ID only (new fork nodes added as-is, no fuzzy resolution).
 */
export type ResolveMap<G extends GraphDef = GraphDef> = Readonly<Record<string, ResolveConfig<G, NodeType>>>;

/**
 * Caller-facing options for {@link merge}. All fields are optional with frozen
 * defaults applied by `normalizeMergeOptions` (see `options.ts`).
 */
export type MergeOptions<G extends GraphDef = GraphDef> = Readonly<{
  /** Per-kind entity resolution. Omitted kinds merge by ID only. */
  resolve?: ResolveMap<G>;
  /** Reconcile differing types across forks. Default `"off"`. */
  reconcileTypes?: ReconcileTypesMode;
  /** Property-conflict policy for staged-vs-staged disagreements. Default `"flag"`. */
  onPropertyConflict?: PropertyConflictPolicy<G>;
  /**
   * Property-conflict policy for BASE↔branch disagreements in a new-vs-base merge
   * (§6.4-C). DISTINCT from {@link onPropertyConflict} and DOES NOT inherit it:
   * `onPropertyConflict` can be `"lastWriteWins"` / `"provenanceWeighted"` / a
   * function, any of which would let a fuzzy branch match silently OVERWRITE
   * committed data. Default `"flag"` keeps the committed base value (and records the
   * conflict). Mirrors how `onDeleteModifyConflict` is kept separate. Only consulted
   * when a cluster contains a base member; the staged path never uses it.
   */
  onBasePropertyConflict?: PropertyConflictPolicy<G>;
  /** Delete/modify-conflict policy. Default `"flag"`. */
  onDeleteModifyConflict?: DeleteModifyPolicy;
  /** Comparison-ceiling behavior. Default `"error"`. */
  onComparisonCeiling?: ComparisonCeilingPolicy;
  /**
   * Deterministic survivor selection within a cluster. Default: the member with
   * the lexicographically-minimal node id.
   */
  canonical?: (cluster: ResolvedCluster) => NodeId<NodeType>;
  /** Populate the report-only provenance index. Default `true`. */
  provenance?: boolean;
  /**
   * Persist provenance ON-GRAPH: after the commit, upsert one `{branch, sourceId}`
   * row per contribution into a sidecar provenance graph on the target's backend
   * (queryable via `openProvenanceStore` / `readProvenance`). Default `false`
   * (report-only). Best-effort and post-commit — a persistence failure surfaces as
   * a {@link MergeReport.warnings} entry, never a failed merge.
   */
  persistProvenance?: boolean;
  /**
   * Local embedder for `vector` / `hybrid` similarity (in-memory cosine over the
   * staged candidate pairs). Required ONLY when a kind's resolve strategy is
   * `vector` or `hybrid`; `fulltext` / `custom` ignore it. A vector/hybrid
   * strategy with no embedder configured fails with a typed
   * {@link import("./errors").SimilarityUnavailableError}.
   */
  embedder?: Embedder;
  /** Merge receiver. Default: the base `store`, written transactionally. */
  target?: Store<G>;
  /** Safety ceiling on candidate comparisons per kind. Default: unbounded. */
  maxComparisonsPerKind?: number;
  /**
   * Optional single-link diameter guard. When set, clusters whose pairwise
   * distance exceeds it are split by the deterministic drop-weakest rule (T8).
   */
  clusterMaxDiameter?: number;
  /**
   * Explicit stable branch order used by `lastWriteWins` / tie-breaking. When
   * omitted, branch ids sorted lexicographically are used. NEVER wall-clock.
   */
  branchOrder?: readonly BranchId[];
}>;

/**
 * How `mergeIncremental()` v1 (additive, §6.6) treats inherited modify/delete in the
 * fork-point diff. `"error"` (default) fails fast; `"skipWithReport"` drops them but
 * records a {@link MergeReport.warnings} entry — never a silent ignore.
 */
export type InheritedMutationPolicy = "error" | "skipWithReport";

/**
 * Object-form arguments for {@link mergeIncremental} (§6.6). The two same-typed
 * stores are NAMED so `forkPoint` (the frozen ancestor the branches forked from, the
 * additive diff reference) and `target` (the live committed graph that base lookups
 * and the commit land on) cannot be swapped. `options.target` is ignored — `target`
 * is the explicit arg.
 */
export type MergeIncrementalArgs<G extends GraphDef = GraphDef> = Readonly<{
  forkPoint: Store<G>;
  target: Store<G>;
  branches: readonly GraphBranch<G>[];
  options?: MergeOptions<G>;
  onInheritedMutation?: InheritedMutationPolicy;
}>;

/**
 * Records that a set of fork node ids resolved to a single canonical survivor.
 */
export type EntityResolution = Readonly<{
  canonicalId: NodeId<NodeType>;
  memberIds: readonly NodeId<NodeType>[];
  kind: string;
  branchOrigins: readonly BranchId[];
}>;

/**
 * One candidate value contributing to a property conflict, tagged by its origin
 * branch.
 */
export type ConflictingValue = Readonly<{
  branchId: BranchId;
  value: JsonValue;
}>;

/**
 * A property whose value differed across cluster members (or across the two
 * collapsed edges for an edge conflict). `resolution` records the value the
 * policy selected.
 */
export type PropertyConflict<G extends GraphDef = GraphDef> = Readonly<{
  entityId: NodeId<NodeType> | EdgeId;
  kind: string;
  property: string;
  values: readonly ConflictingValue[];
  resolution: JsonValue;
  // `G` keeps the public conflict type parameterized by the caller's graph
  // (matching the design's `PropertyConflict<G>`); it carries no runtime field.
  readonly __graph?: G;
}>;

/**
 * An inherited node deleted by one branch and modified by another, with the
 * resolution the {@link DeleteModifyPolicy} produced.
 */
export type DeleteModifyConflict = Readonly<{
  entityId: NodeId<NodeType>;
  kind: string;
  deletedBy: BranchId;
  modifiedBy: BranchId;
  resolution: DeleteModifyPolicy;
}>;

/**
 * Records that a cluster's mixed member kinds were collapsed to a single
 * canonical (most-specific) type via ontology reconciliation.
 */
export type TypeReconciliation = Readonly<{
  entityId: NodeId<NodeType>;
  fromTypes: readonly string[];
  toType: string;
}>;

/**
 * An item omitted from the merged result (e.g. an edge whose endpoint was
 * deleted, or an incompatible-typed cluster member).
 */
export type DroppedItem = Readonly<{
  kind: "edge" | "node";
  id: NodeId<NodeType> | EdgeId;
  reason: string;
}>;

/**
 * A `(kind, id)` node identity as surfaced in the merge report. Node identity is the
 * PAIR, never the bare id (a `Doctor` and a `SpecialistDoctor` can share an id string),
 * so report shapes that name nodes carry both halves.
 */
export type ReportNodeIdentity = Readonly<{
  kind: string;
  id: NodeId<NodeType>;
}>;

/**
 * An AMBIGUOUS new-vs-base match (design §6.4-A): a connected component that
 * bridged ≥2 distinct committed base entities (directly, `baseA ~ new ~ baseB`, or
 * through staged hops, `baseA ~ new1 ~ new2 ~ baseB`). `baseIds` are the committed
 * entities the component spanned; `memberIds` are all of its members. Both are full
 * `(kind, id)` identities — the guard keys on the composite identity, so a component
 * spanning two SAME-id/different-kind bases stays distinguishable in the report. The
 * base↔base collapse is ALWAYS REFUSED — the component is split so the committed
 * entities stay separate. Reported regardless of how the component split. (A
 * deliberate-collapse trust path is deferred until committed-entity re-keying + edge
 * repoint exist; §6.4-C.)
 */
export type BaseAmbiguity = Readonly<{
  baseIds: readonly ReportNodeIdentity[];
  memberIds: readonly ReportNodeIdentity[];
}>;

/**
 * The contribution one branch made to the merged result. Returned by
 * {@link ProvenanceIndex.byBranch}. EXPLICITLY in-memory / report-only for P0 —
 * no on-graph prop tagging (deferred to the AgentFS phase).
 */
export type BranchProvenance = Readonly<{
  nodeIds: readonly NodeId<NodeType>[];
  edgeIds: readonly EdgeId[];
}>;

/**
 * Report-only, in-memory provenance index. `byBranch` answers "which
 * nodes/edges did this branch contribute to the merged result?".
 */
export type ProvenanceIndex = Readonly<{
  byBranch: (branchId: BranchId) => BranchProvenance;
}>;

/**
 * One `{branch, sourceId}` → canonical contribution — the unit of provenance.
 *
 * The in-memory {@link ProvenanceIndex} collapses these to `branch → {canonical
 * ids}`; the full record (which keeps the contributing `sourceId` and kind) is what
 * `persistProvenance` writes to the sidecar provenance graph. `sourceId` is the
 * fork-local id the contribution had in its branch BEFORE the merge collapsed it to
 * `canonicalId` (equal to `canonicalId` for an in-place modification).
 */
export type ProvenanceRecord = Readonly<{
  role: "node" | "edge";
  canonicalId: string;
  canonicalKind: string;
  branchId: BranchId;
  sourceId: string;
}>;

/**
 * The full result of a {@link merge}: counts, every resolution/conflict/
 * reconciliation/drop, and the report-only provenance index.
 */
export type MergeReport<G extends GraphDef = GraphDef> = Readonly<{
  merged: Readonly<{ nodes: number; edges: number }>;
  resolutions: readonly EntityResolution[];
  conflicts: readonly PropertyConflict<G>[];
  deleteModifyConflicts: readonly DeleteModifyConflict[];
  typeReconciliations: readonly TypeReconciliation[];
  dropped: readonly DroppedItem[];
  /**
   * Ambiguous new-vs-base matches (§6.4-A): components that bridged ≥2 committed
   * base entities. Empty on the staged-vs-staged snapshot path.
   */
  baseAmbiguities: readonly BaseAmbiguity[];
  provenance: ProvenanceIndex;
  /**
   * Non-fatal advisories from the merge — comparison-ceiling skips and, when
   * `persistProvenance` is set, a best-effort provenance-persistence failure (the
   * graph still committed). Empty on a clean merge.
   */
  warnings: readonly string[];
  /**
   * Present only when `persistProvenance` ran and SUCCEEDED: the sidecar provenance
   * graph id and how many `{branch, sourceId}` rows were upserted. Absent when
   * persistence was off or failed (a failure adds a {@link MergeReport.warnings}).
   */
  provenancePersisted?: Readonly<{ graphId: string; count: number }>;
}>;
