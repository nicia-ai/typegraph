/**
 * `merge()` orchestrator (design §7.2, T11).
 *
 * Composes every phase built in T3–T10 into one DB-agnostic primitive:
 *
 *   1. PRECONDITION — compute the target's `base@V` and reject any branch whose
 *      `base` token does not match it (`BaseVersionMismatchError`). A branch
 *      forked from a divergent schema or content fingerprint cannot be merged
 *      safely (design §5.2 / §13.6).
 *   2. STAGE — `stageBranches` (T7): the provenance-tagged UNION of every
 *      branch's state-diff against the immutable base.
 *   3. CANDIDATE-GEN — per resolved kind: build node-shaped objects from the
 *      staged NEW nodes, `blockNodes` (T5, folding in unique constraints from
 *      `introspect()`), `generateCandidates` (T6, fulltext Dice + custom; vector/
 *      hybrid guarded). Kinds NOT in `options.resolve` merge by id only.
 *   4. CLUSTER — `connectedComponents` (T8) over the accumulated candidate edges
 *      and every staged new-node id, with the optional diameter guard.
 *   5. CANONICALIZE — `canonicalizeCluster` (T8): min-id survivor + commutative
 *      property union under the stable, non-wall-clock conflict policy.
 *   6. DELETE/MODIFY — `resolveDeleteModify` (T8a): the authoritative final
 *      liveness of every inherited node + the delete/modify conflicts.
 *   7. TYPE-RECONCILE — `reconcileTypes` (T10) over the public-closure glue when
 *      `reconcileTypes: "ontology"`; otherwise a no-op.
 *   8. EDGE REPOINT — `repointEdges` (T9): repoint every staged edge onto its
 *      cluster canonical, drop edges to finally-deleted endpoints, dedupe + union
 *      edge props under the same conflict policy.
 *   9. COMMIT — apply everything to `target` (default = base store) in a single
 *      `store.transaction` when the backend is transactional, else non-atomically
 *      with a report warning (out of the P0 acceptance path — SQLite + Postgres
 *      are both transactional).
 *  10. REPORT — assemble the {@link MergeReport} with merged counts, every
 *      resolution / conflict / reconciliation / drop, and the in-memory
 *      {@link ProvenanceIndex}. With `persistProvenance`, ALSO upsert the
 *      `{branch, sourceId}` records to a sidecar provenance graph (post-commit,
 *      best-effort — a failure surfaces as a report warning, never a failed merge).
 *
 * DETERMINISM: every phase is order-independent (pure functions over the
 * unordered branch / staged sets, with a branch order captured ONCE for
 * conflict resolution), so shuffling `branches` yields a deep-equal report and an
 * identical committed graph. T12 proves this with a fast-check shuffle property.
 */

import { computeBaseVersion, computeSchemaComponent } from "./base-version";
import { blockNodes } from "./blocking";
import { canonicalizeProps } from "./canonical-props";
import type { CanonicalEntity, ClusterMember } from "./canonicalize";
import { BASE_PROVENANCE_BRANCH, canonicalizeCluster } from "./canonicalize";
import { buildSubClassClosure } from "./closures";
import type { ClusterResult } from "./clustering";
import {
  connectedComponents,
  enforceBaseGuard,
  enforceDiameter,
} from "./clustering";
import type { ProvenanceWeights } from "./conflict-policy";
import { buildBranchRank } from "./conflict-policy";
import { reconcileModifications, resolveDeleteModify } from "./delete-modify";
import type { MergedEdge, StagedEdge } from "./edge-repoint";
import { buildCanonicalMap, repointEdges } from "./edge-repoint";
import { BaseVersionMismatchError, MergeError } from "./errors";
import {
  compareMergeKeys,
  compareStrings,
  idOf,
  kindOf,
  type MergeKey,
  mergeKey,
  mergeKeyOf,
} from "./node-key";
import type { NormalizedMergeOptions } from "./options";
import { normalizeMergeOptions } from "./options";
import {
  openProvenanceStore,
  persistProvenanceRecords,
  provenanceGraphId,
} from "./provenance-store";
import type { Result } from "./result";
import { err, isErr, ok } from "./result";
import type { CandidateEdge, CandidatePair } from "./scoring";
import { scoreCandidates } from "./scoring";
import type { SimilarityContext } from "./similarity";
import { embeddingFields, fieldText } from "./similarity";
import type { BaseLookupStore, BaseMember, SourceScope } from "./sources";
import {
  baseKeySource,
  baseUniqueSource,
  CANDIDATE_SOURCES,
  keylessConfigFor,
  ontologyRetypeEdges,
} from "./sources";
import type {
  StagedModifiedNode,
  StagedNewEdge,
  StagedNewNode,
  StagingSet,
} from "./staging";
import { stageBranches } from "./staging";
import type { ReconcileClusterInput } from "./type-reconcile";
import { mostSpecificCommonKind, reconcileTypes } from "./type-reconcile";
import type {
  Edge,
  GraphDef,
  JsonValue,
  Node,
  NodeId,
  NodeType,
  Store,
  UniqueIntrospection,
} from "./typegraph-internal";
import type {
  BaseAmbiguity,
  BranchId,
  BranchProvenance,
  DeleteModifyConflict,
  DroppedItem,
  Embedder,
  EntityResolution,
  GraphBranch,
  InheritedMutationPolicy,
  MergeIncrementalArgs as MergeIncrementalArguments,
  MergeOptions,
  MergeReport,
  PropertyConflict,
  PropertyConflictPolicy,
  ProvenanceIndex,
  ProvenanceRecord,
  ResolveConfig,
  TypeReconciliation,
} from "./types";

/** A node id in its untyped (`NodeType`-default) branded form. */
type AnyNodeId = NodeId<NodeType>;

/**
 * Materializes a {@link Node}-shaped object from a staged new node's parsed
 * props. The blocking (T5) and similarity (T6) phases read schema fields directly
 * off the node (`node.name`), so the props must be spread at the top level with
 * `kind`/`id` alongside — exactly the runtime shape `Node<NodeType>` carries.
 */
function asNode(staged: StagedNewNode): Node<NodeType> {
  return {
    kind: staged.node.kind,
    id: staged.node.id,
    ...staged.node.props,
  } as unknown as Node<NodeType>;
}

/**
 * Collects, per kind, every staged new node tagged by branch, in deterministic
 * `(id, branchId)` order. The staging set already buckets new nodes by kind in
 * lexicographic order; this re-sorts each bucket defensively so candidate-gen is
 * correct for any caller.
 */
function newNodesByKind(
  staging: StagingSet,
): ReadonlyMap<string, readonly StagedNewNode[]> {
  const ordered = new Map<string, readonly StagedNewNode[]>();
  for (const [kind, items] of staging.newNodesByKind) {
    ordered.set(
      kind,
      [...items].sort((left, right) => {
        const byId = compareStrings(left.node.id, right.node.id);
        return byId === 0 ? (
            compareStrings(left.branchId, right.branchId)
          ) : byId;
      }),
    );
  }
  return ordered;
}

/**
 * Looks up a kind's declared unique constraints from the store introspection, so
 * blocking can short-circuit exact-match duplicates. Returns an empty array for a
 * kind with no constraints (or an unknown kind).
 */
function uniqueConstraintsFor(
  introspectionKinds: ReadonlyMap<string, readonly UniqueIntrospection[]>,
  kind: string,
): readonly UniqueIntrospection[] {
  return introspectionKinds.get(kind) ?? [];
}

/**
 * Precomputes the text→vector lookup the `vector`/`hybrid` scorers read.
 *
 * Runs the injected {@link Embedder} ONCE over the deduplicated, non-empty field
 * texts of every staged new node belonging to a `vector`/`hybrid` kind, in sorted
 * order. Embedding is per-text independent and the lookup is keyed by text, so the
 * map — and therefore every pairwise cosine — is a pure function of the staged node
 * SET, independent of branch/arrival order (the determinism contract). The text of
 * each node is taken via the SAME {@link fieldText} the scorer uses, so the
 * embedded key and the looked-up key always match.
 *
 * Returns an EMPTY map when no kind needs embeddings (or every text is empty). The
 * caller passes the map (vs. `undefined`) to {@link SimilarityContext} only when an
 * embedder was configured — that presence is what lets `scorePair` distinguish
 * "embedder configured" from "vector/hybrid requested with no embedder".
 */
async function precomputeEmbeddings<G extends GraphDef>(
  byKind: ReadonlyMap<string, readonly StagedNewNode[]>,
  resolve: NormalizedMergeOptions<G>["resolve"],
  embedder: Embedder,
): Promise<ReadonlyMap<string, Float32Array>> {
  const texts = new Set<string>();
  for (const [kind, items] of byKind) {
    const config = resolve[kind];
    if (config === undefined) {
      continue;
    }
    const fields = embeddingFields(config.similarity);
    if (fields === undefined) {
      continue;
    }
    for (const staged of items) {
      const text = fieldText(asNode(staged), fields);
      if (text.length > 0) {
        texts.add(text);
      }
    }
  }

  const lookup = new Map<string, Float32Array>();
  if (texts.size === 0) {
    return lookup;
  }
  const orderedTexts = [...texts].sort((left, right) =>
    left < right ? -1
    : left > right ? 1
    : 0,
  );
  const vectors = await embedder(orderedTexts);
  if (vectors.length !== orderedTexts.length) {
    throw new MergeError(
      `Embedder returned ${vectors.length} vectors for ${orderedTexts.length} texts; expected exactly one per text.`,
      {
        details: { texts: orderedTexts.length, vectors: vectors.length },
        suggestion:
          "Ensure MergeOptions.embedder returns one vector per input text, in order.",
      },
    );
  }
  for (const [index, text] of orderedTexts.entries()) {
    lookup.set(text, vectors[index]!);
  }
  return lookup;
}

/**
 * Runs candidate generation for every kind that has a {@link ResolveConfig} by
 * driving the candidate SOURCES (`sources.ts`) over the shared SCORING stage
 * (`scoring.ts`, §4): per kind, each source proposes pairs + forced edges off the
 * scope, and the scoring stage turns them into the kind's candidate edges.
 * Accumulates edges + any base members across kinds and records comparison-ceiling
 * warnings. Kinds NOT in `resolve` (or with no staged new nodes) contribute no
 * candidate edges — they merge by id only.
 *
 * `useBaseSources` selects the resolution DIRECTION. The public snapshot `merge()`
 * passes `false` — only the staged sources (`exactKey`, `unique`) run, so no
 * committed node is pulled into scope (`baseMembers` is empty) and the path stays
 * staged-vs-staged. The synthetic new-vs-base scope passes `true`, adding
 * {@link baseUniqueSource} (which queries `target`) so a staged node re-discovering
 * a committed entity surfaces as a forced new↔base edge + a base member.
 *
 * Returns `err` when a kind's `onComparisonCeiling: "error"` ceiling trips or a
 * `vector`/`hybrid` strategy hits the no-embedder guard.
 */
async function generateAllCandidates<G extends GraphDef>(
  target: Store<G>,
  staging: StagingSet,
  options: NormalizedMergeOptions<G>,
  introspectionKinds: ReadonlyMap<string, readonly UniqueIntrospection[]>,
  ctx: SimilarityContext,
  useBaseSources: boolean,
): Promise<
  Result<
    Readonly<{
      edges: readonly CandidateEdge[];
      warnings: readonly string[];
      baseMembers: readonly BaseMember[];
    }>,
    MergeError
  >
> {
  const allEdges: CandidateEdge[] = [];
  const warnings: string[] = [];
  const baseMembers: BaseMember[] = [];
  const byKind = newNodesByKind(staging);
  const sources =
    useBaseSources ?
      [...CANDIDATE_SOURCES, baseUniqueSource, baseKeySource]
    : CANDIDATE_SOURCES;
  // Base sources resolve staged nodes against the COMMITTED graph — the merge
  // TARGET, where prior runs' canonicals live — NOT the (possibly older) diff
  // reference. They coincide under the public snapshot path (target defaults to
  // store); they differ under the synthetic new-vs-base scope.
  const baseStore = target as unknown as BaseLookupStore;

  // Each kind's candidate generation is independent (results are concatenated, then
  // globally re-sorted below), so run them concurrently — under the base-source path
  // each kind's `bulkFindByConstraint` round-trip would otherwise serialise.
  const perKind = await Promise.all(
    [...byKind].map(
      async ([kind, items]): Promise<
        Result<
          Readonly<{
            edges: readonly CandidateEdge[];
            warnings: readonly string[];
            baseMembers: readonly BaseMember[];
          }>,
          MergeError
        >
      > => {
        const resolveConfig = options.resolve[kind] as
          | ResolveConfig<G, NodeType>
          | undefined;
        if (resolveConfig === undefined) {
          // No resolution config for this kind: merge by id only (no candidate
          // edges, so every new node stays a singleton cluster).
          return ok({ edges: [], warnings: [], baseMembers: [] });
        }

        const nodes = items.map((staged) => asNode(staged));
        const uniqueConstraints = uniqueConstraintsFor(
          introspectionKinds,
          kind,
        );
        const blocks = blockNodes(nodes, resolveConfig, uniqueConstraints);
        const keylessConfig = keylessConfigFor(resolveConfig);
        const scope: SourceScope = {
          kind,
          blocks,
          nodes,
          uniqueConstraints,
          store: baseStore,
          ...(resolveConfig.blockIndex === undefined ?
            {}
          : { blockIndex: resolveConfig.blockIndex }),
          ...(keylessConfig === undefined ? {} : { keyless: keylessConfig }),
        };

        const pairs: CandidatePair[] = [];
        const forcedEdges: CandidateEdge[] = [];
        const kindBaseMembers: BaseMember[] = [];
        for (const source of sources) {
          const produced = await source.generate(scope);
          pairs.push(...produced.pairs);
          forcedEdges.push(...produced.forcedEdges);
          kindBaseMembers.push(...produced.baseMembers);
        }

        const scored = scoreCandidates(
          { pairs, forcedEdges },
          resolveConfig,
          ctx,
          options.onComparisonCeiling,
          options.maxComparisonsPerKind,
        );
        if (isErr(scored)) {
          return err(scored.error);
        }
        return ok({
          edges: scored.data.edges,
          warnings: scored.data.warnings.map(
            (warning) => `[${kind}] ${warning.message}`,
          ),
          baseMembers: kindBaseMembers,
        });
      },
    ),
  );

  for (const result of perKind) {
    if (isErr(result)) {
      return err(result.error);
    }
    allEdges.push(...result.data.edges);
    warnings.push(...result.data.warnings);
    baseMembers.push(...result.data.baseMembers);
  }

  return ok({
    // Edge endpoints are `(kind, id)` MergeKeys, so order them by the SAME id-first
    // `compareMergeKeys` clustering uses — not raw kind-first string order — so the one
    // canonical edge ordering holds across the pipeline for cross-kind/same-id pairs.
    edges: allEdges.sort((left, right) => {
      const byA = compareMergeKeys(left.a, right.a);
      return byA === 0 ? compareMergeKeys(left.b, right.b) : byA;
    }),
    warnings,
    // Total order over the composite `(kind, id)` identity (two same-id/different-kind
    // base members would tie under a bare-id compare).
    baseMembers: baseMembers.sort((left, right) =>
      compareMergeKeys(mergeKeyOf(left), mergeKeyOf(right)),
    ),
  });
}

/**
 * Builds, per cluster, the {@link ClusterMember} contributions. A staged new node
 * contributes one member per branch that staged it (so a cross-branch property
 * disagreement surfaces as a conflict in the union, T8); a committed BASE node the
 * cluster pulled in contributes one `origin: "base"` member, carrying the reserved
 * {@link BASE_PROVENANCE_BRANCH} so it gap-fills the property union and survivor
 * selection can enforce base-id-wins (§6.4-C).
 */
function clusterMembersFor(
  cluster: ClusterResult,
  newNodesById: ReadonlyMap<MergeKey, readonly StagedNewNode[]>,
  baseMembersById: ReadonlyMap<MergeKey, BaseMember>,
): readonly ClusterMember[] {
  const members: ClusterMember[] = [];
  for (const key of cluster.members) {
    for (const staged of newNodesById.get(key) ?? []) {
      members.push({
        origin: "staged",
        id: staged.node.id,
        kind: staged.node.kind,
        branchId: staged.branchId,
        props: staged.node.props as Readonly<Record<string, JsonValue>>,
      });
    }
    const base = baseMembersById.get(key);
    if (base !== undefined) {
      members.push({
        origin: "base",
        id: base.id,
        kind: base.kind,
        branchId: BASE_PROVENANCE_BRANCH,
        props: base.props,
      });
    }
  }
  return members;
}

/**
 * Indexes the staged new nodes by id (preserving the per-id branch list), so
 * clustering / canonicalization can pull every branch's contribution for a node.
 */
function indexNewNodesById(
  staging: StagingSet,
): ReadonlyMap<MergeKey, readonly StagedNewNode[]> {
  const index = new Map<MergeKey, StagedNewNode[]>();
  for (const items of staging.newNodesByKind.values()) {
    for (const staged of items) {
      const key = mergeKeyOf(staged.node);
      const bucket = index.get(key);
      if (bucket === undefined) {
        index.set(key, [staged]);
      } else {
        bucket.push(staged);
      }
    }
  }
  return index;
}

/**
 * Flattens the staged NEW edges plus the surviving inherited MODIFIED edges into
 * the {@link StagedEdge} shape the repoint phase (T9) consumes (parsed props +
 * branch tag). Inherited edges that were not modified by any branch are unchanged
 * in the base and need no re-commit, so only modified inherited edges are folded
 * in here alongside the new edges.
 */
function buildStagedEdges(staging: StagingSet): readonly StagedEdge[] {
  const staged: StagedEdge[] = [];
  for (const items of staging.newEdgesByKind.values()) {
    for (const item of items) {
      staged.push(toStagedEdge(item.branchId, item));
    }
  }
  for (const item of staging.modifiedEdges) {
    staged.push({
      id: item.edge.id,
      kind: item.edge.kind,
      fromId: item.edge.fromId,
      toId: item.edge.toId,
      fromKind: item.edge.fromKind,
      toKind: item.edge.toKind,
      props: item.edge.forkProps as Readonly<Record<string, JsonValue>>,
      branchId: item.branchId,
    });
  }
  return staged;
}

/** Projects a {@link StagedNewEdge} onto the repoint-phase {@link StagedEdge}. */
function toStagedEdge(branchId: BranchId, item: StagedNewEdge): StagedEdge {
  return {
    id: item.edge.id,
    kind: item.edge.kind,
    fromId: item.edge.fromId,
    toId: item.edge.toId,
    fromKind: item.edge.fromKind,
    toKind: item.edge.toKind,
    props: item.edge.props as Readonly<Record<string, JsonValue>>,
    branchId,
  };
}

/**
 * Builds the report-only, in-memory provenance index from the full record list.
 * `byBranch(id)` answers which merged node / edge ids that branch contributed to:
 * a node id when the branch staged a new node that survived into a cluster's
 * canonical (or a surviving modification), an edge id when the branch staged an
 * edge that survived the repoint/dedupe. Collapses the records — which ALSO carry
 * each contribution's `sourceId` for the persisted sidecar — to deduped, sorted id
 * sets per branch (the unchanged report-only shape).
 */
function buildProvenanceIndex(
  records: readonly ProvenanceRecord[],
): ProvenanceIndex {
  const byBranch = new Map<
    BranchId,
    Readonly<{ nodeIds: Set<AnyNodeId>; edgeIds: Set<string> }>
  >();
  for (const record of records) {
    let entry = byBranch.get(record.branchId);
    if (entry === undefined) {
      entry = { nodeIds: new Set(), edgeIds: new Set() };
      byBranch.set(record.branchId, entry);
    }
    if (record.role === "node") {
      entry.nodeIds.add(record.canonicalId as AnyNodeId);
    } else {
      entry.edgeIds.add(record.canonicalId);
    }
  }

  const frozen = new Map<BranchId, BranchProvenance>();
  for (const [branchId, sets] of byBranch) {
    frozen.set(branchId, {
      nodeIds: [...sets.nodeIds].sort((left, right) =>
        compareStrings(left, right),
      ),
      edgeIds: [...sets.edgeIds]
        .sort((left, right) => compareStrings(left, right))
        .map((id) => id as Edge["id"]),
    });
  }
  return {
    byBranch: (branchId: BranchId): BranchProvenance =>
      frozen.get(branchId) ?? { nodeIds: [], edgeIds: [] },
  };
}

/** Appends a branch's contribution of a CANONICAL node id (keeping its source). */
function pushNodeProvenance(
  records: ProvenanceRecord[],
  branchId: BranchId,
  canonicalId: AnyNodeId,
  canonicalKind: string,
  sourceId: string,
): void {
  records.push({
    role: "node",
    canonicalId: canonicalId,
    canonicalKind,
    branchId,
    sourceId,
  });
}

/** Appends a branch's contribution of a SURVIVING edge id (keeping its source). */
function pushEdgeProvenance(
  records: ProvenanceRecord[],
  branchId: BranchId,
  canonicalId: string,
  canonicalKind: string,
  sourceId: string,
): void {
  records.push({
    role: "edge",
    canonicalId,
    canonicalKind,
    branchId,
    sourceId,
  });
}

/**
 * Per-branch trust weights for the `"provenanceWeighted"` policy. P0 surfaces no
 * weight configuration on {@link MergeOptions}, so weights default to empty; the
 * policy then falls back to the stable branch order (its documented tie-break).
 */
const EMPTY_WEIGHTS: ProvenanceWeights = new Map<BranchId, number>();

/**
 * The fully-resolved (pre-commit) merge plan: everything the commit applies plus
 * everything the report records. Separated from the commit so the commit body is
 * a thin, mechanical application of an already-decided plan.
 *
 * Exported so the commit path can be unit-tested in isolation (e.g. proving that a
 * canonical entity whose id is an already-committed base node UPDATES that row and
 * repoints edges onto it, rather than inserting a duplicate — §6.2).
 */
export type MergePlan<G extends GraphDef> = Readonly<{
  canonicalEntities: readonly CanonicalEntity[];
  survivingModifications: readonly StagedModifiedNode[];
  nodeDeletions: ReadonlyMap<MergeKey, string>;
  mergedEdges: readonly MergedEdge[];
  retypeMap: ReadonlyMap<MergeKey, string>;
  resolutions: readonly EntityResolution[];
  propertyConflicts: readonly PropertyConflict<G>[];
  deleteModifyConflicts: readonly DeleteModifyConflict[];
  typeReconciliations: readonly TypeReconciliation[];
  dropped: readonly DroppedItem[];
  baseAmbiguities: readonly BaseAmbiguity[];
  provenanceRecords: readonly ProvenanceRecord[];
  warnings: readonly string[];
}>;

/**
 * Resolves the entire merge into a {@link MergePlan} WITHOUT touching the target.
 * Pure composition of the T3–T10 phases over the staged union; every step is
 * order-independent given the captured `branchRank`.
 */
function planMerge<G extends GraphDef>(
  staging: StagingSet,
  candidateEdges: readonly CandidateEdge[],
  candidateWarnings: readonly string[],
  baseMembers: readonly BaseMember[],
  options: NormalizedMergeOptions<G>,
  branchRank: ReadonlyMap<BranchId, number>,
  subClassClosure: ReturnType<typeof buildSubClassClosure>,
): MergePlan<G> {
  const provenanceRecords: ProvenanceRecord[] = [];

  // (4) cluster over every staged new-node id + every base member id (so a forced
  // new↔base edge is not dropped as out-of-scope, clustering.ts:134) + the
  // candidate edges. Base members come only from base sources, so this set is
  // exactly the staged universe under the public snapshot path.
  const newNodesById = indexNewNodesById(staging);
  // A base member only belongs in the cluster universe if it actually PARTICIPATES:
  // it got an ACCEPTED candidate edge to a staged node (a forced `baseUnique` edge, or a
  // `baseKey`/fuzzy pair that cleared the threshold), or it shares a key with a staged
  // node (a same-(kind, id) rediscovery, which joins by key without an edge). A `baseKey`
  // hit whose fuzzy pair was REJECTED below threshold would otherwise be seeded as a
  // singleton cluster and re-committed — rewriting an unrelated committed row, inflating
  // `merged.nodes`, and recording spurious provenance under the base sentinel. Drop those
  // orphans here, now that scoring has decided which pairs survived.
  const acceptedEndpointKeys = new Set<MergeKey>();
  for (const edge of candidateEdges) {
    acceptedEndpointKeys.add(edge.a);
    acceptedEndpointKeys.add(edge.b);
  }
  const baseMembersById = new Map<MergeKey, BaseMember>();
  for (const member of baseMembers) {
    const key = mergeKeyOf(member);
    if (acceptedEndpointKeys.has(key) || newNodesById.has(key)) {
      baseMembersById.set(key, member);
    }
  }
  const newNodeIds = [...newNodesById.keys(), ...baseMembersById.keys()];

  // (3b) ONTOLOGY RETYPE edges (T10 input): identity stays strictly `(kind, id)`, but
  // under `reconcileTypes: "ontology"` two STAGED-new nodes sharing a bare id with
  // subtype-compatible kinds are the same entity at a refined type, so they are forced
  // into one cluster for the reconciler to collapse. Same most-specific-common-kind
  // test the reconciler uses (so a set fuses here iff it would collapse later);
  // staged-only (base members excluded — a committed-base retype is an inherited
  // mutation v1 refuses); `"off"` emits nothing, leaving identity strictly `(kind,id)`.
  const isOntology = options.reconcileTypes === "ontology";
  const preferKind =
    isOntology ?
      (kinds: readonly string[]): string | undefined =>
        mostSpecificCommonKind(subClassClosure, kinds)
    : undefined;
  const clusterEdges =
    isOntology ?
      [
        ...candidateEdges,
        ...ontologyRetypeEdges(
          newNodesById.keys(),
          (kinds) =>
            mostSpecificCommonKind(subClassClosure, kinds) !== undefined,
        ),
      ]
    : candidateEdges;

  // (4) component-level BASE GUARD (§6.4-A) runs on the RAW components, BEFORE the
  // diameter split — so a diameter guard can never sever a base↔base bridge into
  // single-base pieces and leave the ambiguity unreported. The committed entities are
  // always kept separate (the collapse is refused; a deliberate collapse is deferred,
  // §6.4-C), then the optional diameter guard splits the base-contained clusters.
  const baseIds = new Set<MergeKey>(baseMembersById.keys());
  const guard = enforceBaseGuard(
    connectedComponents(clusterEdges, newNodeIds),
    clusterEdges,
    baseIds,
  );
  const clusters =
    options.clusterMaxDiameter === undefined ?
      guard.clusters
    : enforceDiameter(guard.clusters, clusterEdges, options.clusterMaxDiameter);
  // The guard keys on composite `(kind, id)` identities; the public BaseAmbiguity
  // carries them in full, so a component spanning two same-id/different-kind committed
  // entities stays distinguishable in the report.
  const baseAmbiguities: BaseAmbiguity[] = guard.events.map((event) => ({
    baseIds: event.baseIds.map((key) => ({ kind: kindOf(key), id: idOf(key) })),
    memberIds: event.memberIds.map((key) => ({
      kind: kindOf(key),
      id: idOf(key),
    })),
  }));

  // (5) canonicalize each cluster: min-id survivor + commutative prop union.
  const canonicalEntities: CanonicalEntity[] = [];
  const resolutions: EntityResolution[] = [];
  const propertyConflicts: PropertyConflict<G>[] = [];
  // (7-input) the distinct member kinds per cluster, collected here so a committed
  // BASE member's kind is part of type reconciliation — a base↔staged kind divergence
  // (e.g. base `Doctor` vs staged `SpecialistDoctor`) must be reconciled/flagged, not
  // dropped because base members live outside `newNodesById`.
  const reconcileInputs: ReconcileClusterInput[] = [];
  for (const cluster of clusters) {
    const members = clusterMembersFor(cluster, newNodesById, baseMembersById);
    if (members.length === 0) {
      continue;
    }
    const entity = canonicalizeCluster(
      cluster,
      members,
      options.onPropertyConflict as PropertyConflictPolicy,
      branchRank,
      EMPTY_WEIGHTS,
      options.canonical,
      options.onBasePropertyConflict as PropertyConflictPolicy,
      preferKind,
    );
    canonicalEntities.push(entity);
    reconcileInputs.push({
      canonicalId: mergeKey(entity.kind, entity.canonicalId),
      memberKinds: members.map((member) => member.kind),
    });
    // An EntityResolution records an actual MERGE — two or more distinct fork node
    // IDS collapsing into one canonical. Counted by distinct BARE id (not composite
    // identity): an ontology-retype cluster is several `(kind, id)` identities at ONE
    // id, which is a type reconciliation (recorded separately), not an id merge. A
    // singleton cluster records no resolution.
    const distinctMergedIds = new Set(
      cluster.members.map((member) => idOf(member)),
    );
    if (distinctMergedIds.size > 1) {
      resolutions.push(entity.resolution);
    }
    // Conflicts are recorded REGARDLESS of distinct-id count: two branches can
    // stage a new node under the SAME id with differing props, producing a genuine
    // cross-branch conflict inside a single-id cluster. `entity.conflicts` is
    // already gated by `resolved.conflicted`, so an agreeing single-member cluster
    // contributes none — but a real disagreement must not be silently auto-resolved
    // without a report entry.
    for (const conflict of entity.conflicts) {
      propertyConflicts.push(conflict as PropertyConflict<G>);
    }
    for (const member of members) {
      pushNodeProvenance(
        provenanceRecords,
        member.branchId,
        entity.canonicalId,
        entity.kind,
        member.id,
      );
    }
  }

  // (6) delete/modify resolution → authoritative final endpoint liveness.
  const deleteModify = resolveDeleteModify(
    staging,
    options.onDeleteModifyConflict,
    branchRank,
  );
  const nodeDeletions = new Map<MergeKey, string>();
  for (const deletion of deleteModify.nodeDeletions) {
    nodeDeletions.set(mergeKey(deletion.kind, deletion.id), deletion.kind);
  }
  for (const modification of deleteModify.survivingModifications) {
    pushNodeProvenance(
      provenanceRecords,
      modification.branchId,
      modification.node.id,
      modification.node.kind,
      modification.node.id,
    );
  }

  // Reconcile inherited nodes modified by 2+ branches into one merged record per
  // id (3-way against base), surfacing genuine disagreements as PropertyConflicts
  // instead of silently letting the last-committed branch win. Provenance above
  // already credited every contributing branch.
  const reconciledModifications = reconcileModifications(
    deleteModify.survivingModifications,
    options.onPropertyConflict as PropertyConflictPolicy,
    branchRank,
    EMPTY_WEIGHTS,
  );
  for (const conflict of reconciledModifications.conflicts) {
    propertyConflicts.push(conflict as PropertyConflict<G>);
  }

  // (7) opt-in ontology type reconciliation over the public-closure glue. Inputs
  // (incl. base member kinds) were collected per cluster in the canonicalize loop.
  const reconciliation = reconcileTypes(
    reconcileInputs,
    subClassClosure,
    options.reconcileTypes,
  );

  // (8) repoint every staged edge onto its cluster canonical + dedupe.
  const canonicalOf = buildCanonicalMap(clusters, (cluster) =>
    pickClusterCanonical(cluster, canonicalEntities),
  );
  const stagedEdges = buildStagedEdges(staging);
  // An edge id can be staged by MORE THAN ONE branch (e.g. an inherited edge
  // modified by two branches), so map each id to the SET of contributing branches.
  // A plain last-write Map would credit only one branch's provenance.
  const stagedEdgeBranches = new Map<string, Set<BranchId>>();
  for (const staged of stagedEdges) {
    const branches = stagedEdgeBranches.get(staged.id);
    if (branches === undefined) {
      stagedEdgeBranches.set(staged.id, new Set([staged.branchId]));
    } else {
      branches.add(staged.branchId);
    }
  }
  const deletedNodeIdSet = new Set<MergeKey>(nodeDeletions.keys());
  const repoint = repointEdges<G>(
    stagedEdges,
    canonicalOf,
    deletedNodeIdSet,
    options.onPropertyConflict,
    branchRank,
    EMPTY_WEIGHTS,
  );
  for (const merged of repoint.edges) {
    for (const sourceId of merged.mergedIds) {
      for (const branchId of stagedEdgeBranches.get(sourceId) ?? []) {
        pushEdgeProvenance(
          provenanceRecords,
          branchId,
          merged.id,
          merged.kind,
          sourceId,
        );
      }
    }
  }

  const dropped: DroppedItem[] = [
    ...deleteModify.dropped,
    ...repoint.dropped,
    ...reconciliation.dropped,
  ].sort((left, right) =>
    compareStrings(`${left.kind}|${left.id}`, `${right.kind}|${right.id}`),
  );

  return {
    canonicalEntities,
    survivingModifications: reconciledModifications.survivingModifications,
    nodeDeletions,
    mergedEdges: repoint.edges,
    retypeMap: reconciliation.retypeMap,
    resolutions: resolutions.sort((left, right) =>
      compareStrings(left.canonicalId, right.canonicalId),
    ),
    propertyConflicts: [...propertyConflicts, ...repoint.conflicts].sort(
      (left, right) =>
        compareStrings(
          `${left.entityId}|${left.property}`,
          `${right.entityId}|${right.property}`,
        ),
    ),
    deleteModifyConflicts: deleteModify.conflicts,
    typeReconciliations: reconciliation.reconciliations,
    dropped,
    baseAmbiguities: baseAmbiguities.sort((left, right) =>
      compareMergeKeys(
        mergeKey(left.baseIds[0]!.kind, left.baseIds[0]!.id),
        mergeKey(right.baseIds[0]!.kind, right.baseIds[0]!.id),
      ),
    ),
    provenanceRecords,
    warnings: candidateWarnings,
  };
}

/**
 * The canonical survivor identity of a cluster, taken DIRECTLY from its already-resolved
 * {@link CanonicalEntity} so edge repoint reuses the exact survivor `canonicalizeCluster`
 * chose (base-id-wins, the `options.canonical` hook, and the most-specific-kind pick all
 * already applied there). This is the SINGLE survivor-selection point: re-deriving it
 * here by a second rule could split the canonical between the node write and the edge
 * repoint, so this never re-runs the hook.
 *
 * Every non-empty cluster yields exactly one canonical entity whose `(kind, id)` is one
 * of its members (the survivor is always a cluster member), so the lookup always hits;
 * a miss is an internal invariant violation, not a fallback.
 */
function pickClusterCanonical(
  cluster: ClusterResult,
  entities: readonly CanonicalEntity[],
): MergeKey {
  const memberSet = new Set(cluster.members);
  for (const entity of entities) {
    const key = mergeKey(entity.kind, entity.canonicalId);
    if (memberSet.has(key)) {
      return key;
    }
  }
  throw new MergeError(
    "Internal invariant: cluster has no canonical entity in pickClusterCanonical.",
    { details: { members: cluster.members.map(idOf) } },
  );
}

/**
 * Applies a resolved {@link MergePlan} to the target via the typed transaction
 * collection API. Surviving inherited modifications are upserted by id, canonical
 * cluster nodes are upserted by id with their unioned + (optionally) retyped
 * props, finally-deleted nodes are soft-deleted, and repointed/deduped edges are
 * upserted by id. Returns the merged node / edge counts.
 *
 * UPDATE-NOT-INSERT (§6.2): every node write is an `upsertById`, so a canonical
 * entity whose id is an ALREADY-COMMITTED base node UPDATES that committed row in
 * place — the committed identity is stable and every edge repointed onto it (the
 * merged edges already carry the canonical endpoint) attaches to the surviving
 * row, never a duplicate insert. This is what lets a base member be the canonical
 * survivor once base sources land. Exported for isolated commit-path testing.
 */
export async function commitPlan<G extends GraphDef>(
  target: Store<G>,
  plan: MergePlan<G>,
): Promise<Readonly<{ nodes: number; edges: number }>> {
  const apply = async (
    nodesApi: TxNodes,
    edgesApi: TxEdges,
  ): Promise<Readonly<{ nodes: number; edges: number }>> => {
    // Counted by composite `(kind, id)` identity, so two different-kind nodes that
    // share an id string each count once (and never collide in the dedupe set).
    const committedNodeIds = new Set<MergeKey>();

    // Surviving inherited modifications (excluding any node finally deleted).
    for (const modification of plan.survivingModifications) {
      if (plan.nodeDeletions.has(mergeKeyOf(modification.node))) {
        continue;
      }
      const collection = nodeCollection(nodesApi, modification.node.kind);
      await collection.upsertByIdFromRecord(
        modification.node.id,
        modification.node.forkProps,
      );
      committedNodeIds.add(mergeKeyOf(modification.node));
    }

    // New canonical cluster nodes (min-id survivors), with retype cascade.
    for (const entity of plan.canonicalEntities) {
      const identity = mergeKey(entity.kind, entity.canonicalId);
      if (plan.nodeDeletions.has(identity)) {
        continue;
      }
      const kind = plan.retypeMap.get(identity) ?? entity.kind;
      const collection = nodeCollection(nodesApi, kind);
      await collection.upsertByIdFromRecord(
        entity.canonicalId,
        entity.props,
      );
      committedNodeIds.add(mergeKey(kind, entity.canonicalId));
    }

    // Soft-delete every finally-deleted node (key encodes the kind; the value
    // repeats it for the collection lookup).
    for (const [identity, kind] of plan.nodeDeletions) {
      const collection = nodeCollection(nodesApi, kind);
      await collection.delete(idOf(identity));
    }

    // Repointed + deduped edges, upserted by their surviving id. The retype cascade
    // keys on each endpoint's full `(kind, id)` identity.
    let committedEdges = 0;
    for (const edge of plan.mergedEdges) {
      const kind = plan.retypeMap.get(mergeKey(edge.fromKind, edge.fromId));
      const toKind = plan.retypeMap.get(mergeKey(edge.toKind, edge.toId));
      const collection = edgeCollection(edgesApi, edge.kind);
      await collection.bulkUpsertById([
        {
          id: edge.id,
          from: { kind: kind ?? edge.fromKind, id: edge.fromId },
          to: { kind: toKind ?? edge.toKind, id: edge.toId },
          props: edge.props,
        },
      ]);
      committedEdges += 1;
    }

    return { nodes: committedNodeIds.size, edges: committedEdges };
  };

  if (target.backend.capabilities.transactions) {
    return target.transaction((tx) =>
      apply(tx.nodes as unknown as TxNodes, tx.edges as unknown as TxEdges),
    );
  }
  // Non-transactional fallback (out of the P0 acceptance path): apply directly.
  return apply(
    target.nodes as unknown as TxNodes,
    target.edges as unknown as TxEdges,
  );
}

/**
 * Runtime-keyed view of the transaction's node collections. The typed
 * `tx.nodes` is keyed by the graph's concrete kinds; the orchestrator dispatches
 * on kind STRINGS, so it indexes through this widened record. Each entry exposes
 * the subset of the collection API the commit uses.
 */
type TxNodes = Record<string, NodeCollectionLike>;

/** Runtime-keyed view of the transaction's edge collections. See {@link TxNodes}. */
type TxEdges = Record<string, EdgeCollectionLike>;

/** The node-collection surface the commit uses (runtime, kind-string keyed). */
type NodeCollectionLike = Readonly<{
  getById: (
    id: string,
    options?: Readonly<{ temporalMode?: "includeTombstones" }>,
  ) => Promise<Node | undefined>;
  bulkCreate: (
    items: readonly Readonly<{
      id?: string;
      props: Record<string, unknown>;
    }>[],
  ) => Promise<unknown>;
  update: (id: string, props: Record<string, unknown>) => Promise<unknown>;
  upsertByIdFromRecord: (
    id: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  delete: (id: string) => Promise<void>;
}>;

/** The edge-collection surface the commit uses (runtime, kind-string keyed). */
type EdgeCollectionLike = Readonly<{
  getById: (
    id: string,
    options?: Readonly<{ temporalMode?: "includeTombstones" }>,
  ) => Promise<Edge | undefined>;
  bulkCreate: (
    items: readonly Readonly<{
      id?: string;
      from: Readonly<{ kind: string; id: string }>;
      to: Readonly<{ kind: string; id: string }>;
      props?: Record<string, unknown>;
    }>[],
  ) => Promise<unknown>;
  bulkUpsertById: (
    items: readonly Readonly<{
      id: string;
      from: Readonly<{ kind: string; id: string }>;
      to: Readonly<{ kind: string; id: string }>;
      props?: Record<string, unknown>;
    }>[],
  ) => Promise<unknown>;
}>;

/** Resolves a node collection by kind, failing loudly on an unknown kind. */
function nodeCollection(nodes: TxNodes, kind: string): NodeCollectionLike {
  const collection = nodes[kind];
  if (collection === undefined) {
    throw new MergeError(`No node collection for kind "${kind}".`, {
      details: { kind },
    });
  }
  return collection;
}

/** Resolves an edge collection by kind, failing loudly on an unknown kind. */
function edgeCollection(edges: TxEdges, kind: string): EdgeCollectionLike {
  const collection = edges[kind];
  if (collection === undefined) {
    throw new MergeError(`No edge collection for kind "${kind}".`, {
      details: { kind },
    });
  }
  return collection;
}

/**
 * Validates the `base@V` precondition: every branch's `base` token MUST equal the
 * target's current base version. A mismatch means the branch forked from a
 * divergent schema or content fingerprint, which cannot be merged safely.
 */
async function validateBaseVersions<G extends GraphDef>(
  target: Store<G>,
  branches: readonly GraphBranch<G>[],
): Promise<Result<undefined, BaseVersionMismatchError>> {
  const targetVersion = await computeBaseVersion(target);
  for (const branch of branches) {
    if (branch.base !== targetVersion) {
      return err(
        new BaseVersionMismatchError(
          `Branch "${branch.id}" forked from base@V "${branch.base}", which does not match the merge target's current base@V "${targetVersion}".`,
          {
            details: {
              branchId: branch.id,
              branchBase: branch.base,
              targetBase: targetVersion,
            },
          },
        ),
      );
    }
  }
  return ok();
}

/** Normalizes options, converting an invalid-option throw into a typed result. */
function tryNormalize<G extends GraphDef>(
  optionsInput: MergeOptions<G>,
): Result<NormalizedMergeOptions<G>, MergeError> {
  try {
    return ok(normalizeMergeOptions(optionsInput));
  } catch (error) {
    return err(new MergeError("Invalid merge options.", { cause: error }));
  }
}

/**
 * The shared resolve→commit→report pipeline behind both `merge()` (snapshot,
 * staged-vs-staged) and `mergeAgainstBase()` (synthetic new-vs-base). It stages the
 * union of branch diffs, generates candidates (with or without the base sources per
 * `useBaseSources`), resolves the plan, commits, and assembles the report. The
 * `base@V` precondition is the CALLER's responsibility — `merge()` enforces it,
 * the synthetic scope deliberately bypasses it (§6.4-B).
 */
async function resolveMerge<G extends GraphDef>(
  store: Store<G>,
  target: Store<G>,
  branches: readonly GraphBranch<G>[],
  options: NormalizedMergeOptions<G>,
  useBaseSources: boolean,
  incremental?: IncrementalConfig,
): Promise<Result<MergeReport<G>, MergeError>> {
  // The base-provenance sentinel is a reserved BranchId: a real branch minting it
  // would collide with committed-base contributions in the property union and
  // provenance. Reject it at the boundary rather than silently corrupting the merge.
  for (const branch of branches) {
    if (branch.id === BASE_PROVENANCE_BRANCH) {
      return err(
        new MergeError(
          `Branch id "${BASE_PROVENANCE_BRANCH}" is reserved for committed-base provenance and cannot be used as a branch id.`,
          { details: { branchId: branch.id } },
        ),
      );
    }
  }

  try {
    // (2) stage the provenance-tagged union of every branch's diff.
    let staging = await stageBranches(store, branches);

    // Incremental (additive, §6.6): the fork-point diff identifies branch ADDITIONS
    // only — inherited modify/delete are refused (or stripped + reported) BEFORE
    // planning, so a stale fork-point write can never clobber a newer target row.
    const incrementalWarnings: string[] = [];
    if (incremental !== undefined) {
      const additive = stripInheritedMutations(
        staging,
        incremental.onInheritedMutation,
      );
      if (isErr(additive)) {
        return err(additive.error);
      }
      staging = additive.data.staging;
      incrementalWarnings.push(...additive.data.warnings);
    }

    // Capture the stable branch order ONCE (never wall-clock).
    const branchIds = branches.map((branch) => branch.id);
    const branchRank = buildBranchRank(options.branchOrder ?? [], branchIds);

    // Introspection snapshot: unique constraints for blocking + ontology closure.
    const introspection = store.introspect();
    const introspectionKinds = new Map<
      string,
      readonly UniqueIntrospection[]
    >();
    for (const kind of introspection.kinds) {
      introspectionKinds.set(kind.name, kind.unique);
    }
    const subClassClosure = buildSubClassClosure(introspection.ontology);

    // (3) candidate generation across every resolved kind. When an embedder is
    // configured, precompute the staged texts' vectors ONCE (the only async,
    // batched step) so the per-pair `vector`/`hybrid` scoring is a pure in-memory
    // cosine. With no embedder, `embeddings` stays absent and a vector/hybrid kind
    // surfaces SimilarityUnavailableError in candidate generation.
    const embeddings =
      options.embedder === undefined ?
        undefined
      : await precomputeEmbeddings(
          newNodesByKind(staging),
          options.resolve,
          options.embedder,
        );
    const ctx: SimilarityContext = {
      backend: store.backend,
      ...(embeddings === undefined ? {} : { embeddings }),
    };
    const candidates = await generateAllCandidates(
      target,
      staging,
      options,
      introspectionKinds,
      ctx,
      useBaseSources,
    );
    if (isErr(candidates)) {
      return err(candidates.error);
    }

    // (4–8) resolve the whole merge into a commit-ready plan.
    const plan = planMerge(
      staging,
      candidates.data.edges,
      candidates.data.warnings,
      candidates.data.baseMembers,
      options,
      branchRank,
      subClassClosure,
    );

    // (9) commit to the target. Incremental mode commits through the guarded path
    // (the existing-target-id write guard, §6.6); snapshot mode commits directly.
    const merged =
      incremental === undefined ?
        await commitPlan(target, plan)
      : await commitIncrementalPlan(
          target,
          plan,
          new Set(
            candidates.data.baseMembers.map((member) =>
              mergeKey(member.kind, member.id),
            ),
          ),
        );

    // (10) assemble the report. The full provenance records are always built in the
    // plan; the in-memory index is gated by `provenance`, and on-graph persistence
    // by `persistProvenance`.
    const provenance: ProvenanceIndex =
      options.provenance ?
        buildProvenanceIndex(plan.provenanceRecords)
      : { byBranch: () => ({ nodeIds: [], edgeIds: [] }) };

    const warnings = [...plan.warnings, ...incrementalWarnings];
    let provenancePersisted: MergeReport<G>["provenancePersisted"];
    if (options.persistProvenance) {
      // POST-COMMIT, best-effort: the graph is already committed, so a provenance
      // write failure must NOT fail the merge — it surfaces as a warning. The
      // sidecar node ids are deterministic, so this UPSERTS (idempotent re-runs).
      try {
        const provenanceStore = await openProvenanceStore(
          target.backend,
          target.graphId,
        );
        const count = await persistProvenanceRecords(
          provenanceStore,
          target.graphId,
          plan.provenanceRecords,
        );
        provenancePersisted = {
          graphId: provenanceGraphId(target.graphId),
          count,
        };
      } catch (error) {
        warnings.push(
          "provenance persistence failed (graph committed; provenance not persisted): " +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    const report: MergeReport<G> = {
      merged,
      resolutions: plan.resolutions,
      conflicts: plan.propertyConflicts,
      deleteModifyConflicts: plan.deleteModifyConflicts,
      typeReconciliations: plan.typeReconciliations,
      dropped: plan.dropped,
      baseAmbiguities: plan.baseAmbiguities,
      provenance,
      warnings,
      ...(provenancePersisted === undefined ? {} : { provenancePersisted }),
    };
    return ok(report);
  } catch (error) {
    // A typed MergeError thrown deeper (e.g. the incremental guard's stale-overwrite
    // refusal) carries its own precise message — surface it directly rather than
    // masking it behind the generic wrapper, which is reserved for opaque failures
    // (a backend error, a malformed row).
    if (error instanceof MergeError) {
      return err(error);
    }
    return err(
      new MergeError(
        `Merge failed while staging or committing: ${describeCause(error)}`,
        { cause: error },
      ),
    );
  }
}

/**
 * Merges a set of branches back into a target store (design §7.2).
 *
 * Validates that every branch forked from the target's current `base@V`, stages
 * the union of their diffs, resolves entities / conflicts / types through the
 * T3–T10 phases, and commits the merged result to `target` (default: the base
 * `store`) in a single transaction. Returns a {@link MergeReport} on success.
 *
 * This is the SNAPSHOT entry point: candidate generation runs the staged sources
 * only (`exactKey`, `unique`) — it never resolves a staged node against the
 * committed base. New-vs-base resolution is the separate {@link mergeAgainstBase}
 * scope, which has a weaker `base@V` contract.
 *
 * Errors are RETURNED (never thrown) as a typed {@link MergeError} subclass:
 * `BaseVersionMismatchError` for the precondition, `MergeError` for a
 * comparison-ceiling overrun / commit failure, `SimilarityUnavailableError` for a
 * `vector`/`hybrid` strategy with no configured vector strategy.
 *
 * @param store The base store the branches forked from. Used as the default merge
 *   target and as the immutable diff reference.
 * @param branches The branches to merge. ORDER DOES NOT AFFECT THE RESULT — the
 *   report and committed graph are identical across any permutation.
 * @param optionsInput Caller-facing {@link MergeOptions}; normalized internally.
 */
export async function merge<G extends GraphDef>(
  store: Store<G>,
  branches: readonly GraphBranch<G>[],
  optionsInput: MergeOptions<G> = {},
): Promise<Result<MergeReport<G>, MergeError>> {
  const normalized = tryNormalize(optionsInput);
  if (isErr(normalized)) {
    return err(normalized.error);
  }
  const options = normalized.data;
  const target = options.target ?? store;

  // (1) base@V precondition — the snapshot contract.
  const precondition = await validateBaseVersions(target, branches);
  if (isErr(precondition)) {
    return err(precondition.error);
  }

  return resolveMerge(store, target, branches, options, false);
}

/**
 * SYNTHETIC new-vs-base merge scope (design §8 "Slice 1"). Runs the full
 * candidate-source + scoring + reconciler pipeline WITH the base sources active —
 * so a staged node re-discovering a committed entity resolves against it
 * (base-id-wins, update-not-insert) — while DELIBERATELY bypassing the `base@V`
 * snapshot precondition (§6.4-B) rather than fighting it.
 *
 * This is the lower-level scope the slice's mechanism is built and exercised behind
 * (the fixed-point + determinism gates drive it directly), and it is intentionally
 * NOT re-exported from the package barrel. The public additive surface over it is
 * {@link mergeIncremental} (§6.6), which adds the fork-point precondition, the
 * keep-base pin, the additive (no inherited modify/delete) restriction, and the
 * existing-target-id write guard. `merge()` and its snapshot precondition are
 * unchanged; the deferred lineage model (§9) is only needed to propagate inherited
 * edits, which `mergeIncremental()` v1 refuses.
 */
export async function mergeAgainstBase<G extends GraphDef>(
  store: Store<G>,
  branches: readonly GraphBranch<G>[],
  optionsInput: MergeOptions<G> = {},
): Promise<Result<MergeReport<G>, MergeError>> {
  const normalized = tryNormalize(optionsInput);
  if (isErr(normalized)) {
    return err(normalized.error);
  }
  const options = normalized.data;
  const target = options.target ?? store;
  return resolveMerge(store, target, branches, options, true);
}

// --- mergeIncremental: additive new-vs-base public entry point (§6.6) ----------

/** Internal config carried into {@link resolveMerge} for additive incremental mode. */
type IncrementalConfig = Readonly<{
  onInheritedMutation: InheritedMutationPolicy;
}>;

/**
 * Refuses or strips the INHERITED mutations of an incremental staging set (§6.6). v1
 * is additive: only branch ADDITIONS are committed. A fork-point diff against a moved
 * target classifies "live in fork-point, absent in branch" as a delete and a changed
 * inherited prop as a modify — both of which `commitPlan` would apply as a STALE
 * write over a newer target row (`upsertByIdFromRecord` / `delete`). So they are
 * refused (`"error"`) or dropped and reported (`"skipWithReport"`) BEFORE planning,
 * never silently ignored.
 */
function stripInheritedMutations(
  staging: StagingSet,
  policy: InheritedMutationPolicy,
): Result<
  Readonly<{ staging: StagingSet; warnings: readonly string[] }>,
  MergeError
> {
  const counts = {
    modifiedNodes: staging.modifiedNodes.length,
    deletedNodes: staging.deletedNodes.length,
    modifiedEdges: staging.modifiedEdges.length,
    deletedEdges: staging.deletedEdges.length,
  };
  const total =
    counts.modifiedNodes +
    counts.deletedNodes +
    counts.modifiedEdges +
    counts.deletedEdges;
  if (total === 0) {
    return ok({ staging, warnings: [] });
  }
  const summary = `${counts.modifiedNodes} modified node(s), ${counts.deletedNodes} deleted node(s), ${counts.modifiedEdges} modified edge(s), ${counts.deletedEdges} deleted edge(s)`;
  if (policy === "error") {
    return err(
      new MergeError(
        `mergeIncremental() is additive (v1) and does not propagate inherited mutations: ${summary}. Set onInheritedMutation: "skipWithReport" to drop them, or use the deferred lineage model for inherited-edit propagation.`,
        { details: counts },
      ),
    );
  }
  return ok({
    staging: {
      ...staging,
      modifiedNodes: [],
      deletedNodes: [],
      modifiedEdges: [],
      deletedEdges: [],
    },
    warnings: [
      `mergeIncremental(): dropped inherited mutations unsupported in additive v1 (${summary}).`,
    ],
  });
}

/**
 * Incremental precondition: every branch must have forked from THIS fork-point, so
 * the additive diff (fork-point → branch) is honest. The analogue of
 * {@link validateBaseVersions}, repointed from `target` to `forkPoint` (§6.6).
 */
async function validateForkPointVersions<G extends GraphDef>(
  forkPoint: Store<G>,
  branches: readonly GraphBranch<G>[],
): Promise<Result<undefined, BaseVersionMismatchError>> {
  const forkVersion = await computeBaseVersion(forkPoint);
  for (const branch of branches) {
    if (branch.base !== forkVersion) {
      return err(
        new BaseVersionMismatchError(
          `Branch "${branch.id}" forked from base@V "${branch.base}", which does not match the fork-point's base@V "${forkVersion}". mergeIncremental() requires every branch to have forked from the supplied forkPoint.`,
          {
            details: {
              branchId: branch.id,
              branchBase: branch.base,
              forkPointBase: forkVersion,
            },
          },
        ),
      );
    }
  }
  return ok();
}

/**
 * The minimal schema surface the write guards need: a kind's Zod schema, called the
 * SAME way the commit calls it (`safeParse`). Structural so the guard couples to the
 * parse behaviour, not a zod version.
 */
type PropsSchema = Readonly<{
  safeParse: (
    value: unknown,
  ) => { success: true; data: unknown } | { success: false };
}>;

type RevalidatingWriteAnalysis =
  | Readonly<{
      status: "valid";
      /** Whether TypeGraph's re-validating write would change persisted bytes. */
      storageWouldChange: boolean;
      /** Whether declared schema fields would change, ignoring unknown stored keys. */
      schemaWouldChange: boolean;
      /** Whether the write would drop current props not preserved by the schema. */
      stripsCurrentProps: boolean;
    }>
  | Readonly<{ status: "invalid" }>;

/** The declared schema for a node kind off the public `GraphDef` registry (or none). */
function nodeSchemaFor<G extends GraphDef>(
  target: Store<G>,
  kind: string,
): PropsSchema | undefined {
  const registry = target.graph.nodes as Record<
    string,
    Readonly<{ type?: Readonly<{ schema?: PropsSchema }> }> | undefined
  >;
  return registry[kind]?.type?.schema;
}

/** The declared schema for an edge kind off the public `GraphDef` registry (or none). */
function edgeSchemaFor<G extends GraphDef>(
  target: Store<G>,
  kind: string,
): PropsSchema | undefined {
  const registry = target.graph.edges as Record<
    string,
    Readonly<{ type?: Readonly<{ schema?: PropsSchema }> }> | undefined
  >;
  return registry[kind]?.type?.schema;
}

/**
 * Models TypeGraph's re-validating update semantics for one row:
 * `schema.safeParse({...current, ...planned})`, then storing the parsed result. This
 * is NOT used as a pre-transaction write guard anymore; `mergeIncremental()` calls it
 * inside the target transaction to decide between create/update/skip/error.
 */
function analyzeRevalidatingWrite(
  schema: PropsSchema | undefined,
  current: Readonly<Record<string, unknown>>,
  planned: Readonly<Record<string, unknown>>,
): RevalidatingWriteAnalysis {
  const merged = { ...current, ...planned };
  if (schema === undefined) {
    const storageWouldChange =
      canonicalizeProps(merged) !== canonicalizeProps(current);
    return {
      status: "valid",
      storageWouldChange,
      schemaWouldChange: storageWouldChange,
      stripsCurrentProps: false,
    };
  }

  const currentParsed = schema.safeParse(current);
  const mergedParsed = schema.safeParse(merged);
  if (!currentParsed.success || !mergedParsed.success) {
    return { status: "invalid" };
  }
  const normalizedCurrent = currentParsed.data as Record<string, unknown>;
  const normalizedMerged = mergedParsed.data as Record<string, unknown>;
  return {
    status: "valid",
    storageWouldChange:
      canonicalizeProps(normalizedMerged) !== canonicalizeProps(current),
    schemaWouldChange:
      canonicalizeProps(normalizedMerged) !==
      canonicalizeProps(normalizedCurrent),
    stripsCurrentProps:
      canonicalizeProps(normalizedCurrent) !== canonicalizeProps(current),
  };
}

export function writeWouldChangeRow(
  schema: PropsSchema | undefined,
  committed: Readonly<Record<string, unknown>>,
  planned: Readonly<Record<string, unknown>>,
): boolean {
  const analysis = analyzeRevalidatingWrite(schema, committed, planned);
  return analysis.status === "valid" ? analysis.storageWouldChange : false;
}

/**
 * Public node objects spread props at top-level. Strip TypeGraph structural keys so
 * write comparisons operate on the persisted props bag only.
 */
function nodeProps(node: Node): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "id" || key === "kind" || key === "meta") continue;
    props[key] = value;
  }
  return props;
}

/**
 * Public edge objects spread props at top-level. Strip TypeGraph structural keys so
 * write comparisons operate on the persisted props bag only.
 */
function edgeProps(edge: Edge): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(edge)) {
    if (
      key === "id" ||
      key === "kind" ||
      key === "fromKind" ||
      key === "fromId" ||
      key === "toKind" ||
      key === "toId" ||
      key === "meta"
    ) {
      continue;
    }
    props[key] = value;
  }
  return props;
}

const INCLUDE_TOMBSTONES = { temporalMode: "includeTombstones" as const };

async function existingEdgeById(
  edgesApi: TxEdges,
  edgeKinds: readonly string[],
  id: string,
): Promise<Edge | undefined> {
  for (const kind of edgeKinds) {
    const edge = await edgeCollection(edgesApi, kind).getById(
      id,
      INCLUDE_TOMBSTONES,
    );
    if (edge !== undefined) return edge;
  }
  return undefined;
}

function finalEdgeFrom<G extends GraphDef>(
  edge: MergedEdge,
  plan: MergePlan<G>,
) {
  return {
    kind:
      plan.retypeMap.get(mergeKey(edge.fromKind, edge.fromId)) ?? edge.fromKind,
    id: edge.fromId,
  };
}

function finalEdgeTo<G extends GraphDef>(edge: MergedEdge, plan: MergePlan<G>) {
  return {
    kind: plan.retypeMap.get(mergeKey(edge.toKind, edge.toId)) ?? edge.toKind,
    id: edge.toId,
  };
}

function assertValidRevalidatingWrite(
  analysis: RevalidatingWriteAnalysis,
  message: string,
  details: Record<string, unknown>,
): asserts analysis is Extract<RevalidatingWriteAnalysis, { status: "valid" }> {
  if (analysis.status === "invalid") {
    throw new MergeError(message, { details });
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function applyIncrementalNodes<G extends GraphDef>(
  target: Store<G>,
  nodesApi: TxNodes,
  plan: MergePlan<G>,
  baseMemberKeys: ReadonlySet<MergeKey>,
): Promise<number> {
  const toCreate = new Map<
    string,
    Readonly<{ id: string; props: Record<string, unknown> }>[]
  >();
  const committedNodeIds = new Set<MergeKey>();

  for (const entity of plan.canonicalEntities) {
    const identity = mergeKey(entity.kind, entity.canonicalId);
    if (plan.nodeDeletions.has(identity)) continue;

    const writeKind = plan.retypeMap.get(identity) ?? entity.kind;
    if (baseMemberKeys.has(identity)) {
      if (writeKind !== entity.kind) {
        throw new MergeError(
          `mergeIncremental() would retype committed base node "${entity.canonicalId}" from kind "${entity.kind}" to "${writeKind}". Additive v1 does not change a committed node's kind; use the deferred lineage model for inherited-edit propagation.`,
          {
            details: {
              id: entity.canonicalId,
              fromKind: entity.kind,
              toKind: writeKind,
            },
          },
        );
      }

      const collection = nodeCollection(nodesApi, entity.kind);
      const current = await collection.getById(
        entity.canonicalId,
        INCLUDE_TOMBSTONES,
      );
      if (current === undefined || current.meta.deletedAt !== undefined) {
        throw new MergeError(
          `mergeIncremental() lost committed base node "${entity.canonicalId}" (kind "${entity.kind}") before commit. Additive v1 refuses to recreate or resurrect a base member.`,
          { details: { id: entity.canonicalId, kind: entity.kind } },
        );
      }

      const analysis = analyzeRevalidatingWrite(
        nodeSchemaFor(target, entity.kind),
        nodeProps(current),
        entity.props,
      );
      assertValidRevalidatingWrite(
        analysis,
        `mergeIncremental() cannot safely update committed base node "${entity.canonicalId}" (kind "${entity.kind}") because its current props no longer validate against the active schema.`,
        { id: entity.canonicalId, kind: entity.kind },
      );
      if (!analysis.schemaWouldChange) {
        committedNodeIds.add(identity);
        continue;
      }
      if (analysis.stripsCurrentProps) {
        throw new MergeError(
          `mergeIncremental() would update committed base node "${entity.canonicalId}" (kind "${entity.kind}") but the write would strip existing props outside the active schema. Additive v1 refuses that lossy base update.`,
          { details: { id: entity.canonicalId, kind: entity.kind } },
        );
      }
      await collection.update(entity.canonicalId, entity.props);
      committedNodeIds.add(identity);
      continue;
    }

    const collection = nodeCollection(nodesApi, writeKind);
    const current = await collection.getById(
      entity.canonicalId,
      INCLUDE_TOMBSTONES,
    );
    if (current !== undefined) {
      if (current.meta.deletedAt !== undefined) {
        throw new MergeError(
          `mergeIncremental() would resurrect soft-deleted committed node "${entity.canonicalId}" (kind "${writeKind}"). Additive v1 refuses to revive a committed deletion.`,
          { details: { id: entity.canonicalId, kind: writeKind } },
        );
      }
      const analysis = analyzeRevalidatingWrite(
        nodeSchemaFor(target, writeKind),
        nodeProps(current),
        entity.props,
      );
      assertValidRevalidatingWrite(
        analysis,
        `mergeIncremental() found an existing committed node "${entity.canonicalId}" (kind "${writeKind}") whose current props do not validate against the active schema. Additive v1 cannot treat it as an idempotent re-run.`,
        { id: entity.canonicalId, kind: writeKind },
      );
      if (analysis.storageWouldChange) {
        throw new MergeError(
          `mergeIncremental() would overwrite committed node "${entity.canonicalId}" (kind "${writeKind}") that the branch did not resolve onto via new-vs-base. Additive v1 refuses a stale-overwrite of a committed row.`,
          { details: { id: entity.canonicalId, kind: writeKind } },
        );
      }
      committedNodeIds.add(mergeKey(writeKind, entity.canonicalId));
      continue;
    }

    const bucket = toCreate.get(writeKind) ?? [];
    bucket.push({ id: entity.canonicalId, props: entity.props });
    toCreate.set(writeKind, bucket);
    committedNodeIds.add(mergeKey(writeKind, entity.canonicalId));
  }

  for (const [kind, items] of toCreate) {
    await nodeCollection(nodesApi, kind).bulkCreate(items);
  }
  return committedNodeIds.size;
}

async function applyIncrementalEdges<G extends GraphDef>(
  target: Store<G>,
  edgesApi: TxEdges,
  plan: MergePlan<G>,
): Promise<number> {
  const edgeKinds = Object.keys(target.graph.edges).sort((left, right) =>
    compareStrings(left, right),
  );
  const toCreate = new Map<
    string,
    Readonly<{
        id: string;
        from: Readonly<{ kind: string; id: string }>;
        to: Readonly<{ kind: string; id: string }>;
        props: Record<string, unknown>;
      }>[]
  >();

  for (const edge of plan.mergedEdges) {
    const from = finalEdgeFrom(edge, plan);
    const to = finalEdgeTo(edge, plan);
    const current = await existingEdgeById(edgesApi, edgeKinds, edge.id);
    if (current !== undefined) {
      if (current.meta.deletedAt !== undefined) {
        throw new MergeError(
          `mergeIncremental() would resurrect soft-deleted committed edge "${edge.id}" (kind "${current.kind}"). Additive v1 refuses to revive a committed deletion.`,
          { details: { id: edge.id, committedKind: current.kind } },
        );
      }
      if (current.kind !== edge.kind) {
        throw new MergeError(
          `mergeIncremental() would overwrite committed edge "${edge.id}" (kind "${current.kind}") with a different-kind edge "${edge.kind}" of the same id. Additive v1 refuses an edge-id collision.`,
          {
            details: {
              id: edge.id,
              committedKind: current.kind,
              plannedKind: edge.kind,
            },
          },
        );
      }
      const endpointsDiffer =
        current.fromId !== from.id ||
        current.fromKind !== from.kind ||
        current.toId !== to.id ||
        current.toKind !== to.kind;
      const analysis = analyzeRevalidatingWrite(
        edgeSchemaFor(target, edge.kind),
        edgeProps(current),
        edge.props,
      );
      assertValidRevalidatingWrite(
        analysis,
        `mergeIncremental() found an existing committed edge "${edge.id}" (kind "${edge.kind}") whose current props do not validate against the active schema. Additive v1 cannot treat it as an idempotent re-run.`,
        { id: edge.id, kind: edge.kind },
      );
      if (endpointsDiffer || analysis.storageWouldChange) {
        throw new MergeError(
          `mergeIncremental() would overwrite committed edge "${edge.id}" (kind "${edge.kind}") with different endpoints/props. Additive v1 refuses a stale-overwrite of a committed edge.`,
          { details: { id: edge.id, kind: edge.kind } },
        );
      }
      continue;
    }

    const bucket = toCreate.get(edge.kind) ?? [];
    bucket.push({
      id: edge.id,
      from,
      to,
      props: edge.props,
    });
    toCreate.set(edge.kind, bucket);
  }

  for (const [kind, items] of toCreate) {
    await edgeCollection(edgesApi, kind).bulkCreate(items);
  }
  return plan.mergedEdges.length;
}

/**
 * The additive incremental commit path (§6.6). Unlike {@link commitPlan}, this never
 * upserts novel branch additions. It runs inside the target transaction and then:
 *
 * - creates novel nodes/edges with TypeGraph's create path, so uniqueness,
 *   cardinality, endpoint liveness, schema validation, and soft-delete semantics are
 *   enforced by TypeGraph itself;
 * - updates only pulled base members, under the keep-base pin, and refuses a lossy
 *   update of heterogeneous committed props;
 * - skips exact idempotent re-runs; and
 * - rejects any other existing-row collision before the transaction commits.
 */
async function commitIncrementalPlan<G extends GraphDef>(
  target: Store<G>,
  plan: MergePlan<G>,
  baseMemberKeys: ReadonlySet<MergeKey>,
): Promise<Readonly<{ nodes: number; edges: number }>> {
  if (plan.nodeDeletions.size > 0 || plan.survivingModifications.length > 0) {
    throw new MergeError(
      "mergeIncremental() produced inherited node deletions/modifications after stripping — the additive invariant was violated internally.",
      {
        details: {
          deletions: plan.nodeDeletions.size,
          modifications: plan.survivingModifications.length,
        },
      },
    );
  }
  if (!target.backend.capabilities.transactions) {
    throw new MergeError(
      "mergeIncremental() requires a transaction-capable target backend. Additive writes must classify existing rows and commit atomically; non-transactional fallback would allow partial graph writes.",
      { details: { capability: "transactions" } },
    );
  }

  return target.transaction(async (tx) => {
    const nodesApi = tx.nodes as unknown as TxNodes;
    const edgesApi = tx.edges as unknown as TxEdges;
    const nodes = await applyIncrementalNodes(
      target,
      nodesApi,
      plan,
      baseMemberKeys,
    );
    const edges = await applyIncrementalEdges(target, edgesApi, plan);
    return { nodes, edges };
  });
}

/**
 * Additive new-vs-base merge — the public incremental entry point (design §6.4-B /
 * §6.6). Resolves each branch's ADDITIONS against the committed `target` (so a new
 * node re-discovering a committed entity merges onto it, base-id-wins) and commits
 * there, WITHOUT propagating inherited modifications or deletions — the data-loss
 * paths a fork-point diff against a moved target would open.
 *
 * Object-form args so the two same-typed stores (`forkPoint`, `target`) cannot be
 * swapped. `options.target` is ignored — `target` is the explicit arg.
 *
 * Preconditions (typed errors): every branch forked from `forkPoint`
 * (`branch.base === computeBaseVersion(forkPoint)`); `forkPoint` and `target` share a
 * schema hash (schema drift is fatal; target CONTENT may have advanced); and
 * `onBasePropertyConflict` is `"flag"` (keep-base — the one write to an existing base
 * id is non-destructive only when the committed value wins).
 */
export async function mergeIncremental<G extends GraphDef>(
  args: MergeIncrementalArguments<G>,
): Promise<Result<MergeReport<G>, MergeError>> {
  const { forkPoint, target, branches } = args;
  const onInheritedMutation = args.onInheritedMutation ?? "error";

  const normalized = tryNormalize(args.options ?? {});
  if (isErr(normalized)) {
    return err(normalized.error);
  }
  const options = normalized.data;

  // Keep-base pin: the one existing-base-id write (the new-vs-base union) is
  // non-destructive only when the base value wins. A non-keep-base policy would let a
  // stale branch value overwrite a newer committed value — the inherited-modify loss
  // class. (Relaxed when the lineage model ships.)
  if (options.onBasePropertyConflict !== "flag") {
    return err(
      new MergeError(
        'mergeIncremental() v1 requires onBasePropertyConflict: "flag" (keep-base); a non-keep-base policy could overwrite a newer committed base value with a stale branch value.',
        { details: {} },
      ),
    );
  }

  // Every branch must have forked from THIS fork-point (honest additive diff).
  const forkPrecondition = await validateForkPointVersions(forkPoint, branches);
  if (isErr(forkPrecondition)) {
    return err(forkPrecondition.error);
  }

  // Schema half of base@V stays a hard precondition; target CONTENT may advance.
  const [forkSchema, targetSchema] = await Promise.all([
    computeSchemaComponent(forkPoint),
    computeSchemaComponent(target),
  ]);
  if (forkSchema !== targetSchema) {
    return err(
      new MergeError(
        "mergeIncremental() requires target and forkPoint to share a schema; schema drift is not supported (the target content may differ — only the schema must match).",
        { details: {} },
      ),
    );
  }

  return resolveMerge(forkPoint, target, branches, options, true, {
    onInheritedMutation,
  });
}
