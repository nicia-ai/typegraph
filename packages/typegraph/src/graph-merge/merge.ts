import { requireDefined } from "../utils/presence";
/**
 * `merge()` orchestrator (design §7.2, T11).
 *
 * Composes every phase built in T3–T10 into one DB-agnostic primitive:
 *
 *   1. PRECONDITION — compute the target's `base@V` and reject any branch whose
 *      `base` token does not match it (`BaseVersionMismatchError`). A branch
 *      forked from a divergent schema or base revision cannot be merged
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
import {
  computeBaseVersion,
  computeContentComponent,
  computeSchemaComponent,
  contentComponentOf,
  hasRevisionAnchor,
  revisionAnchorOf,
  revisionOriginOf,
} from "./base-version";
import { blockNodes } from "./blocking";
import { canonicalizeProps, edgeStateSignature } from "./canonical-props";
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
import {
  reconcileEdgeModifications,
  reconcileModifications,
  resolveDeleteModify,
  resolveEdgeDeleteModify,
} from "./delete-modify";
import type { MergedEdge, StagedEdge } from "./edge-repoint";
import { buildCanonicalMap, repointEdges } from "./edge-repoint";
import {
  BaseVersionMismatchError,
  IdentityMergeConflictError,
  MergeError,
} from "./errors";
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
import { compareCandidateEdges, scoreCandidates } from "./scoring";
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
  StagedIdentityAssertion,
  StagedModifiedEdge,
  StagedModifiedNode,
  StagedNewEdge,
  StagedNewNode,
  StagingSet,
} from "./staging";
import { stageBranches } from "./staging";
import { withTxConflictRetry } from "./tx-retry";
import type { ReconcileClusterInput } from "./type-reconcile";
import { mostSpecificCommonKind, reconcileTypes } from "./type-reconcile";
import type {
  Edge,
  EdgeId,
  GraphBackend,
  GraphDef,
  IdentityTransferAssertion,
  JsonValue,
  Node,
  NodeId,
  NodeType,
  Store,
  TransactionBackend,
  TransactionOptions,
  UniqueIntrospection,
} from "./typegraph-internal";
import {
  compareCodePoints,
  IdentityContradictionError,
  lockRecordedGraphWrite,
  readRecordedClock,
  readRevisionOrigin,
  storeBackend,
  storeRuntime,
  transactionBackend,
  TypeGraphError,
} from "./typegraph-internal";
import type {
  BaseAmbiguity,
  BaseVersion,
  BranchId,
  BranchProvenance,
  DeleteModifyConflict,
  DroppedItem,
  Embedder,
  EntityResolution,
  GraphBranch,
  MergedCounts,
  MergeIncrementalArgs as MergeIncrementalArguments,
  MergeOptions,
  MergeReport,
  PropertyConflict,
  PropertyConflictPolicy,
  ProvenanceIndex,
  ProvenanceRecord,
  SimilarityStrategy,
  TypeReconciliation,
} from "./types";
import { asBranchId } from "./types";
import { UnionFind } from "./union-find";

/** A node id in its untyped (`NodeType`-default) branded form. */
type AnyNodeId = NodeId<NodeType>;

/** Reserved synthetic branch id for the live target in `mergeIncremental()`. */
const COMMITTED_TARGET_BRANCH: BranchId = asBranchId("__committed_target__");

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
        return byId === 0 ?
            compareStrings(left.branchId, right.branchId)
          : byId;
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
 *
 * This covers only STAGED node texts. COMMITTED base nodes pulled into staged↔base
 * candidate pairs by the base sources are not known until candidate generation
 * runs, so their texts are embedded there via {@link embedMissingPairTexts}.
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
    compareStrings(left, right),
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
    lookup.set(text, requireDefined(vectors[index]));
  }
  return lookup;
}

/**
 * Ensures every text scored for a `vector`/`hybrid` kind is in the embeddings
 * lookup. {@link precomputeEmbeddings} embeds only STAGED node texts; the base
 * sources (`baseKeySource`/`baseUniqueSource`) pull COMMITTED nodes into
 * staged↔base candidate pairs whose texts were never embedded — without this they
 * would score MIN_SCORE and a staged node would commit as a DUPLICATE instead of
 * merging onto its committed entity. Embeds any pair-endpoint text missing from
 * `base` and returns the augmented map (the original when nothing is missing).
 * Keyed by text and embedded in sorted order, so the result stays a pure function
 * of the node set (the determinism contract). Non-embedding strategies
 * (`fulltext`/`custom`) return `base` unchanged.
 */
async function embedMissingPairTexts(
  base: ReadonlyMap<string, Float32Array> | undefined,
  pairs: readonly CandidatePair[],
  strategy: SimilarityStrategy,
  embedder: Embedder,
): Promise<ReadonlyMap<string, Float32Array>> {
  const existing = base ?? new Map<string, Float32Array>();
  const fields = embeddingFields(strategy);
  if (fields === undefined) {
    return existing;
  }
  const missing = new Set<string>();
  for (const pair of pairs) {
    for (const node of [pair.left, pair.right]) {
      const text = fieldText(node, fields);
      if (text.length > 0 && !existing.has(text)) {
        missing.add(text);
      }
    }
  }
  if (missing.size === 0) {
    return existing;
  }
  const orderedTexts = [...missing].sort((left, right) =>
    compareStrings(left, right),
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
  const augmented = new Map(existing);
  for (const [index, text] of orderedTexts.entries()) {
    augmented.set(text, requireDefined(vectors[index]));
  }
  return augmented;
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
  embedder: Embedder | undefined,
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
        const resolveConfig = options.resolve[kind];
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

        // Base sources pull committed nodes into staged↔base pairs whose texts
        // were not in the staged-only precompute; embed them now so vector/hybrid
        // scoring can actually find them (otherwise the pair scores MIN_SCORE and
        // the staged node duplicates instead of merging onto the committed entity).
        const kindCtx =
          embedder === undefined ? ctx : (
            {
              ...ctx,
              embeddings: await embedMissingPairTexts(
                ctx.embeddings,
                pairs,
                resolveConfig.similarity,
                embedder,
              ),
            }
          );

        const scored = scoreCandidates(
          { pairs, forcedEdges },
          resolveConfig,
          kindCtx,
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
    // The ONE shared `(a, b)` edge comparator (id-first `(kind, id)` order), so this
    // stage emits edges in exactly the order clustering consumes them.
    edges: allEdges.sort((left, right) => compareCandidateEdges(left, right)),
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
 *
 * The modified inherited edges are the RECONCILED ones (one per id, 3-way merged
 * against base by {@link reconcileEdgeModifications}) — NOT the raw per-branch
 * `staging.modifiedEdges`. Staging each branch's full fork props separately would
 * make the repoint union treat unchanged-from-base fields as conflicts, dropping a
 * disjoint edit by another branch.
 */
function buildStagedEdges(
  staging: StagingSet,
  modifiedEdges: readonly StagedModifiedEdge[],
): readonly StagedEdge[] {
  const staged: StagedEdge[] = [];
  for (const items of staging.newEdgesByKind.values()) {
    for (const item of items) {
      staged.push(toStagedEdge(item.branchId, item));
    }
  }
  for (const item of modifiedEdges) {
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

/**
 * Appends a branch's contribution of a CANONICAL node id (`role: "node"`) or a
 * SURVIVING edge id (`role: "edge"`), keeping its source.
 */
function pushProvenance(
  records: ProvenanceRecord[],
  role: ProvenanceRecord["role"],
  branchId: BranchId,
  canonicalId: string,
  canonicalKind: string,
  sourceId: string,
): void {
  records.push({ role, canonicalId, canonicalKind, branchId, sourceId });
}

/**
 * Empty per-branch trust weights — the fallback when the caller supplies no
 * {@link MergeOptions.provenanceWeights}. With empty weights the
 * `"provenanceWeighted"` policy degrades to the stable branch order (its
 * documented tie-break), i.e. `"lastWriteWins"` semantics.
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
  edgeDeletions: ReadonlyMap<MergeKey, string>;
  mergedEdges: readonly MergedEdge[];
  // Base props of every inherited edge a fork MODIFIED, keyed by edge id. The
  // commit drops props a fork removed (a base key absent from the merged edge's
  // props) via {@link commitModificationProps} — edges, like nodes, are written
  // with PATCH semantics, so a removed key would otherwise survive. New edges
  // (never inherited) are absent from this map and need no deletion handling.
  inheritedEdgeBaseProps: ReadonlyMap<
    EdgeId,
    Readonly<Record<string, unknown>>
  >;
  retypeMap: ReadonlyMap<MergeKey, string>;
  resolutions: readonly EntityResolution[];
  propertyConflicts: readonly PropertyConflict<G>[];
  deleteModifyConflicts: readonly DeleteModifyConflict[];
  typeReconciliations: readonly TypeReconciliation[];
  dropped: readonly DroppedItem[];
  baseAmbiguities: readonly BaseAmbiguity[];
  provenanceRecords: readonly ProvenanceRecord[];
  warnings: readonly string[];
  identityAssertions: readonly IdentityTransferAssertion[];
  // Complete expected rows, never bare ids: a retraction ends whatever CURRENT
  // row carries its id, so it is only legal against the exact truth the branch
  // retracted. The plan therefore carries the full staged assertion, and both
  // validation layers (the plan-time filter and the in-transaction freshness
  // guard) compare it to the target's row before the id is ended.
  identityRetractions: readonly IdentityTransferAssertion[];
}>;

function identityEndpointKey(assertion: IdentityTransferAssertion): string {
  return JSON.stringify([
    assertion.a.kind,
    assertion.a.id,
    assertion.b.kind,
    assertion.b.id,
  ]);
}

function identitySemanticKey(assertion: IdentityTransferAssertion): string {
  return JSON.stringify([
    assertion.relation,
    assertion.a.kind,
    assertion.a.id,
    assertion.b.kind,
    assertion.b.id,
  ]);
}

function compareIdentitySurvivors(
  left: IdentityTransferAssertion,
  right: IdentityTransferAssertion,
): number {
  const byValidity = compareCodePoints(left.validFrom, right.validFrom);
  return byValidity === 0 ? compareCodePoints(left.id, right.id) : byValidity;
}

/**
 * Reason recorded when two branches asserted the SAME semantic pair and the
 * survivor rule kept only one of the two assertion ids.
 */
export const DUPLICATE_IDENTITY_ASSERTION_DROP_REASON =
  "identity:duplicate-assertion";

/**
 * Reason recorded when node reconciliation collapsed both endpoints of a `same`
 * assertion onto one survivor, making the assertion vacuous.
 */
export const REDUNDANT_IDENTITY_ASSERTION_DROP_REASON =
  "identity:endpoints-collapsed";

/** The report entry for an identity assertion the merge did not apply. */
function droppedIdentityAssertion(
  assertion: IdentityTransferAssertion,
  reason: string,
): DroppedItem {
  return { kind: "identity", id: assertion.id, reason };
}

/**
 * Keeps ONE assertion per semantic pair — the {@link compareIdentitySurvivors}
 * minimum — and reports every loser as a {@link DroppedItem}, so a duplicate
 * assertion silently discarded from a losing branch is still enumerable in the
 * merge report. Survivors come back in semantic-key order.
 */
function dedupeIdentityAssertions(
  assertions: readonly IdentityTransferAssertion[],
): Readonly<{
  survivors: readonly IdentityTransferAssertion[];
  dropped: readonly DroppedItem[];
}> {
  const survivorBySemantic = new Map<string, IdentityTransferAssertion>();
  const dropped: DroppedItem[] = [];
  for (const assertion of assertions) {
    const key = identitySemanticKey(assertion);
    const previous = survivorBySemantic.get(key);
    if (previous === undefined) {
      survivorBySemantic.set(key, assertion);
      continue;
    }
    const [survivor, loser] =
      compareIdentitySurvivors(assertion, previous) < 0 ?
        [assertion, previous]
      : [previous, assertion];
    survivorBySemantic.set(key, survivor);
    dropped.push(
      droppedIdentityAssertion(loser, DUPLICATE_IDENTITY_ASSERTION_DROP_REASON),
    );
  }
  return {
    survivors: [...survivorBySemantic.values()].toSorted((left, right) =>
      compareCodePoints(identitySemanticKey(left), identitySemanticKey(right)),
    ),
    dropped,
  };
}

function assertNoOpposingIdentityRelations(
  assertions: readonly IdentityTransferAssertion[],
): void {
  const byEndpoint = new Map<string, IdentityTransferAssertion[]>();
  for (const assertion of assertions) {
    const key = identityEndpointKey(assertion);
    const group = byEndpoint.get(key) ?? [];
    group.push(assertion);
    byEndpoint.set(key, group);
  }
  for (const [endpoint, group] of byEndpoint) {
    if (new Set(group.map((assertion) => assertion.relation)).size < 2) {
      continue;
    }
    throw new IdentityMergeConflictError(
      "Branches asserted opposing identity relations for one endpoint pair.",
      { details: { endpoint, assertions: group } },
    );
  }
}

/**
 * Refuses the retract/reassert RACE: one branch retracts the assertion for a
 * semantic pair while a DIFFERENT branch re-asserts that pair under a new id
 * WITHOUT retracting it — the branches disagree about whether the old truth still
 * holds, and no rule can pick between "the pair is not asserted" and "the pair is
 * asserted under a new id".
 *
 * Two nearby shapes are NOT races and must merge cleanly:
 *
 *   - A single fork that retracts then re-asserts the same pair (a normal linear
 *     edit): its final state is simply "old id retracted, new id asserted".
 *   - CONVERGENT edits, where the re-asserting branch ALSO retracted the pair:
 *     every branch agrees the old assertion dies, and one went further by
 *     re-asserting. The merge applies both effects.
 *
 * Both hinge on which branch produced which change, so this consults the staged
 * (branch-tagged) retractions — grouping by semantic key alone would drop exactly
 * the provenance that separates a race from agreement.
 */
function assertNoRetractReassertRace(staging: StagingSet): void {
  const retractedBySemantic = new Map<string, StagedIdentityAssertion[]>();
  for (const staged of staging.retractedIdentityAssertions) {
    const key = identitySemanticKey(staged.assertion);
    const retractions = retractedBySemantic.get(key) ?? [];
    retractions.push(staged);
    retractedBySemantic.set(key, retractions);
  }
  for (const staged of staging.newIdentityAssertions) {
    const retractions =
      retractedBySemantic.get(identitySemanticKey(staged.assertion)) ?? [];
    const selfRetracted = retractions.some(
      (retraction) => retraction.branchId === staged.branchId,
    );
    if (selfRetracted) {
      continue;
    }
    const crossBranchRetraction = retractions.find(
      (retraction) => retraction.assertion.id !== staged.assertion.id,
    );
    if (crossBranchRetraction !== undefined) {
      throw new IdentityMergeConflictError(
        "Branches contain a retract/reassert race for one identity pair.",
        {
          details: {
            retractedAssertion: crossBranchRetraction.assertion,
            retractedBy: crossBranchRetraction.branchId,
            reassertedAssertion: staged.assertion,
            reassertedBy: staged.branchId,
          },
        },
      );
    }
  }
}

/**
 * Reason recorded when a branch retracted an assertion whose id identifies a
 * DIFFERENT complete truth on the target's current ledger. Ending that row
 * would delete truth the branch never saw, while the branch's actual intent —
 * "the assertion I retracted no longer holds" — is already satisfied by that
 * assertion's absence, so the retraction is skipped and reported instead.
 */
export const RETRACTION_TARGET_MISMATCH_DROP_REASON =
  "identity:retraction-target-mismatch";

/** The empty stored-row map, for validating staged assertions intra-plan only. */
const NO_STORED_ASSERTIONS: ReadonlyMap<string, LedgerAssertion> = new Map();

/** @internal Exported for deterministic phase-level verification. */
export function planIdentityChanges(
  staging: StagingSet,
  storedRetractionRowsById: ReadonlyMap<string, LedgerAssertion>,
): Readonly<{
  assertions: readonly IdentityTransferAssertion[];
  retractions: readonly IdentityTransferAssertion[];
  dropped: readonly DroppedItem[];
}> {
  assertNoOpposingIdentityRelations(
    staging.newIdentityAssertions.map((staged) => staged.assertion),
  );
  assertNoRetractReassertRace(staging);
  // One id, one truth — over the RAW staged assertions, BEFORE the semantic
  // survivor dedupe: two branches staging one id for the same pair with
  // different validFrom values collapse into one survivor under the semantic
  // key (which excludes validity), so a later check would never see the
  // collision — while the report would list the id as both applied and
  // dropped.
  assertOneIdOneTruth(
    staging.newIdentityAssertions.map((staged) => staged.assertion),
    NO_STORED_ASSERTIONS,
  );

  const deduped = dedupeIdentityAssertions(
    staging.newIdentityAssertions.map((staged) => staged.assertion),
  );
  const retractionById = new Map<string, IdentityTransferAssertion>();
  for (const staged of staging.retractedIdentityAssertions) {
    const previous = retractionById.get(staged.assertion.id);
    if (
      previous !== undefined &&
      assertionIdentityKey(previous) !== assertionIdentityKey(staged.assertion)
    ) {
      throw new IdentityMergeConflictError(
        "One assertion id was staged for retraction with two different identity truths.",
        {
          details: {
            assertionId: staged.assertion.id,
            first: previous,
            second: staged.assertion,
          },
        },
      );
    }
    retractionById.set(staged.assertion.id, staged.assertion);
  }
  const retractions: IdentityTransferAssertion[] = [];
  const retractionDropped: DroppedItem[] = [];
  for (const [assertionId, retraction] of retractionById) {
    const stored = storedRetractionRowsById.get(assertionId);
    if (
      stored !== undefined &&
      stored.validTo === undefined &&
      assertionIdentityKey(stored) !== assertionIdentityKey(retraction)
    ) {
      retractionDropped.push({
        kind: "identity",
        id: assertionId,
        reason: RETRACTION_TARGET_MISMATCH_DROP_REASON,
      });
      continue;
    }
    retractions.push(retraction);
  }
  return {
    assertions: deduped.survivors,
    retractions: retractions.toSorted((left, right) =>
      compareCodePoints(left.id, right.id),
    ),
    dropped: [...deduped.dropped, ...retractionDropped],
  };
}

/** A plain `(kind, id)` node reference — an identity assertion endpoint. */
type IdentityEndpoint = Readonly<{ kind: string; id: string }>;

/**
 * Code-point order over `(kind, id)` endpoints, matching the identity service's
 * pair normalization (kind first, id as the tie-break). A stored identity pair MUST
 * satisfy `a <= b` under this order or the import path the merge commit reuses
 * rejects it as non-normalized.
 */
function compareIdentityEndpoints(
  left: IdentityEndpoint,
  right: IdentityEndpoint,
): number {
  const byKind = compareCodePoints(left.kind, right.kind);
  return byKind === 0 ? compareCodePoints(left.id, right.id) : byKind;
}

/**
 * Maps an endpoint onto the `(kind, id)` it will actually carry in the committed
 * target: first through the cluster canonical map (the SAME map edge repoint
 * uses), then through the ontology retype cascade, keyed EXACTLY as
 * {@link applyMergePlan} keys an edge endpoint — `mergeKey(kind, id)` of the
 * post-canonical endpoint, whose retype value is the survivor's reconciled kind.
 *
 * Both hops are required. Under `reconcileTypes: "ontology"` a cluster survivor
 * is written under its most-specific kind, so an assertion that still named the
 * pre-retype kind would reference a `(kind, id)` no live row carries and the
 * commit-time endpoint guard would reject it (or, worse, bind to a stale row of
 * the old kind).
 */
function resolveIdentityEndpoint(
  endpoint: IdentityEndpoint,
  canonicalOf: ReadonlyMap<MergeKey, MergeKey>,
  retypeMap: ReadonlyMap<MergeKey, string>,
): IdentityEndpoint {
  const key = mergeKeyOf(endpoint);
  const canonical = canonicalOf.get(key) ?? key;
  return {
    kind: retypeMap.get(canonical) ?? kindOf(canonical),
    id: idOf(canonical),
  };
}

/**
 * Repoints every planned identity assertion's endpoints onto the identity they
 * will hold after the commit ({@link resolveIdentityEndpoint}), so an assertion
 * naming a branch node that reconciliation folded away — or retyped — references
 * the surviving row instead of a dangling `(kind, id)` (which the commit-time
 * `requireLiveEndpoints` guard would reject with a NodeNotFoundError, rolling back
 * the whole merge). After remapping it re-establishes the identity-pair invariants:
 * a `same` assertion whose endpoints collapse onto one survivor is redundant
 * and dropped (reported), while a collapsed `different` assertion is a typed
 * conflict; surviving endpoints are re-normalized into code-point order (the
 * import path rejects a non-normalized pair), and assertions that now share a
 * semantic key are re-deduped by the same survivor rule
 * ({@link compareIdentitySurvivors}) that {@link planIdentityChanges} applied
 * before the remap.
 */
function remapIdentityAssertionEndpoints(
  assertions: readonly IdentityTransferAssertion[],
  canonicalOf: ReadonlyMap<MergeKey, MergeKey>,
  retypeMap: ReadonlyMap<MergeKey, string>,
): Readonly<{
  assertions: readonly IdentityTransferAssertion[];
  dropped: readonly DroppedItem[];
}> {
  const remapped: IdentityTransferAssertion[] = [];
  const dropped: DroppedItem[] = [];
  for (const assertion of assertions) {
    const remappedA = resolveIdentityEndpoint(
      assertion.a,
      canonicalOf,
      retypeMap,
    );
    const remappedB = resolveIdentityEndpoint(
      assertion.b,
      canonicalOf,
      retypeMap,
    );
    if (mergeKeyOf(remappedA) === mergeKeyOf(remappedB)) {
      if (assertion.relation === "different") {
        throw new IdentityMergeConflictError(
          "Node reconciliation collapsed a different-identity assertion onto one survivor.",
          { details: { assertion, survivor: remappedA } },
        );
      }
      dropped.push(
        droppedIdentityAssertion(
          assertion,
          REDUNDANT_IDENTITY_ASSERTION_DROP_REASON,
        ),
      );
      continue;
    }
    const [a, b] =
      compareIdentityEndpoints(remappedA, remappedB) <= 0 ?
        [remappedA, remappedB]
      : [remappedB, remappedA];
    remapped.push({ ...assertion, a, b });
  }
  const deduped = dedupeIdentityAssertions(remapped);
  // Node reconciliation can collapse previously distinct endpoint pairs onto
  // the same canonical pair, so the pre-reconciliation check above is not
  // sufficient on its own.
  assertNoOpposingIdentityRelations(deduped.survivors);
  return {
    assertions: deduped.survivors,
    dropped: [...dropped, ...deduped.dropped],
  };
}

/**
 * Refuses an assertion that names a node the merge is about to DELETE.
 *
 * The commit soft-deletes nodes before applying the identity changes, which
 * detaches every assertion touching them, so an assertion naming a deleted
 * endpoint could only ever fail at commit time — rolling the whole merge back
 * behind a generic error. Detecting it here turns it into a deterministic,
 * plan-time {@link IdentityMergeConflictError}: one branch says the entity exists
 * and is (not) the same as another, a second says it is gone, and unlike the
 * delete/modify case there is no policy the caller can set to arbitrate.
 *
 * `nodeDeletions` is keyed by the deleted node's own kind, while the assertions
 * arrive post-retype, so a retyped identity is checked in BOTH forms.
 */
function assertIdentityEndpointsNotDeleted(
  assertions: readonly IdentityTransferAssertion[],
  nodeDeletions: ReadonlyMap<MergeKey, string>,
  retypeMap: ReadonlyMap<MergeKey, string>,
): void {
  const deletedIdentities = new Set<MergeKey>();
  for (const key of nodeDeletions.keys()) {
    deletedIdentities.add(key);
    const retyped = retypeMap.get(key);
    if (retyped !== undefined) {
      deletedIdentities.add(mergeKey(retyped, idOf(key)));
    }
  }
  for (const assertion of assertions) {
    for (const endpoint of [assertion.a, assertion.b]) {
      if (!deletedIdentities.has(mergeKeyOf(endpoint))) {
        continue;
      }
      throw new IdentityMergeConflictError(
        "A branch asserted an identity relation over a node another branch deleted.",
        { details: { assertion, deletedEndpoint: endpoint } },
      );
    }
  }
}

/**
 * Refuses a merge whose committed ledger would claim two nodes are BOTH the same
 * and different — including through a chain of `same` assertions no single branch
 * ever wrote.
 *
 * {@link assertNoOpposingIdentityRelations} only sees a DIRECT collision (one
 * endpoint pair carrying both relations). The common shape is transitive: base
 * holds `same(p2, p3)`, one branch asserts `same(p1, p2)` and another asserts
 * `different(p1, p3)`. Nothing collides pairwise, so planning used to pass and the
 * identity import raised its own contradiction error inside the commit
 * transaction, where the orchestrator's catch-all rewrote it as a generic
 * `MergeError` — the documented `GRAPH_MERGE_IDENTITY_CONFLICT` code never fired.
 *
 * The check evaluates the ledger the merge would actually leave behind: the base's
 * CURRENT assertions minus the staged retractions, plus the already remapped and
 * deduped staged assertions. Base endpoints are put through the same
 * {@link resolveIdentityEndpoint} mapping, so an inherited assertion whose node
 * was folded or retyped is judged at its post-merge identity. The `same`
 * assertions are folded into equivalence classes and every `different` pair —
 * staged or inherited — is rejected when both of its endpoints land in one class.
 *
 * Two DERIVED relations join the explicit ledger in the simulation, because
 * canonicalization and retyping can manufacture contradictions no branch wrote:
 * under `sameIdAcrossKinds: "fold"` endpoints sharing an id across kinds are
 * implicitly the same (a remapped cross-kind `different` pair can land on one
 * id), and a retyped endpoint can pull a kind into a class that the ontology
 * declares disjoint with another member's kind. Both used to surface only at
 * commit time as a generic merge error.
 */
/** @internal Exported for deterministic phase-level verification. */
export function assertNoContradictoryIdentityClosure(
  plannedAssertions: readonly IdentityTransferAssertion[],
  retractions: readonly string[],
  baseAssertions: readonly IdentityTransferAssertion[],
  canonicalOf: ReadonlyMap<MergeKey, MergeKey>,
  retypeMap: ReadonlyMap<MergeKey, string>,
  identityContext: PlanIdentityContext,
  nodeUniverse: readonly Readonly<{ kind: string; id: string }>[],
): void {
  const retracted = new Set(retractions);
  const mergedLedger = [
    ...plannedAssertions,
    ...baseAssertions
      .filter((assertion) => !retracted.has(assertion.id))
      .map((assertion) => ({
        ...assertion,
        a: resolveIdentityEndpoint(assertion.a, canonicalOf, retypeMap),
        b: resolveIdentityEndpoint(assertion.b, canonicalOf, retypeMap),
      })),
  ];

  const sameClasses = new UnionFind<MergeKey>((left, right) =>
    compareMergeKeys(left, right),
  );
  // Assertion-free nodes participate too: a new or retyped canonical node —
  // or a live target peer sharing its id — can fold into a class without any
  // ledger edge naming it, so the simulation seeds the full node universe as
  // singletons before the explicit assertions union anything.
  for (const node of nodeUniverse) {
    sameClasses.add(mergeKey(node.kind, node.id));
  }
  for (const assertion of mergedLedger) {
    if (assertion.relation === "same") {
      sameClasses.union(mergeKeyOf(assertion.a), mergeKeyOf(assertion.b));
    }
  }
  const refsById = new Map<string, MergeKey[]>();
  const addRef = (kind: string, id: string): void => {
    const keys = refsById.get(id) ?? [];
    keys.push(mergeKey(kind, id));
    refsById.set(id, keys);
  };
  for (const node of nodeUniverse) addRef(node.kind, node.id);
  for (const assertion of mergedLedger) {
    addRef(assertion.a.kind, assertion.a.id);
    addRef(assertion.b.kind, assertion.b.id);
  }
  // Sharing an id across DISJOINT kinds is a create-time constraint under
  // BOTH profiles — under "ignore" the rows do not fold, but the id is still
  // refused. Scan every same-id group regardless of profile.
  for (const keys of refsById.values()) {
    const kinds = [...new Set(keys.map((key) => kindOf(key)))];
    for (const [index, left] of kinds.entries()) {
      for (const right of kinds.slice(index + 1)) {
        if (!identityContext.areDisjoint(left, right)) continue;
        throw new IdentityMergeConflictError(
          "The merged graph would give one id to two ontology-disjoint kinds.",
          {
            details: {
              disjointKinds: [left, right],
              sharedId: idOf(requireDefined(keys[0])),
            },
          },
        );
      }
    }
  }
  if (identityContext.sameIdAcrossKinds === "fold") {
    for (const keys of refsById.values()) {
      const [first, ...rest] = keys;
      if (first === undefined) continue;
      for (const other of rest) sameClasses.union(first, other);
    }
  }
  for (const assertion of mergedLedger) {
    if (assertion.relation !== "different") {
      continue;
    }
    const root = sameClasses.find(mergeKeyOf(assertion.a));
    if (root !== sameClasses.find(mergeKeyOf(assertion.b))) {
      continue;
    }
    throw new IdentityMergeConflictError(
      "The merged identity ledger would assert one pair of nodes is both the same and different.",
      {
        details: {
          assertion,
          sameClass: sameClasses
            .members()
            .filter((member) => sameClasses.find(member) === root)
            .map((member) => ({ kind: kindOf(member), id: idOf(member) }))
            .toSorted((left, right) =>
              compareMergeKeys(mergeKeyOf(left), mergeKeyOf(right)),
            ),
        },
      },
    );
  }

  // A class whose member kinds the ontology declares disjoint is the same
  // contradiction in another coat: retyping (or a fold) pulled two mutually
  // exclusive kinds into one identity class.
  const kindsByRoot = new Map<MergeKey, Set<string>>();
  for (const member of sameClasses.members()) {
    const root = sameClasses.find(member);
    const kinds = kindsByRoot.get(root) ?? new Set<string>();
    kinds.add(kindOf(member));
    kindsByRoot.set(root, kinds);
  }
  for (const [root, kinds] of kindsByRoot) {
    const kindList = [...kinds];
    for (const [index, left] of kindList.entries()) {
      for (const right of kindList.slice(index + 1)) {
        if (!identityContext.areDisjoint(left, right)) continue;
        throw new IdentityMergeConflictError(
          "The merged identity ledger would join two ontology-disjoint kinds into one class.",
          {
            details: {
              disjointKinds: [left, right],
              sameClass: sameClasses
                .members()
                .filter((member) => sameClasses.find(member) === root)
                .map((member) => ({ kind: kindOf(member), id: idOf(member) }))
                .toSorted((first, second) =>
                  compareMergeKeys(mergeKeyOf(first), mergeKeyOf(second)),
                ),
            },
          },
        );
      }
    }
  }
}

/**
 * The identity semantics the plan-time contradiction simulation needs from the
 * target: whether same-id folding is on, and which kind pairs the ontology
 * declares disjoint.
 */
type PlanIdentityContext = Readonly<{
  sameIdAcrossKinds: "fold" | "ignore" | undefined;
  areDisjoint: (left: string, right: string) => boolean;
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
  identityContext: PlanIdentityContext,
  storedRetractionRowsById: ReadonlyMap<string, LedgerAssertion>,
  targetPeers: readonly Readonly<{ kind: string; id: string }>[],
  preferredBranchId?: BranchId,
): MergePlan<G> {
  const identity = planIdentityChanges(staging, storedRetractionRowsById);
  const provenanceRecords: ProvenanceRecord[] = [];
  // Per-branch trust weights for the `"provenanceWeighted"` policy, or empty when
  // the caller supplied none (then the policy falls back to the stable branch order).
  const weights = options.provenanceWeights ?? EMPTY_WEIGHTS;
  const recordProvenance = (
    role: ProvenanceRecord["role"],
    branchId: BranchId,
    canonicalId: string,
    canonicalKind: string,
    sourceId: string,
  ): void => {
    if (branchId === preferredBranchId) {
      return;
    }
    pushProvenance(
      provenanceRecords,
      role,
      branchId,
      canonicalId,
      canonicalKind,
      sourceId,
    );
  };

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
      weights,
      options.canonical,
      options.onBasePropertyConflict as PropertyConflictPolicy,
      preferKind,
      preferredBranchId,
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
      recordProvenance(
        "node",
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
    preferredBranchId,
  );
  const nodeDeletions = new Map<MergeKey, string>();
  for (const deletion of deleteModify.nodeDeletions) {
    nodeDeletions.set(mergeKey(deletion.kind, deletion.id), deletion.kind);
  }
  for (const modification of deleteModify.survivingModifications) {
    recordProvenance(
      "node",
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
    weights,
    preferredBranchId,
  );
  for (const conflict of reconciledModifications.conflicts) {
    propertyConflicts.push(conflict as PropertyConflict<G>);
  }

  // (6-edge) the EDGE analogue of node delete/modify + reconcile. Inherited edge
  // deletions are applied (previously staged but never committed, so the edge
  // stayed live), and edges modified by 2+ branches are 3-way merged against base
  // so disjoint edits do not false-conflict (previously each branch's full fork
  // props were unioned, dropping a branch's independent edit). Provenance credits
  // every modifying branch (mirrors the node push), before reconcile collapses
  // them to one record per id.
  const edgeDeleteModify = resolveEdgeDeleteModify(
    staging,
    options.onDeleteModifyConflict,
    branchRank,
    preferredBranchId,
  );
  const edgeDeletions = new Map<MergeKey, string>();
  for (const deletion of edgeDeleteModify.edgeDeletions) {
    edgeDeletions.set(mergeKey(deletion.kind, deletion.id), deletion.kind);
  }
  for (const modification of edgeDeleteModify.survivingModifications) {
    recordProvenance(
      "edge",
      modification.branchId,
      modification.edge.id,
      modification.edge.kind,
      modification.edge.id,
    );
  }
  const reconciledEdgeModifications = reconcileEdgeModifications(
    edgeDeleteModify.survivingModifications,
    options.onPropertyConflict as PropertyConflictPolicy,
    branchRank,
    weights,
    preferredBranchId,
  );
  for (const conflict of reconciledEdgeModifications.conflicts) {
    propertyConflicts.push(conflict as PropertyConflict<G>);
  }

  // (7) opt-in ontology type reconciliation over the public-closure glue. Inputs
  // (incl. base member kinds) were collected per cluster in the canonicalize loop.
  const reconciliation = reconcileTypes(
    reconcileInputs,
    subClassClosure,
    options.reconcileTypes,
  );

  // (8) repoint every staged edge onto its cluster canonical + dedupe. Index the
  // canonical entities by their `(kind, id)` ONCE so the per-cluster survivor
  // lookup is O(1) — a linear scan per cluster would make the map build
  // O(clusters × entities), quadratic over the merged-node universe.
  const entityByIdentity = new Map<MergeKey, CanonicalEntity>();
  for (const entity of canonicalEntities) {
    entityByIdentity.set(mergeKey(entity.kind, entity.canonicalId), entity);
  }
  const canonicalOf = buildCanonicalMap(clusters, (cluster) =>
    pickClusterCanonical(cluster, entityByIdentity),
  );
  // Repoint identity-assertion endpoints through the same canonical + retype maps
  // the edges use, so an assertion naming a folded or retyped branch node
  // references its survivor instead of a dangling `(kind, id)` the commit-time
  // endpoint guard would reject. The two guards that follow turn the remaining
  // commit-time identity failures into deterministic plan-time conflicts.
  const identityRemap = remapIdentityAssertionEndpoints(
    identity.assertions,
    canonicalOf,
    reconciliation.retypeMap,
  );
  assertIdentityEndpointsNotDeleted(
    identityRemap.assertions,
    nodeDeletions,
    reconciliation.retypeMap,
  );
  // Each canonical entity enters the universe under the kind the commit will
  // actually WRITE — the retyped one when the ontology cascade retypes it —
  // while its deletion check runs against the source identity, which is how
  // `nodeDeletions` is keyed.
  const identityNodeUniverse = [
    ...canonicalEntities
      .filter(
        (entity) =>
          !nodeDeletions.has(mergeKey(entity.kind, entity.canonicalId)),
      )
      .map((entity) => ({
        kind:
          reconciliation.retypeMap.get(
            mergeKey(entity.kind, entity.canonicalId),
          ) ?? entity.kind,
        id: entity.canonicalId,
      })),
    ...targetPeers.filter(
      (node) => !nodeDeletions.has(mergeKey(node.kind, node.id)),
    ),
  ];
  assertNoContradictoryIdentityClosure(
    identityRemap.assertions,
    identity.retractions.map((retraction) => retraction.id),
    staging.baseIdentityAssertions,
    canonicalOf,
    reconciliation.retypeMap,
    identityContext,
    identityNodeUniverse,
  );
  const stagedEdges = buildStagedEdges(
    staging,
    reconciledEdgeModifications.survivingModifications,
  );
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
    weights,
    preferredBranchId,
  );
  for (const merged of repoint.edges) {
    for (const sourceId of merged.mergedIds) {
      for (const branchId of stagedEdgeBranches.get(sourceId) ?? []) {
        recordProvenance("edge", branchId, merged.id, merged.kind, sourceId);
      }
    }
  }

  const dropped: DroppedItem[] = [
    ...deleteModify.dropped,
    ...edgeDeleteModify.dropped,
    ...repoint.dropped,
    ...reconciliation.dropped,
    ...identity.dropped,
    ...identityRemap.dropped,
  ].sort((left, right) =>
    compareStrings(`${left.kind}|${left.id}`, `${right.kind}|${right.id}`),
  );

  return {
    canonicalEntities,
    survivingModifications: reconciledModifications.survivingModifications,
    nodeDeletions,
    edgeDeletions,
    mergedEdges: repoint.edges,
    inheritedEdgeBaseProps: new Map(
      reconciledEdgeModifications.survivingModifications.map((modification) => [
        modification.edge.id,
        modification.edge.baseProps,
      ]),
    ),
    retypeMap: reconciliation.retypeMap,
    // Order report arrays by the composite (kind, id) identity — never a bare id
    // or a `|`-joined string. A bare id ties two different-kind entities that
    // share an id, and a `|` separator collides on caller-supplied ids/property
    // names that contain `|`; either makes the comparator non-total, so the
    // returned order would depend on stable-sort + insertion order and break the
    // order-independence the whole subsystem guarantees.
    resolutions: resolutions.sort((left, right) =>
      compareMergeKeys(
        mergeKey(left.kind, left.canonicalId),
        mergeKey(right.kind, right.canonicalId),
      ),
    ),
    propertyConflicts: [...propertyConflicts, ...repoint.conflicts].sort(
      (left, right) => {
        const byEntity = compareMergeKeys(
          mergeKey(left.kind, left.entityId),
          mergeKey(right.kind, right.entityId),
        );
        return byEntity === 0 ?
            compareStrings(left.property, right.property)
          : byEntity;
      },
    ),
    deleteModifyConflicts: [
      ...deleteModify.conflicts,
      ...edgeDeleteModify.conflicts,
    ].sort((left, right) =>
      compareMergeKeys(
        mergeKey(left.kind, left.entityId),
        mergeKey(right.kind, right.entityId),
      ),
    ),
    typeReconciliations: reconciliation.reconciliations,
    dropped,
    baseAmbiguities: baseAmbiguities.sort((left, right) =>
      compareMergeKeys(
        mergeKey(
          requireDefined(left.baseIds[0]).kind,
          requireDefined(left.baseIds[0]).id,
        ),
        mergeKey(
          requireDefined(right.baseIds[0]).kind,
          requireDefined(right.baseIds[0]).id,
        ),
      ),
    ),
    provenanceRecords,
    warnings: candidateWarnings,
    identityAssertions: identityRemap.assertions,
    identityRetractions: identity.retractions,
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
 *
 * `entityByIdentity` maps each canonical entity's `(kind, id)` → entity, built once by
 * the caller, so finding a cluster's survivor is O(cluster.members) rather than a scan
 * of every canonical entity.
 */
function pickClusterCanonical(
  cluster: ClusterResult,
  entityByIdentity: ReadonlyMap<MergeKey, CanonicalEntity>,
): MergeKey {
  for (const member of cluster.members) {
    if (entityByIdentity.has(member)) {
      return member;
    }
  }
  throw new MergeError(
    "Internal invariant: cluster has no canonical entity in pickClusterCanonical.",
    { details: { members: cluster.members.map((member) => idOf(member)) } },
  );
}

/**
 * Builds the prop bag to COMMIT for an inherited modification, HONORING property
 * deletions. A fork's `forkProps` is its full intended state, so a base property
 * ABSENT from it was removed by that fork. The commit upsert shallow-merges the
 * written props onto the existing (base) row, so a removed key would otherwise
 * survive; writing it as `undefined` makes the row write drop it (the props column
 * is JSON-serialized, which omits `undefined`), so the fork's deletion is applied
 * instead of being silently reverted to the base value.
 */
function commitModificationProps(
  baseProps: Readonly<Record<string, unknown>>,
  forkProps: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const props: Record<string, unknown> = { ...forkProps };
  for (const key of Object.keys(baseProps)) {
    if (!(key in forkProps)) {
      props[key] = undefined;
    }
  }
  return props;
}

/**
 * Applies a resolved {@link MergePlan} through a transaction's collection API.
 * Shared by `commitPlan()` and the guarded `mergeIncremental()` commit path so
 * both modes execute the same resolved semantics.
 */
async function applyMergePlan<G extends GraphDef>(
  plan: MergePlan<G>,
  nodesApi: TxNodes,
  edgesApi: TxEdges,
  target: Store<G>,
  txBackend: TransactionBackend,
): Promise<MergedCounts> {
  // Counted by composite `(kind, id)` identity, so two different-kind nodes that
  // share an id string each count once (and never collide in the dedupe set).
  const committedNodeIds = new Set<MergeKey>();

  // Identities written as canonical cluster entities, and the fork props of every
  // surviving inherited modification keyed by identity. On the new-vs-base path a
  // committed node can be BOTH a base-member cluster survivor AND an inherited
  // modification; without coordinating the two writes the canonical upsert (built
  // from the cluster union, which carries the OLDER base props) would clobber the
  // modification's fork edit. We therefore fold the fork props into the canonical
  // write and skip the standalone modification write for that identity.

  // Soft-delete every finally-deleted node FIRST (key encodes the kind; the
  // value repeats it for the collection lookup). Deletions precede the node
  // writes so a plan replacing a node — e.g. deleting Robot:x and creating a
  // disjoint Person:x — applies in the only order the create-time
  // disjoint-id constraint permits, matching how the same operations run
  // directly on a store. Deleted identities are never also written (the
  // write loops filter on `plan.nodeDeletions`), and edge upserts still run
  // after these cascades.
  for (const [identity, kind] of plan.nodeDeletions) {
    const collection = nodeCollection(nodesApi, kind);
    await collection.delete(idOf(identity));
  }

  const canonicalIdentities = new Set<MergeKey>();
  for (const entity of plan.canonicalEntities) {
    canonicalIdentities.add(mergeKey(entity.kind, entity.canonicalId));
  }
  const survivingModProps = new Map<
    MergeKey,
    Readonly<{
      baseProps: Readonly<Record<string, unknown>>;
      forkProps: Readonly<Record<string, unknown>>;
    }>
  >();
  for (const modification of plan.survivingModifications) {
    survivingModProps.set(mergeKeyOf(modification.node), {
      baseProps: modification.node.baseProps,
      forkProps: modification.node.forkProps,
    });
  }

  // Surviving inherited modifications, skipping any node finally deleted OR folded
  // into a canonical cluster write below. Property deletions the fork made are
  // honored via {@link commitModificationProps}.
  for (const modification of plan.survivingModifications) {
    const identity = mergeKeyOf(modification.node);
    if (plan.nodeDeletions.has(identity) || canonicalIdentities.has(identity)) {
      continue;
    }
    const collection = nodeCollection(nodesApi, modification.node.kind);
    await collection.upsertByIdFromRecord(
      modification.node.id,
      commitModificationProps(
        modification.node.baseProps,
        modification.node.forkProps,
      ),
    );
    committedNodeIds.add(identity);
  }

  // New canonical cluster nodes (survivors), with retype cascade. When the survivor
  // is also an inherited modification, merge the fork edit's props ON TOP of the
  // cluster union so the explicit fork edit is not lost to the (older) base props
  // the union carried.
  for (const entity of plan.canonicalEntities) {
    const identity = mergeKey(entity.kind, entity.canonicalId);
    if (plan.nodeDeletions.has(identity)) {
      continue;
    }
    const kind = plan.retypeMap.get(identity) ?? entity.kind;
    const modification = survivingModProps.get(identity);
    // Fold the fork edit ON TOP of the cluster union, honoring the fork's property
    // deletions (which surface as `undefined` and so override the union's value).
    const props =
      modification === undefined ?
        entity.props
      : {
          ...entity.props,
          ...commitModificationProps(
            modification.baseProps,
            modification.forkProps,
          ),
        };
    const collection = nodeCollection(nodesApi, kind);
    await collection.upsertByIdFromRecord(entity.canonicalId, props);
    committedNodeIds.add(mergeKey(kind, entity.canonicalId));
  }

  // Soft-delete every finally-deleted inherited edge. These ids are disjoint from
  // the merged-edge upserts below (deleted edges are not staged), so order is
  // immaterial. Without this an inherited edge deleted in a branch stayed live.
  for (const [identity, kind] of plan.edgeDeletions) {
    await edgeCollection(edgesApi, kind).delete(idOf(identity));
  }

  // Repointed + deduped edges, grouped by kind so each kind is one batched
  // round-trip (upsert-by-id is order-independent). The retype cascade keys on
  // each endpoint's full `(kind, id)` identity.
  const edgesByKind = new Map<string, EdgeUpsert[]>();
  for (const edge of plan.mergedEdges) {
    const fromKind = plan.retypeMap.get(mergeKey(edge.fromKind, edge.fromId));
    const toKind = plan.retypeMap.get(mergeKey(edge.toKind, edge.toId));
    // Honor a fork's property deletion on an inherited edge: drop base keys absent
    // from the merged props (the edge upsert PATCH-merges, so a removed key would
    // otherwise survive). New edges have no base entry, so their props pass through.
    const edgeBaseProps = plan.inheritedEdgeBaseProps.get(edge.id);
    const props =
      edgeBaseProps === undefined ?
        edge.props
      : commitModificationProps(edgeBaseProps, edge.props);
    const item: EdgeUpsert = {
      id: edge.id,
      from: { kind: fromKind ?? edge.fromKind, id: edge.fromId },
      to: { kind: toKind ?? edge.toKind, id: edge.toId },
      props,
    };
    const existing = edgesByKind.get(edge.kind);
    if (existing === undefined) {
      edgesByKind.set(edge.kind, [item]);
    } else {
      existing.push(item);
    }
  }
  let committedEdges = 0;
  for (const [kind, items] of edgesByKind) {
    await edgeCollection(edgesApi, kind).bulkUpsertById(items);
    committedEdges += items.length;
  }

  await storeRuntime(target).applyIdentityMergeAtTarget(
    txBackend,
    plan.identityRetractions.map((retraction) => retraction.id),
    plan.identityAssertions,
  );

  return {
    nodes: committedNodeIds.size,
    edges: committedEdges,
    // The plan's identity arrays ARE what was applied: both are already deduped
    // (survivor rule + endpoint remap) and the apply runs inside this
    // transaction, so any failure aborts the whole merge rather than reporting a
    // partial count. Same basis as the edge count above.
    identity: {
      asserted: plan.identityAssertions.length,
      retracted: plan.identityRetractions.length,
    },
  };
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
 *
 * COALESCE INTERACTION: when the target store was created with
 * `coalesceUnchangedUpserts`, a canonical/inherited upsert whose props already
 * equal the committed row is skipped (no write, no recorded row). This is sound
 * for merge and needs no bypass: the base@V guard runs BEFORE any upsert
 * (see {@link assertTargetUnchanged}), conflicts are resolved at plan time, and
 * an upsert-by-id never rewrites endpoints — so coalescing only elides writes
 * that would persist a byte-identical value, leaving the merged state
 * identical. It merely declines to re-stamp recorded time on rows the merge did
 * not actually change, which is exactly the option's intent.
 */
export async function commitPlan<G extends GraphDef>(
  target: Store<G>,
  plan: MergePlan<G>,
  expectedBaseVersion?: BaseVersion,
): Promise<MergedCounts> {
  if (!storeBackend(target).capabilities.transactions) {
    throw new MergeError(
      "merge() requires a transaction-capable target backend. The merged plan (canonical upserts, soft-deletes, edge upserts) must commit atomically; a non-transactional fallback would leave a partially-merged graph on a mid-commit failure. (mergeIncremental() enforces the same requirement.)",
      { details: { capability: "transactions" } },
    );
  }
  return withTxConflictRetry(() =>
    target.transaction(async (tx) => {
      // TOCTOU guard: the plan was resolved from reads taken OUTSIDE this
      // transaction, so the target may have been written between the base@V
      // precondition and this commit. Revision-anchored stores check their
      // durable clock under the graph write lock; legacy stores re-derive the
      // content fingerprint through this transaction's snapshot. Either proof
      // ensures the plan still describes the live target before committing.
      if (expectedBaseVersion !== undefined) {
        await assertTargetUnchanged(
          transactionBackend(tx),
          target,
          expectedBaseVersion,
        );
      }
      // Identity ids are re-validated EXPLICITLY even under a base@V match:
      // the legacy fingerprint ranges over CURRENT assertions only, so a row
      // that claimed a planned id in the window and was then ended would pass
      // the token check and fail generically inside the applier.
      await assertPlannedIdentityIdsFresh(target, transactionBackend(tx), plan);
      return applyMergePlan(
        plan,
        tx.nodes as unknown as TxNodes,
        tx.edges as unknown as TxEdges,
        target,
        transactionBackend(tx),
      );
    }, mergeCommitTransactionOptions(target)),
  );
}

/**
 * Isolation for the merge commit transaction. SERIALIZABLE closes the window
 * between the in-transaction re-validation reads and COMMIT on multi-writer
 * Postgres (SSI aborts a racing writer with SQLSTATE 40001, which
 * {@link withTxConflictRetry} retries); SQLite and PGlite serialize writers by
 * construction, and the SQLite backend ignores the option.
 */
const MERGE_COMMIT_TX_OPTIONS = {
  isolationLevel: "serializable",
} as const satisfies TransactionOptions;

function mergeCommitTransactionOptions<G extends GraphDef>(
  target: Store<G>,
): TransactionOptions | undefined {
  // Recorded-time capture only supports read-committed transactions because it
  // allocates its durable clock inside the write transaction. Revision-anchored
  // merges hold that same per-graph lock before checking the anchor, which
  // closes the TOCTOU gap without asking a history store for SERIALIZABLE.
  return target.historyEnabled ? undefined : MERGE_COMMIT_TX_OPTIONS;
}

/**
 * The in-transaction half of the base@V guard: revision-anchored targets read
 * their durable clock under the graph lock; legacy targets recompute their
 * content fingerprint through the transaction-scoped backend. The schema
 * component cannot drift because it is a pure function of the in-memory graph
 * definition.
 */
async function assertTargetUnchanged<G extends GraphDef>(
  txBackend: TransactionBackend,
  target: Store<G>,
  expectedBaseVersion: BaseVersion,
): Promise<void> {
  if (hasRevisionAnchor(expectedBaseVersion)) {
    // All tracked writers acquire this lock before touching graph rows and
    // advance the same clock before committing. Holding it around the
    // read→apply sequence makes the O(1) anchor check a TOCTOU guard without
    // relying on the transaction's snapshot being the latest committed state.
    await lockRecordedGraphWrite(txBackend, target.graphId);
    const expectedOrigin = revisionOriginOf(expectedBaseVersion);
    const liveOrigin = await readRevisionOrigin(
      txBackend,
      target.revisionSchema,
      target.graphId,
    );
    if (liveOrigin !== expectedOrigin) {
      throw new BaseVersionMismatchError(
        "The merge branch was forked from a different revision-tracked store; the resolved plan was not applied.",
        {
          details: { expectedOrigin, liveOrigin },
          suggestion:
            "Merge the branch back into its original base store, or fork a new branch from this target.",
        },
      );
    }
    const liveRevision = await readRecordedClock(
      txBackend,
      target.revisionSchema,
      target.graphId,
    );
    const expectedRevision = revisionAnchorOf(expectedBaseVersion);
    if (liveRevision !== expectedRevision) {
      throw new BaseVersionMismatchError(
        "The merge target was modified between the revision-anchor check and the commit transaction; the resolved plan was not applied.",
        {
          details: { expectedRevision, liveRevision },
          suggestion:
            "Re-run the merge (and re-branch if the divergence is real), or route all graph writes through the revision-tracked Store.",
        },
      );
    }
    return;
  }
  const liveContent = await computeContentComponent(
    txBackend,
    target.graphId,
    target.graph,
    await storeRuntime(target).identityAssertionsAtTarget(txBackend, "state"),
  );
  const expectedContent = contentComponentOf(expectedBaseVersion);
  if (liveContent !== expectedContent) {
    throw new BaseVersionMismatchError(
      "The merge target was modified between the base@V check and the commit transaction; the resolved plan no longer describes the live target and was not applied.",
      {
        details: {
          expectedContentFingerprint: expectedContent,
          liveContentFingerprint: liveContent,
        },
        suggestion:
          "Re-run the merge (and re-branch if the divergence is real), or serialize writers against merges on this target.",
      },
    );
  }
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
  getByIds: (
    ids: readonly string[],
    options?: Readonly<{ temporalMode?: "includeTombstones" }>,
  ) => Promise<readonly (Node | undefined)[]>;
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
  getByIds: (
    ids: readonly string[],
    options?: Readonly<{ temporalMode?: "includeTombstones" }>,
  ) => Promise<readonly (Edge | undefined)[]>;
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
  delete: (id: string) => Promise<void>;
}>;

/** A single edge upsert payload (the element of a {@link EdgeCollectionLike} batch). */
type EdgeUpsert = Parameters<EdgeCollectionLike["bulkUpsertById"]>[0][number];

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
 * divergent schema or base revision, which cannot be merged safely.
 */
async function validateBaseVersions<G extends GraphDef>(
  target: Store<G>,
  branches: readonly GraphBranch<G>[],
): Promise<Result<BaseVersion, BaseVersionMismatchError>> {
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
  return ok(targetVersion);
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
  expectedBaseVersion?: BaseVersion,
): Promise<Result<MergeReport<G>, MergeError>> {
  // Reserved BranchIds are used for non-user contributions. Reject real branches
  // that try to mint them rather than silently corrupting conflict/provenance state.
  let targetBranchSeen = false;
  for (const branch of branches) {
    if (branch.id === BASE_PROVENANCE_BRANCH) {
      return err(
        new MergeError(
          `Branch id "${BASE_PROVENANCE_BRANCH}" is reserved for committed-base provenance and cannot be used as a branch id.`,
          { details: { branchId: branch.id } },
        ),
      );
    }
    if (branch.id === COMMITTED_TARGET_BRANCH) {
      if (
        incremental?.targetBranchId !== COMMITTED_TARGET_BRANCH ||
        targetBranchSeen
      ) {
        return err(
          new MergeError(
            `Branch id "${COMMITTED_TARGET_BRANCH}" is reserved for the committed incremental target and cannot be used as a branch id.`,
            { details: { branchId: branch.id } },
          ),
        );
      }
      targetBranchSeen = true;
    }
  }

  try {
    // (2) stage the provenance-tagged union of every branch's diff. For the
    // incremental path, capture the committed target branch's node versions from
    // its diff enumeration — the plan-time baseline for the commit-time
    // lost-update guard (assertInheritedTargetUnchanged).
    const preferredBranchId = incremental?.targetBranchId;
    const staging = await stageBranches(store, branches, preferredBranchId);

    // Capture the stable branch order ONCE (never wall-clock).
    const branchIds = branches.map((branch) => branch.id);
    const branchOrder =
      preferredBranchId === undefined ?
        (options.branchOrder ?? [])
      : [
          preferredBranchId,
          ...(options.branchOrder ?? []).filter(
            (branchId) => branchId !== preferredBranchId,
          ),
        ];
    const branchRank = buildBranchRank(branchOrder, branchIds);

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
    // configured, precompute the STAGED texts' vectors ONCE (a batched step) so
    // the per-pair `vector`/`hybrid` scoring is a pure in-memory cosine; base-node
    // texts pulled into staged↔base pairs are embedded inside generateAllCandidates
    // (they are not known until the base sources run). With no embedder,
    // `embeddings` stays absent and a vector/hybrid kind surfaces
    // SimilarityUnavailableError in candidate generation.
    const embeddings =
      options.embedder === undefined ?
        undefined
      : await precomputeEmbeddings(
          newNodesByKind(staging),
          options.resolve,
          options.embedder,
        );
    const ctx: SimilarityContext = {
      backend: storeBackend(store),
      ...(embeddings === undefined ? {} : { embeddings }),
    };
    const candidates = await generateAllCandidates(
      target,
      staging,
      options,
      introspectionKinds,
      ctx,
      useBaseSources,
      options.embedder,
    );
    if (isErr(candidates)) {
      return err(candidates.error);
    }

    // Same-id folding joins nodes no assertion names, so the plan-time
    // contradiction simulation needs the LIVE target peers sharing any staged
    // or base id. One kind-free indexed probe; skipped entirely off the fold
    // profile.
    // The identity guard protects EVERY identity-enabled incremental merge —
    // explicit same/different assertions exist under both profiles. Only the
    // same-id peer expansion (and the direct-peer window check) is
    // fold-specific.
    const identityProbeIds =
      target.graph.identity === undefined ?
        undefined
      : [
          ...new Set([
            ...[...newNodesByKind(staging).values()].flatMap((entries) =>
              entries.map((entry) => entry.node.id),
            ),
            ...staging.modifiedNodes.map((entry) => entry.node.id),
            ...candidates.data.baseMembers.map((member) => member.id),
            ...staging.newIdentityAssertions.flatMap((staged) => [
              staged.assertion.a.id,
              staged.assertion.b.id,
            ]),
          ]),
        ];
    const targetPeers =
      identityProbeIds === undefined ?
        []
      : await storeRuntime(target).liveNodesSharingIds(identityProbeIds);

    // The staged retractions' target rows, fetched BEFORE planning: a
    // retraction ends whatever CURRENT row carries its id, so the planner
    // validates each one against the complete truth that id identifies on the
    // target — a current row with DIFFERENT truth (the target reused the id
    // independently) must not be ended by a branch that never saw it.
    const stagedRetractionIds = [
      ...new Set(
        staging.retractedIdentityAssertions.map(
          (staged) => staged.assertion.id,
        ),
      ),
    ];
    const storedRetractionRowsById =
      stagedRetractionIds.length === 0 ?
        NO_STORED_ASSERTIONS
      : await storeRuntime(target).identityAssertionRowsByIds(
          stagedRetractionIds,
        );

    // (4–8) resolve the whole merge into a commit-ready plan.
    const plan = planMerge(
      staging,
      candidates.data.edges,
      candidates.data.warnings,
      candidates.data.baseMembers,
      options,
      branchRank,
      subClassClosure,
      {
        sameIdAcrossKinds: target.graph.identity?.sameIdAcrossKinds,
        areDisjoint: (left, right) => target.registry.areDisjoint(left, right),
      },
      storedRetractionRowsById,
      targetPeers,
      preferredBranchId,
    );

    // The commit guard's baseline must be a VALIDATED state: re-probe the
    // live peers and snapshot the final seeds' classes AFTER planning, then
    // re-run the identity simulation against that exact snapshot — its
    // members join the universe UNLINKED, with connectivity rebuilt from the
    // deletion-filtered fresh ledger and the checker's fold unions. A class
    // change in the plan→snapshot window therefore either fails this recheck
    // as a typed plan-time conflict, or matches the plan; either way the
    // transaction guard never baselines drift the plan did not validate.
    // The probe ranges only over ids the final plan folds on — a window row
    // at an id canonicalization dropped is an unrelated target advance.
    // One-id-one-truth, for BOTH commit modes: two branches staging one id
    // for different truths, or a staged id already identifying different
    // truth in the target (ended rows included), used to surface only inside
    // the commit as a generic wrap of IDENTITY_IMPORT_ID_CONFLICT.
    if (plan.identityAssertions.length > 0) {
      assertOneIdOneTruth(
        plan.identityAssertions,
        await storeRuntime(target).identityAssertionRowsByIds(
          plan.identityAssertions.map((assertion) => assertion.id),
        ),
      );
    }

    let identityGuard:
      NonNullable<IncrementalCommitGuard<G>["identityPeerProbe"]> | undefined;
    if (identityProbeIds !== undefined && incremental !== undefined) {
      const freshPeers =
        await storeRuntime(target).liveNodesSharingIds(identityProbeIds);
      const built = await buildIdentityPeerProbe(
        target,
        identityProbeIds,
        freshPeers,
        plan,
        target.graph.identity?.sameIdAcrossKinds ?? "ignore",
      );
      // Base assertion endpoints must be judged at their post-merge
      // identity, exactly as the in-plan check judged them.
      const canonicalIdentityOf = planCanonicalMap(plan);
      assertNoContradictoryIdentityClosure(
        plan.identityAssertions,
        plan.identityRetractions.map((retraction) => retraction.id),
        // The FRESH target ledger, not the pre-planning staging capture —
        // a `different` committed in the window must invalidate the plan
        // here, as a typed conflict, before it can become the baseline.
        // Connectivity is REBUILT from this deletion-filtered ledger (plus
        // the fold unions inside the checker) rather than from the old
        // closure's member lists: filtering a deleted member out of a class
        // does not model the post-deletion state — deleting a bridge ends
        // its assertions and SPLITS the class, so pre-linking the filtered
        // remainder would falsely reject a plan that deletes the bridge and
        // asserts the ends different.
        built.ledger,
        canonicalIdentityOf,
        plan.retypeMap,
        {
          sameIdAcrossKinds: target.graph.identity?.sameIdAcrossKinds,
          areDisjoint: (left, right) =>
            target.registry.areDisjoint(left, right),
        },
        // The snapshot's (deletion-filtered) class MEMBERS join the universe
        // as unlinked refs: their same-id fold links at ids outside the probe
        // range are re-derived by the checker's fold union, and their
        // assertion links come from the fresh ledger — never from the old
        // class shape itself.
        [...built.probe.seeds, ...built.snapshot.groups.flat()],
      );
      identityGuard = built.probe;
    }

    // (9) commit to the target. Incremental mode commits through the guarded path
    // (the existing-target-id write guard, §6.6); snapshot mode commits directly,
    // re-validating the captured base@V inside the transaction (TOCTOU guard).
    // Identity refusals escaping the commit are translated to the typed
    // conflict error (see translateIdentityCommitError) — the plan-time
    // simulation is the EARLY surface for those refusals, not the only one.
    const commitResolvedPlan = async (): Promise<MergedCounts> =>
      incremental === undefined ?
        await commitPlan(target, plan, expectedBaseVersion)
      : await commitIncrementalPlan(target, plan, {
          stagedNewByKind: newNodesByKind(staging),
          options,
          introspectionKinds,
          ...(identityGuard === undefined ?
            {}
          : { identityPeerProbe: identityGuard }),
          // The committed (kind, id) keys the base sources matched at PLAN time;
          // anything NEW the in-tx re-probe surfaces is a window write.
          plannedBaseMatchKeys: new Set(
            candidates.data.baseMembers.map((member) => mergeKeyOf(member)),
          ),
          targetNodeVersions: staging.targetNodeVersions,
          targetEdgeSignatures: staging.targetEdgeSignatures,
        });
    let merged: MergedCounts;
    try {
      merged = await commitResolvedPlan();
    } catch (error) {
      throw translateIdentityCommitError(error);
    }

    // (10) assemble the report. The full provenance records are always built in the
    // plan; the in-memory index is gated by `provenance`, and on-graph persistence
    // by `persistProvenance`.
    const provenance: ProvenanceIndex =
      options.provenance ?
        buildProvenanceIndex(plan.provenanceRecords)
      : { byBranch: () => ({ nodeIds: [], edgeIds: [] }) };

    const warnings = [...plan.warnings];
    let provenancePersisted: MergeReport<G>["provenancePersisted"];
    if (options.persistProvenance) {
      // POST-COMMIT, best-effort: the graph is already committed, so a provenance
      // write failure must NOT fail the merge — it surfaces as a warning. The
      // sidecar node ids are deterministic, so this UPSERTS (idempotent re-runs).
      try {
        const provenanceStore = await openProvenanceStore(target);
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

  // (1) base@V precondition — the snapshot contract. The validated token is
  // re-checked INSIDE the commit transaction (see `commitPlan`), so a target
  // write landing between this check and the commit fails typed instead of
  // committing a stale plan.
  const precondition = await validateBaseVersions(target, branches);
  if (isErr(precondition)) {
    return err(precondition.error);
  }

  return resolveMerge(
    store,
    target,
    branches,
    options,
    false,
    undefined,
    precondition.data,
  );
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
 * NOT re-exported from the package barrel. The public incremental surface over it
 * is {@link mergeIncremental} (§6.6), which adds the fork-point precondition, the
 * keep-base pin, and the transaction-scoped existing-row guard. `merge()` and its
 * snapshot precondition are unchanged.
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

  // No branch-level base@V precondition here (the synthetic scope's contract),
  // but PLAN STABILITY still holds: the token captured before any planning
  // read is re-validated inside the commit transaction, so the target must not
  // move while THIS merge is in flight.
  const expectedBaseVersion = await computeBaseVersion(target);
  return resolveMerge(
    store,
    target,
    branches,
    options,
    true,
    undefined,
    expectedBaseVersion,
  );
}

// --- mergeIncremental: full fork-point-vs-live-target entry point (§6.6) -------

/** Internal config carried into {@link resolveMerge} for incremental mode. */
type IncrementalConfig = Readonly<{
  targetBranchId: BranchId;
}>;

/**
 * Incremental precondition: every branch must have forked from THIS fork-point, so
 * the fork-point diff (fork-point → branch) is honest. The analogue of
 * {@link validateBaseVersions}, repointed from `target` to `forkPoint` (§6.6).
 */
async function validateForkPointVersions<G extends GraphDef>(
  forkPoint: Store<G>,
  branches: readonly GraphBranch<G>[],
): Promise<Result<BaseVersion, BaseVersionMismatchError>> {
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
  return ok(forkVersion);
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

type PlannedNodeWrite = Readonly<{
  identity: MergeKey;
  kind: string;
  id: AnyNodeId;
  props: Readonly<Record<string, unknown>>;
}>;

function plannedNodeWrites<G extends GraphDef>(
  plan: MergePlan<G>,
): readonly PlannedNodeWrite[] {
  const canonicalIdentities = new Set<MergeKey>();
  for (const entity of plan.canonicalEntities) {
    canonicalIdentities.add(mergeKey(entity.kind, entity.canonicalId));
  }
  const survivingModProps = new Map<
    MergeKey,
    Readonly<Record<string, unknown>>
  >();
  for (const modification of plan.survivingModifications) {
    survivingModProps.set(
      mergeKeyOf(modification.node),
      modification.node.forkProps,
    );
  }

  const writes: PlannedNodeWrite[] = [];
  for (const modification of plan.survivingModifications) {
    const identity = mergeKeyOf(modification.node);
    if (plan.nodeDeletions.has(identity) || canonicalIdentities.has(identity)) {
      continue;
    }
    writes.push({
      identity,
      kind: modification.node.kind,
      id: modification.node.id,
      props: modification.node.forkProps,
    });
  }
  for (const entity of plan.canonicalEntities) {
    const sourceIdentity = mergeKey(entity.kind, entity.canonicalId);
    if (plan.nodeDeletions.has(sourceIdentity)) {
      continue;
    }
    const kind = plan.retypeMap.get(sourceIdentity) ?? entity.kind;
    const forkProps = survivingModProps.get(sourceIdentity);
    writes.push({
      identity: mergeKey(kind, entity.canonicalId),
      kind,
      id: entity.canonicalId,
      props:
        forkProps === undefined ?
          entity.props
        : { ...entity.props, ...forkProps },
    });
  }
  return writes;
}

function edgeWriteSignature<G extends GraphDef>(
  edge: MergedEdge,
  plan: MergePlan<G>,
): string {
  const from = finalEdgeFrom(edge, plan);
  const to = finalEdgeTo(edge, plan);
  return JSON.stringify([
    edge.kind,
    from.kind,
    from.id,
    to.kind,
    to.id,
    canonicalizeProps(edge.props),
  ]);
}

async function validateIncrementalNodeWrites<G extends GraphDef>(
  target: Store<G>,
  nodesApi: TxNodes,
  plan: MergePlan<G>,
): Promise<void> {
  const writes = plannedNodeWrites(plan);
  const nodeIdsByKind = new Map<string, AnyNodeId[]>();
  for (const write of writes) {
    const bucket = nodeIdsByKind.get(write.kind) ?? [];
    bucket.push(write.id);
    nodeIdsByKind.set(write.kind, bucket);
  }

  const currentByIdentity = new Map<MergeKey, Node | undefined>();
  for (const [kind, ids] of nodeIdsByKind) {
    const rows = await nodeCollection(nodesApi, kind).getByIds(
      ids,
      INCLUDE_TOMBSTONES,
    );
    for (const [index, id] of ids.entries()) {
      currentByIdentity.set(mergeKey(kind, id), rows[index]);
    }
  }

  for (const write of writes) {
    const current = currentByIdentity.get(write.identity);
    if (current === undefined) {
      continue;
    }
    if (current.meta.deletedAt !== undefined) {
      throw new MergeError(
        `mergeIncremental() would resurrect soft-deleted committed node "${write.id}" (kind "${write.kind}").`,
        { details: { id: write.id, kind: write.kind } },
      );
    }
    const analysis = analyzeRevalidatingWrite(
      nodeSchemaFor(target, write.kind),
      nodeProps(current),
      write.props,
    );
    assertValidRevalidatingWrite(
      analysis,
      `mergeIncremental() found an existing committed node "${write.id}" (kind "${write.kind}") whose current props do not validate against the active schema.`,
      { id: write.id, kind: write.kind },
    );
    if (analysis.stripsCurrentProps && analysis.schemaWouldChange) {
      throw new MergeError(
        `mergeIncremental() would update committed node "${write.id}" (kind "${write.kind}") but the write would strip existing props outside the active schema (lossy base update).`,
        { details: { id: write.id, kind: write.kind } },
      );
    }
  }
}

async function validateIncrementalEdgeWrites<G extends GraphDef>(
  target: Store<G>,
  edgesApi: TxEdges,
  plan: MergePlan<G>,
): Promise<void> {
  const signatureById = new Map<EdgeId, string>();
  for (const edge of plan.mergedEdges) {
    const signature = edgeWriteSignature(edge, plan);
    const existing = signatureById.get(edge.id);
    if (existing !== undefined && existing !== signature) {
      throw new MergeError(
        `mergeIncremental() would overwrite committed edge "${edge.id}" with multiple planned endpoint/prop shapes (edge.id collision).`,
        { details: { id: edge.id } },
      );
    }
    signatureById.set(edge.id, signature);
  }

  // Bucket the planned edges by their PLANNED kind and fetch each kind's ids in a
  // single round-trip. An edge belongs to exactly one kind, so this does O(edges)
  // lookups instead of scanning EVERY schema edge kind for every id (the old
  // O(edgeKinds × edges) fan-out that held the write lock far longer than needed).
  const plannedKindById = new Map<EdgeId, string>();
  const idsByKind = new Map<string, EdgeId[]>();
  for (const edge of plan.mergedEdges) {
    if (plannedKindById.has(edge.id)) {
      continue; // shape already deduped by the signature guard above
    }
    plannedKindById.set(edge.id, edge.kind);
    const bucket = idsByKind.get(edge.kind) ?? [];
    bucket.push(edge.id);
    idsByKind.set(edge.kind, bucket);
  }
  const existingById = new Map<string, Edge>();
  for (const [kind, ids] of idsByKind) {
    const rows = await edgeCollection(edgesApi, kind).getByIds(
      ids,
      INCLUDE_TOMBSTONES,
    );
    for (const [index, id] of ids.entries()) {
      const row = rows[index];
      if (row !== undefined) {
        existingById.set(id, row);
      }
    }
  }

  // Cross-kind collision guard: edge ids are GLOBALLY unique, so an id NOT found
  // under its planned kind may still be committed under a DIFFERENT kind — a silent
  // overwrite hazard. Scan the schema's edge kinds for ONLY those not-found ids,
  // through the transaction's collections (never `target.backend`, whose separate
  // connection would deadlock against the tx-held one). An update-only merge finds
  // every edge in the bucketed pass above, so this fallback is empty.
  const notFound = [...plannedKindById.keys()]
    .filter((id) => !existingById.has(id))
    .sort((left, right) => compareStrings(left, right));
  if (notFound.length > 0) {
    // Sequential: all queries share the same transaction client (a single
    // pg PoolClient). Concurrent client.query() calls on a PoolClient queue
    // with a deprecation warning in pg@8 and become an error in pg@9.
    const crossKindById = new Map<string, Edge>();
    for (const kind of Object.keys(target.graph.edges)) {
      const rows = await edgeCollection(edgesApi, kind).getByIds(
        notFound,
        INCLUDE_TOMBSTONES,
      );
      for (const [index, id] of notFound.entries()) {
        const row = rows[index];
        if (row !== undefined && !crossKindById.has(id)) {
          crossKindById.set(id, row);
        }
      }
    }
    for (const id of notFound) {
      const row = crossKindById.get(id);
      if (row === undefined) {
        continue;
      }
      if (row.meta.deletedAt !== undefined) {
        throw new MergeError(
          `mergeIncremental() would resurrect soft-deleted committed edge "${id}" (kind "${row.kind}").`,
          { details: { id, committedKind: row.kind } },
        );
      }
      throw new MergeError(
        `mergeIncremental() would overwrite committed edge "${id}" (kind "${row.kind}") with a different-kind edge "${requireDefined(plannedKindById.get(id))}" of the same id.`,
        {
          details: {
            id,
            committedKind: row.kind,
            plannedKind: requireDefined(plannedKindById.get(id)),
          },
        },
      );
    }
  }

  for (const edge of plan.mergedEdges) {
    const current = existingById.get(edge.id);
    if (current === undefined) {
      continue;
    }
    // `current` was fetched under `edge.kind`, so its kind matches by construction;
    // a different committed kind for this id is caught by the cross-kind guard above.
    if (current.meta.deletedAt !== undefined) {
      throw new MergeError(
        `mergeIncremental() would resurrect soft-deleted committed edge "${edge.id}" (kind "${current.kind}").`,
        { details: { id: edge.id, committedKind: current.kind } },
      );
    }

    const from = finalEdgeFrom(edge, plan);
    const to = finalEdgeTo(edge, plan);
    if (
      current.fromId !== from.id ||
      current.fromKind !== from.kind ||
      current.toId !== to.id ||
      current.toKind !== to.kind
    ) {
      throw new MergeError(
        `mergeIncremental() would overwrite committed edge "${edge.id}" (kind "${edge.kind}") with different endpoints.`,
        { details: { id: edge.id, kind: edge.kind } },
      );
    }

    const analysis = analyzeRevalidatingWrite(
      edgeSchemaFor(target, edge.kind),
      edgeProps(current),
      edge.props,
    );
    assertValidRevalidatingWrite(
      analysis,
      `mergeIncremental() found an existing committed edge "${edge.id}" (kind "${edge.kind}") whose current props do not validate against the active schema.`,
      { id: edge.id, kind: edge.kind },
    );
    if (analysis.stripsCurrentProps && analysis.schemaWouldChange) {
      throw new MergeError(
        `mergeIncremental() would update committed edge "${edge.id}" (kind "${edge.kind}") but the write would strip existing props outside the active schema.`,
        { details: { id: edge.id, kind: edge.kind } },
      );
    }
  }
}

/**
 * The reads `commitIncrementalPlan` needs to re-run the NEW-vs-BASE identity
 * resolution INSIDE the commit transaction — the inputs to {@link
 * collectBaseMatchKeys}, plus the set of committed `(kind, id)` keys those base
 * sources matched at PLAN time. Comparing the two closes the identity-resolution
 * TOCTOU window (see {@link assertBaseResolutionStable}).
 */
type IncrementalCommitGuard<G extends GraphDef> = Readonly<{
  stagedNewByKind: ReadonlyMap<string, readonly StagedNewNode[]>;
  options: NormalizedMergeOptions<G>;
  introspectionKinds: ReadonlyMap<string, readonly UniqueIntrospection[]>;
  plannedBaseMatchKeys: ReadonlySet<MergeKey>;
  /**
   * `(kind, id) -> version` for every committed target node observed while
   * planning (the target-branch diff enumeration). The commit-time guard
   * re-reads the rows the plan writes OR deletes and refuses if any inherited
   * row's version advanced in the plan→commit window — a concurrent write the
   * stale plan would otherwise overwrite (lost update).
   */
  targetNodeVersions: ReadonlyMap<MergeKey, number>;
  /**
   * `(kind, id) -> content signature` for every committed target edge observed
   * while planning. The edge-half analogue of {@link targetNodeVersions}: edges
   * have no version, so the guard fingerprints their mergeable content
   * (endpoints, liveness, canonical props) and refuses if the fingerprint of an
   * edge the plan upserts OR deletes drifted in the plan→commit window.
   */
  targetEdgeSignatures: ReadonlyMap<MergeKey, string>;
  /**
   * The plan-time same-id fold probe: the bare ids probed and the live peer
   * keys observed. Absent off the fold profile. The commit-time guard repeats
   * the kind-free lookup through the transaction backend and refuses if the
   * live peer set drifted — a same-id peer inserted in the plan→commit window
   * could fold the plan's nodes into classes (including disjoint-kind
   * contradictions) the plan-time simulation never saw.
   */
  identityPeerProbe?: Readonly<{
    /**
     * The target's identity profile. The direct-peer window check below only
     * applies under `"fold"` — a same-id row appearing under `"ignore"` never
     * changes plan legality, so refusing on it would reject an unrelated
     * target advance.
     */
    profile: "fold" | "ignore";
    ids: readonly string[];
    observed: ReadonlySet<MergeKey>;
    /**
     * The plan's node deletions, by composite key. Rows the plan removes are
     * excluded from BOTH sides of every comparison — they are gone in the
     * committed state, so treating them as present would falsely reject a
     * legal delete-and-replace (and a still-live-at-tx-time row the plan
     * deletes must not read as an "appeared" peer either).
     */
    plannedDeletions: ReadonlySet<MergeKey>;
    /**
     * Every `(kind, id)` the guarded universe contains — the seeds plus all
     * snapshot class members. The negative-truth fingerprint below ranges
     * over `different` assertions touching this set.
     */
    memberKeys: ReadonlySet<MergeKey>;
    /**
     * Deterministic fingerprint of the CURRENT `different` assertions
     * touching the guarded universe at snapshot time. Negative truth changes
     * plan legality without moving peers, liveness, or equivalence classes,
     * so it needs its own drift signal.
     */
    differentFingerprint: string;
    /**
     * The plan-time structural identity class of every final fold seed,
     * serialized to a comparable fingerprint per seed. The direct-peer set
     * above covers planned ids that do not exist yet; this covers
     * class-TRANSITIVE drift — a window row or assertion joining a seed's
     * class through another member changes the class without changing the
     * seed's direct same-id peers.
     */
    classFingerprints: ReadonlyMap<string, string>;
    seeds: readonly Readonly<{ kind: string; id: string }>[];
  }>;
}>;

/**
 * Narrows the plan-time fold probe to the ids the FINAL plan folds on: the
 * commit-ready canonical node identities (minus planned deletions) and the
 * remapped assertion endpoints. The observed peer set is filtered the same
 * way so the in-transaction comparison ranges over one universe.
 */
async function buildIdentityPeerProbe<G extends GraphDef>(
  target: Store<G>,
  probedIds: readonly string[],
  targetPeers: readonly Readonly<{ kind: string; id: string }>[],
  plan: MergePlan<G>,
  profile: "fold" | "ignore",
): Promise<
  Readonly<{
    probe: NonNullable<IncrementalCommitGuard<G>["identityPeerProbe"]>;
    snapshot: IdentityClassSnapshot;
    ledger: readonly LedgerAssertion[];
  }>
> {
  const finalIds = new Set([
    ...plan.canonicalEntities
      .filter(
        (entity) =>
          !plan.nodeDeletions.has(mergeKey(entity.kind, entity.canonicalId)),
      )
      .map((entity) => entity.canonicalId),
    ...plan.identityAssertions.flatMap((assertion) => [
      assertion.a.id,
      assertion.b.id,
    ]),
  ]);
  const plannedDeletions = new Set<MergeKey>(plan.nodeDeletions.keys());
  const relevantPeers = targetPeers.filter(
    (peer) =>
      finalIds.has(peer.id) &&
      !plannedDeletions.has(mergeKey(peer.kind, peer.id)),
  );
  // The fold seeds whose classes plan legality depends on: the commit-ready
  // canonical nodes (final retyped kinds), the remapped assertion endpoints,
  // and the live target peers anchoring them into existing classes.
  const seedsByKey = new Map<string, Readonly<{ kind: string; id: string }>>();
  const addSeed = (kind: string, id: string): void => {
    seedsByKey.set(mergeKey(kind, id), { kind, id });
  };
  for (const entity of plan.canonicalEntities) {
    const sourceKey = mergeKey(entity.kind, entity.canonicalId);
    if (plan.nodeDeletions.has(sourceKey)) continue;
    addSeed(plan.retypeMap.get(sourceKey) ?? entity.kind, entity.canonicalId);
  }
  for (const assertion of plan.identityAssertions) {
    addSeed(assertion.a.kind, assertion.a.id);
    addSeed(assertion.b.kind, assertion.b.id);
  }
  for (const peer of relevantPeers) addSeed(peer.kind, peer.id);
  const seeds = [...seedsByKey.values()];
  const liveKeys = new Set(
    targetPeers
      .map((peer) => mergeKey(peer.kind, peer.id))
      .filter((key) => !plannedDeletions.has(key)),
  );
  const snapshot = await snapshotIdentityClasses(
    target,
    seeds,
    liveKeys,
    plannedDeletions,
  );
  const memberKeys = new Set<MergeKey>([
    ...seeds.map((seed) => mergeKey(seed.kind, seed.id)),
    ...snapshot.groups.flatMap((group) =>
      group.map((member) => mergeKey(member.kind, member.id)),
    ),
  ]);
  // Negative truth is invisible to peers, liveness, and class structure, so
  // the CURRENT ledger touching the universe is read fresh here: the recheck
  // validates the plan against it, and its `different` slice is fingerprinted
  // for the in-transaction comparison.
  const ledger = (
    await relevantLedgerAssertions(target, memberKeys, storeBackend(target))
  ).filter(
    (assertion) =>
      !plannedDeletions.has(mergeKey(assertion.a.kind, assertion.a.id)) &&
      !plannedDeletions.has(mergeKey(assertion.b.kind, assertion.b.id)),
  );
  return {
    probe: {
      profile,
      plannedDeletions,
      ids: probedIds.filter((id) => finalIds.has(id)),
      observed: new Set(
        relevantPeers.map((peer) => mergeKey(peer.kind, peer.id)),
      ),
      memberKeys,
      differentFingerprint: differentLedgerFingerprint(ledger),
      classFingerprints: snapshot.fingerprints,
      seeds,
    },
    snapshot,
    ledger,
  };
}

type IdentityClassSnapshot = Readonly<{
  /**
   * One comparable fingerprint per seed: the seed's LIVENESS plus its sorted
   * class member tuples, JSON-encoded — structural encoding because caller
   * ids may contain any character, so a joined string is not injective, and
   * the liveness bit because a live singleton and a deleted or missing one
   * have identical (self-coalesced) classes.
   */
  fingerprints: ReadonlyMap<string, string>;
  /** The raw class member groups, for revalidating the plan against them. */
  groups: readonly (readonly Readonly<{ kind: string; id: string }>[])[];
}>;

async function snapshotIdentityClasses<G extends GraphDef>(
  target: Store<G>,
  seeds: readonly Readonly<{ kind: string; id: string }>[],
  liveKeys: ReadonlySet<MergeKey>,
  plannedDeletions: ReadonlySet<MergeKey>,
  txBackend?: TransactionBackend,
): Promise<IdentityClassSnapshot> {
  const classes = await storeRuntime(target).structuralIdentityClasses(
    seeds,
    txBackend,
  );
  const fingerprints = new Map<string, string>();
  const groups: (readonly Readonly<{ kind: string; id: string }>[])[] = [];
  for (const seed of seeds) {
    const key = mergeKey(seed.kind, seed.id);
    // The service keys classes by `JSON.stringify([kind, id])`. Members the
    // plan DELETES are excluded on both sides of the comparison — the
    // committed state no longer contains them, so keeping them would reject
    // a legal delete-and-replace.
    const members = (
      classes.get(JSON.stringify([seed.kind, seed.id])) ?? [seed]
    ).filter(
      (member) => !plannedDeletions.has(mergeKey(member.kind, member.id)),
    );
    groups.push(members);
    fingerprints.set(key, encodeClassFingerprint(liveKeys.has(key), members));
  }
  return { fingerprints, groups };
}

type LedgerAssertion = Readonly<{
  id: string;
  relation: "same" | "different";
  a: Readonly<{ kind: string; id: string }>;
  b: Readonly<{ kind: string; id: string }>;
  validFrom: string;
  validTo?: string | undefined;
}>;

/**
 * The target's CURRENT assertions touching the guarded universe, read fresh
 * from `backend` (the tx backend inside the commit transaction).
 */
async function relevantLedgerAssertions<G extends GraphDef>(
  target: Store<G>,
  memberKeys: ReadonlySet<MergeKey>,
  backend: GraphBackend | TransactionBackend,
): Promise<readonly LedgerAssertion[]> {
  const current = await storeRuntime(target).identityAssertionsAtTarget(
    backend,
    "state",
  );
  return current.filter(
    (assertion) =>
      memberKeys.has(mergeKey(assertion.a.kind, assertion.a.id)) ||
      memberKeys.has(mergeKey(assertion.b.kind, assertion.b.id)),
  );
}

/** Deterministic fingerprint of the `different` assertions in a ledger slice. */
function differentLedgerFingerprint(
  assertions: readonly LedgerAssertion[],
): string {
  return JSON.stringify(
    assertions
      .filter((assertion) => assertion.relation === "different")
      .map((assertion) => [
        assertion.id,
        assertion.a.kind,
        assertion.a.id,
        assertion.b.kind,
        assertion.b.id,
      ])
      .toSorted((left, right) =>
        compareStrings(left.join("\u0000"), right.join("\u0000")),
      ),
  );
}

/**
 * @internal Exported for deterministic verification. Structural (JSON)
 * encoding of a seed's liveness plus its sorted class member tuples —
 * injective even when ids contain the separator characters a joined string
 * would collide on.
 */
export function encodeClassFingerprint(
  live: boolean,
  members: readonly Readonly<{ kind: string; id: string }>[],
): string {
  return JSON.stringify([
    live,
    members
      .map((member) => [member.kind, member.id] as const)
      .toSorted(([leftKind, leftId], [rightKind, rightId]) =>
        compareMergeKeys(
          mergeKey(leftKind, leftId),
          mergeKey(rightKind, rightId),
        ),
      ),
  ]);
}

/** The complete truth an assertion id identifies, as a comparable string. */
function assertionTruthKey(assertion: LedgerAssertion): string {
  return JSON.stringify([
    assertion.relation,
    assertion.a.kind,
    assertion.a.id,
    assertion.b.kind,
    assertion.b.id,
    assertion.validFrom,
    assertion.validTo ?? null,
  ]);
}

/**
 * The immutable identity of a ledger row — everything but `validTo`. Two
 * captures of ONE row always agree on this key (retraction only sets
 * `validTo`), so it is the right comparator for "is the target's row the same
 * assertion the branch retracted": the branch's staged copy carries its own end
 * timestamp while the target's current row carries none, which makes the
 * complete {@link assertionTruthKey} unusable for that question.
 */
function assertionIdentityKey(assertion: LedgerAssertion): string {
  return JSON.stringify([
    assertion.relation,
    assertion.a.kind,
    assertion.a.id,
    assertion.b.kind,
    assertion.b.id,
    assertion.validFrom,
  ]);
}

/**
 * One assertion id identifies ONE complete truth — the invariant the import
 * coordinator enforces with `IDENTITY_IMPORT_ID_CONFLICT` inside the commit.
 * Validated here at plan time instead: intra-plan (two branches staging one
 * id for different truths) and against every stored row for those ids —
 * ended rows included, exactly the set the importer compares. An exact match
 * is fine (the importer skips it as already applied).
 */
function assertOneIdOneTruth(
  planned: readonly IdentityTransferAssertion[],
  storedById: ReadonlyMap<string, LedgerAssertion>,
): void {
  const plannedById = new Map<string, IdentityTransferAssertion>();
  for (const assertion of planned) {
    const previous = plannedById.get(assertion.id);
    if (
      previous !== undefined &&
      assertionTruthKey(previous) !== assertionTruthKey(assertion)
    ) {
      throw new IdentityMergeConflictError(
        "One assertion id was staged for two different identity truths.",
        {
          details: {
            assertionId: assertion.id,
            first: previous,
            second: assertion,
          },
        },
      );
    }
    plannedById.set(assertion.id, assertion);
    const stored = storedById.get(assertion.id);
    if (
      stored !== undefined &&
      assertionTruthKey(stored) !== assertionTruthKey(assertion)
    ) {
      throw new IdentityMergeConflictError(
        "A staged assertion id already identifies different truth in the target ledger.",
        { details: { assertionId: assertion.id, staged: assertion, stored } },
      );
    }
  }
}

/**
 * In-transaction freshness of every planned assertion and retraction id,
 * shared by BOTH commit modes. The plan validated each id against the target's
 * ledger as of planning; a row committed (or ended) in the plan→commit window
 * can claim a planned id — with endpoints entirely outside the guarded member
 * universe — without moving the legacy base@V token, which fingerprints
 * CURRENT assertions only. A planned NEW assertion refuses when its id
 * identifies any different complete truth (ended rows included, exactly the
 * set the applier compares); a planned RETRACTION refuses when the CURRENT row
 * its id ends is no longer the truth the branch retracted.
 */
async function assertPlannedIdentityIdsFresh<G extends GraphDef>(
  target: Store<G>,
  txBackend: TransactionBackend,
  plan: MergePlan<G>,
): Promise<void> {
  const plannedIds = [
    ...plan.identityAssertions.map((assertion) => assertion.id),
    ...plan.identityRetractions.map((retraction) => retraction.id),
  ];
  if (plannedIds.length === 0) return;
  const storedById = await storeRuntime(target).identityAssertionRowsByIds(
    plannedIds,
    txBackend,
  );
  for (const assertion of plan.identityAssertions) {
    const stored = storedById.get(assertion.id);
    if (
      stored !== undefined &&
      assertionTruthKey(stored) !== assertionTruthKey(assertion)
    ) {
      throw new BaseVersionMismatchError(
        "The merge validated its assertion ids as of planning, but a row identifying different truth under a planned id was committed before the commit transaction. Re-plan against the current target.",
        { details: { assertionId: assertion.id } },
      );
    }
  }
  for (const retraction of plan.identityRetractions) {
    const stored = storedById.get(retraction.id);
    if (
      stored !== undefined &&
      stored.validTo === undefined &&
      assertionIdentityKey(stored) !== assertionIdentityKey(retraction)
    ) {
      throw new BaseVersionMismatchError(
        "The merge validated each planned retraction against the target row its id identified at planning, but that row's truth changed before the commit transaction. Re-plan against the current target.",
        { details: { assertionId: retraction.id } },
      );
    }
  }
}

/**
 * Codes the identity service raises for ENVIRONMENT problems — a missing
 * profile, a non-atomic backend, an undersized bind budget. These are not
 * statements about identity truth, so they pass through untranslated; every
 * other identity refusal escaping the commit IS a truth conflict.
 */
const IDENTITY_ENVIRONMENT_CODES: ReadonlySet<string> = new Set([
  "IDENTITY_MERGE_REQUIRES_PROFILE",
  "IDENTITY_REQUIRES_ATOMIC_BACKEND",
  "IDENTITY_REQUIRES_STATEMENT_EXECUTION",
  "IDENTITY_BIND_BUDGET_TOO_SMALL",
]);

/**
 * The commit-phase completeness backstop for identity invariants. The planner
 * SIMULATES the identity applier's rules to refuse illegal plans early and
 * typed — but a simulation can lag the applier, and an invariant it does not
 * (yet) mirror would surface as the generic merge wrapper around the applier's
 * refusal. Translating every identity-typed refusal that escapes the commit
 * into the typed conflict error (cause preserved) gives NEW applier invariants
 * a typed surface by construction instead of by hand-built plan-time twins.
 *
 * Typed {@link MergeError}s (the guards' own refusals) and non-identity
 * failures pass through unchanged.
 *
 * @internal Exported for isolated verification of the translation contract.
 */
export function translateIdentityCommitError(error: unknown): unknown {
  if (error instanceof MergeError) return error;
  if (!(error instanceof TypeGraphError)) return error;
  const detailCode = error.details["code"];
  const identityCode =
    typeof detailCode === "string" && detailCode.startsWith("IDENTITY_") ?
      detailCode
    : error.code.startsWith("IDENTITY_") ? error.code
    : undefined;
  const identityRefusal =
    error instanceof IdentityContradictionError ||
    (identityCode !== undefined &&
      !IDENTITY_ENVIRONMENT_CODES.has(identityCode));
  if (!identityRefusal) return error;
  return new IdentityMergeConflictError(
    `The identity applier refused the resolved plan inside the commit transaction — identity truth on the target is incompatible with the plan. Re-plan against the current target. Cause: ${describeCause(error)}`,
    {
      cause: error,
      details: { ...(identityCode === undefined ? {} : { identityCode }) },
    },
  );
}

/** The plan's recorded resolutions as a source→canonical identity map. */

function planCanonicalMap<G extends GraphDef>(
  plan: MergePlan<G>,
): ReadonlyMap<MergeKey, MergeKey> {
  const canonicalIdentityOf = new Map<MergeKey, MergeKey>();
  for (const resolution of plan.resolutions) {
    for (const memberId of resolution.memberIds) {
      canonicalIdentityOf.set(
        mergeKey(resolution.kind, memberId),
        mergeKey(resolution.kind, resolution.canonicalId),
      );
    }
  }
  return canonicalIdentityOf;
}

/**
 * Fold-peer TOCTOU guard: proves the identity state the plan-time simulation
 * validated still holds inside the commit transaction — direct peers,
 * per-seed class/liveness fingerprints, the negative ledger, and finally the
 * FULL simulation re-run on transaction reads (drift that leaves every
 * fingerprint unchanged, like a redundant `same(a, b)` that becomes decisive
 * once the plan removes the pair's bridge, can only be caught by
 * re-deriving legality itself). Drift is refused as the same typed replan
 * error the other window guards raise.
 */
async function assertIdentityPeersStable<G extends GraphDef>(
  target: Store<G>,
  txBackend: TransactionBackend,
  guard: IncrementalCommitGuard<G>,
  plan: MergePlan<G>,
): Promise<void> {
  const probe = guard.identityPeerProbe;
  if (probe === undefined) return;
  const live = (
    await storeRuntime(target).liveNodesSharingIds(probe.ids, txBackend)
  ).filter((peer) => !probe.plannedDeletions.has(mergeKey(peer.kind, peer.id)));
  // Under "fold" ANY new same-id peer changes the classes the plan folded
  // on; under "ignore" only a peer of a kind DISJOINT with a seed sharing
  // its id changes legality (the create-time disjoint-id constraint) — a
  // benign same-id row is an unrelated target advance.
  const seedKindsById = new Map<string, Set<string>>();
  for (const seed of probe.seeds) {
    const kinds = seedKindsById.get(seed.id) ?? new Set<string>();
    kinds.add(seed.kind);
    seedKindsById.set(seed.id, kinds);
  }
  const appeared = live
    .filter(
      (peer) =>
        probe.profile === "fold" ||
        [...(seedKindsById.get(peer.id) ?? [])].some((kind) =>
          target.registry.areDisjoint(peer.kind, kind),
        ),
    )
    .map((peer) => mergeKey(peer.kind, peer.id))
    .filter((key) => !probe.observed.has(key))
    .sort((left, right) => compareMergeKeys(left, right));
  if (appeared.length > 0) {
    throw new BaseVersionMismatchError(
      `mergeIncremental() simulated identity folding against the target's live same-id peers as of planning, but ${appeared.length} committed row(s) sharing a planned node's id appeared before the commit transaction. Committing the plan could fold nodes into classes the plan never validated.`,
      { details: { appeared } },
    );
  }
  // Class-transitive drift: a window row or assertion can change a seed's
  // identity class through ANOTHER member without touching the seed's direct
  // same-id peers — and a seed can DISAPPEAR without changing its
  // self-coalesced class, so liveness is part of the fingerprint.
  const { fingerprints: liveFingerprints, groups: liveGroups } =
    await snapshotIdentityClasses(
      target,
      probe.seeds,
      new Set(live.map((peer) => mergeKey(peer.kind, peer.id))),
      probe.plannedDeletions,
      txBackend,
    );
  const drifted = [...probe.classFingerprints]
    .filter(([key, fingerprint]) => liveFingerprints.get(key) !== fingerprint)
    .map(([key]) => key)
    .sort((left, right) => compareStrings(left, right));
  if (drifted.length > 0) {
    throw new BaseVersionMismatchError(
      `mergeIncremental() validated identity against the classes visible at planning, but the identity class of ${drifted.length} node(s) the plan folds on changed before the commit transaction. Committing the plan could contradict identity truth it never validated.`,
      { details: { drifted } },
    );
  }
  // Negative truth: a `different` assertion committed (or retracted) in the
  // window changes plan legality without moving any class or peer.
  const ledger = (
    await relevantLedgerAssertions(target, probe.memberKeys, txBackend)
  ).filter(
    (assertion) =>
      !probe.plannedDeletions.has(mergeKey(assertion.a.kind, assertion.a.id)) &&
      !probe.plannedDeletions.has(mergeKey(assertion.b.kind, assertion.b.id)),
  );
  if (differentLedgerFingerprint(ledger) !== probe.differentFingerprint) {
    throw new BaseVersionMismatchError(
      "mergeIncremental() validated identity against the `different` assertions visible at planning, but that ledger changed before the commit transaction. Committing the plan could contradict identity truth it never validated.",
      { details: {} },
    );
  }
  // One-id-one-truth against TRANSACTION reads: a window row claiming a
  // planned assertion or retraction id (possibly with endpoints entirely
  // outside the guarded member universe, invisible to the ledger slice above)
  // would make the applier fail generically — or end unrelated truth.
  await assertPlannedIdentityIdsFresh(target, txBackend, plan);

  // The decisive backstop: re-run the identity simulation on TRANSACTION
  // reads. Every fingerprint above can survive a window write that still
  // changes post-plan legality — the canonical example is a `same(a, b)`
  // added while a and b are already transitively connected (no class or
  // ledger-slice fingerprint moves) that becomes the surviving link once the
  // plan removes their bridge and asserts them different.
  try {
    assertNoContradictoryIdentityClosure(
      plan.identityAssertions,
      plan.identityRetractions.map((retraction) => retraction.id),
      ledger,
      planCanonicalMap(plan),
      plan.retypeMap,
      {
        sameIdAcrossKinds: probe.profile,
        areDisjoint: (left, right) => target.registry.areDisjoint(left, right),
      },
      [...probe.seeds, ...liveGroups.flat()],
    );
  } catch (error) {
    if (!(error instanceof IdentityMergeConflictError)) throw error;
    throw new BaseVersionMismatchError(
      "mergeIncremental() validated identity as of planning, but identity truth committed before the commit transaction invalidates the plan. Re-plan against the current target.",
      { details: { conflict: error.message } },
    );
  }
}

/**
 * Re-runs the NEW-vs-BASE identity probes — each kind's unique constraints
 * (`baseUnique`) and its declared block index (`baseKey`) — for the staged new
 * nodes against `lookupStore`, returning the set of committed `(kind, id)` keys
 * those probes surface. It computes the lookup keys from the SAME staged props
 * the planner used (typegraph owns key derivation), so the result over the
 * plan-time target reproduces `candidates.baseMembers`, and the result over the
 * tx-snapshot target reveals any committed row that became a match in between.
 *
 * Probes are issued STRICTLY SEQUENTIALLY (one awaited query at a time): inside
 * the commit transaction these run on the single tx-held client, where
 * concurrent `client.query()` calls queue with a pg deprecation warning that
 * becomes an error in pg@9.
 */
async function collectBaseMatchKeys<G extends GraphDef>(
  lookupStore: BaseLookupStore,
  guard: IncrementalCommitGuard<G>,
): Promise<ReadonlySet<MergeKey>> {
  const matched = new Set<MergeKey>();
  for (const [kind, stagedNodes] of guard.stagedNewByKind) {
    const resolveConfig = guard.options.resolve[kind];
    // A kind with no resolve config has no base recall — it never pulls a
    // committed row into scope, so it carries no identity-resolution TOCTOU.
    if (resolveConfig === undefined) {
      continue;
    }
    const collection = lookupStore.nodes[kind];
    if (collection === undefined || stagedNodes.length === 0) {
      continue;
    }
    const items = stagedNodes.map((staged) => ({ props: staged.node.props }));

    for (const constraint of uniqueConstraintsFor(
      guard.introspectionKinds,
      kind,
    )) {
      const matches = await collection.bulkFindByConstraint(
        constraint.name,
        items,
      );
      for (const base of matches) {
        if (base !== undefined) {
          matched.add(mergeKeyOf(base));
        }
      }
    }

    if (resolveConfig.blockIndex !== undefined) {
      const matchesByItem = await collection.bulkFindByIndex(
        resolveConfig.blockIndex,
        items,
      );
      for (const perItem of matchesByItem) {
        for (const base of perItem) {
          matched.add(mergeKeyOf(base));
        }
      }
    }
  }
  return matched;
}

/**
 * The identity-resolution half of the incremental TOCTOU guard. The planner
 * resolves each branch addition against the target's committed rows from reads
 * taken OUTSIDE this transaction (`baseUnique`/`baseKey` in candidate
 * generation). A committed row sharing a branch addition's unique-constraint or
 * block-index key that LANDS in the plan→commit window is invisible to the
 * per-row write guards — they only re-fetch the plan's own write ids — so the
 * stale plan would commit the addition under its own id, leaving a duplicate the
 * base-source resolution would otherwise have collapsed. A unique-constraint
 * collision is still caught at write time by the uniques side-table, but only as
 * a late, opaque failure mid-apply; a non-unique BLOCK-INDEX collision has no
 * such backstop and commits the duplicate SILENTLY. This guard refuses both
 * early and typed, before any row is touched.
 *
 * Re-deriving the matched base keys through the TX-scoped store and comparing
 * them to the plan-time set proves no new identity match appeared. SERIALIZABLE
 * isolation makes the proof race-free on multi-writer Postgres: a concurrent
 * insert that this read would have to see aborts one side with a retryable
 * serialization failure; the retry re-runs this probe and fails typed.
 */
async function assertBaseResolutionStable<G extends GraphDef>(
  lookupStore: BaseLookupStore,
  guard: IncrementalCommitGuard<G>,
): Promise<void> {
  const liveKeys = await collectBaseMatchKeys(lookupStore, guard);
  const appeared = [...liveKeys]
    .filter((key) => !guard.plannedBaseMatchKeys.has(key))
    .sort((left, right) => compareMergeKeys(left, right));
  if (appeared.length === 0) {
    return;
  }
  throw new BaseVersionMismatchError(
    `mergeIncremental() resolved its branch additions against the target as of planning, but ${appeared.length} committed row(s) matching a branch addition's identity key (a unique constraint or block index) were inserted before the commit transaction. Committing the plan would create duplicate entities the base-source resolution would otherwise have collapsed.`,
    {
      details: { appeared },
      suggestion:
        "Re-run mergeIncremental(); the re-planned merge resolves the branch additions against the now-committed rows.",
    },
  );
}

/** A `(kind, id)` the plan will mutate whose identity was an observed target row. */
type InheritedTargetRef = Readonly<{ kind: string; id: string }>;

/** Anything keyed by {@link MergeKey} that can answer a membership check. */
type MergeKeyMembership = Readonly<{ has(key: MergeKey): boolean }>;

/**
 * Buckets the plan's inherited-target mutations by kind, deduped by identity, for
 * a single batched re-read per kind. `identities` filters to the rows observed at
 * plan time (new rows the plan creates have no baseline and are skipped). Both a
 * write and a delete of the same identity collapse to one entry — either way the
 * row is re-checked once.
 */
function bucketInheritedRefsByKind(
  refs: Iterable<InheritedTargetRef>,
  identities: MergeKeyMembership,
): ReadonlyMap<string, readonly string[]> {
  const seen = new Set<MergeKey>();
  const idsByKind = new Map<string, string[]>();
  for (const ref of refs) {
    const identity = mergeKey(ref.kind, ref.id);
    if (!identities.has(identity) || seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    const bucket = idsByKind.get(ref.kind) ?? [];
    bucket.push(ref.id);
    idsByKind.set(ref.kind, bucket);
  }
  return idsByKind;
}

/**
 * The version-check (nodes) and signature-check (edges) halves of the
 * incremental TOCTOU guard share one skeleton — bucket refs by kind, batch-fetch
 * the current rows, compare each against its plan-time baseline, and throw on
 * the first mismatch. `Row` is the fetched row shape and `Expected` the
 * comparable baseline value (a node version or an edge content signature).
 */
async function assertInheritedUnchanged<Row, Expected>(
  args: Readonly<{
    refs: readonly InheritedTargetRef[];
    expected: ReadonlyMap<MergeKey, Expected>;
    fetchRows: (
      kind: string,
      ids: readonly string[],
    ) => Promise<readonly (Row | undefined)[]>;
    deriveValue: (row: Row | undefined) => Expected | undefined;
    buildError: (
      id: string,
      kind: string,
      expected: Expected,
      current: Expected | undefined,
    ) => Error;
  }>,
): Promise<void> {
  if (args.expected.size === 0) {
    return;
  }
  const idsByKind = bucketInheritedRefsByKind(args.refs, args.expected);
  for (const [kind, ids] of idsByKind) {
    const rows = await args.fetchRows(kind, ids);
    for (const [index, id] of ids.entries()) {
      const expected = requireDefined(args.expected.get(mergeKey(kind, id)));
      const current = args.deriveValue(rows[index]);
      if (current === expected) {
        continue;
      }
      throw args.buildError(id, kind, expected, current);
    }
  }
}

/**
 * The inherited-target-row half of the incremental TOCTOU guard. The plan folds
 * the live target in as a preferred branch and resolves inherited modifications
 * against the target rows it enumerated OUTSIDE this transaction. If a committed
 * row the plan mutates was changed in the plan→commit window, applying the plan
 * would discard that write (a silent lost update) — the per-row write guards only
 * check resurrection / lossy strips, not that the row still holds the value the
 * plan merged from.
 *
 * Covers every path that mutates a committed target row: node writes and node
 * deletions (checked by `version`), and edge upserts and edge deletions (checked
 * by content signature, since edges carry no version). For each, it re-reads the
 * committed row through the tx snapshot and refuses if it drifted (or vanished).
 * SERIALIZABLE + retry then re-plans against the now-committed value, exactly as
 * the snapshot path's {@link assertTargetUnchanged} does for full-graph drift.
 */
async function assertInheritedTargetUnchanged<G extends GraphDef>(
  nodesApi: TxNodes,
  edgesApi: TxEdges,
  guard: IncrementalCommitGuard<G>,
  plan: MergePlan<G>,
): Promise<void> {
  // Disjoint collections (nodes vs. edges) with no shared state — safe to run
  // concurrently.
  await Promise.all([
    assertInheritedNodesUnchanged(nodesApi, guard, plan),
    assertInheritedEdgesUnchanged(edgesApi, guard, plan),
  ]);
}

/** Version-checks every committed target node the plan writes or deletes. */
async function assertInheritedNodesUnchanged<G extends GraphDef>(
  nodesApi: TxNodes,
  guard: IncrementalCommitGuard<G>,
  plan: MergePlan<G>,
): Promise<void> {
  const nodeRefs: InheritedTargetRef[] = plannedNodeWrites(plan).map(
    (write) => ({ kind: write.kind, id: write.id }),
  );
  for (const [identity, kind] of plan.nodeDeletions) {
    nodeRefs.push({ kind, id: idOf(identity) });
  }
  await assertInheritedUnchanged<Node, number>({
    refs: nodeRefs,
    expected: guard.targetNodeVersions,
    fetchRows: (kind, ids) =>
      nodeCollection(nodesApi, kind).getByIds(ids, INCLUDE_TOMBSTONES),
    deriveValue: (row) => row?.meta.version,
    buildError: (id, kind, expected, current) =>
      new BaseVersionMismatchError(
        `mergeIncremental() observed committed node "${id}" (kind "${kind}") at version ${expected} while planning, but it changed before the commit transaction; the resolved plan no longer describes the live target and was not applied.`,
        {
          details: {
            id,
            kind,
            expectedVersion: expected,
            currentVersion: current,
          },
          suggestion:
            "Re-run mergeIncremental(); the re-planned merge resolves the inherited modifications against the now-committed rows.",
        },
      ),
  });
}

/**
 * Signature-checks every committed target edge the plan upserts or deletes. Edges
 * carry no `version`, so the plan-time baseline is a content fingerprint
 * ({@link edgeStateSignature}) captured over the target's edge enumeration; a
 * changed fingerprint means the committed edge's endpoints, liveness, or props
 * drifted in the plan→commit window.
 */
async function assertInheritedEdgesUnchanged<G extends GraphDef>(
  edgesApi: TxEdges,
  guard: IncrementalCommitGuard<G>,
  plan: MergePlan<G>,
): Promise<void> {
  const edgeRefs: InheritedTargetRef[] = plan.mergedEdges.map((edge) => ({
    kind: edge.kind,
    id: edge.id,
  }));
  for (const [identity, kind] of plan.edgeDeletions) {
    edgeRefs.push({ kind, id: idOf(identity) });
  }
  await assertInheritedUnchanged<Edge, string>({
    refs: edgeRefs,
    expected: guard.targetEdgeSignatures,
    fetchRows: (kind, ids) =>
      edgeCollection(edgesApi, kind).getByIds(ids, INCLUDE_TOMBSTONES),
    deriveValue: (row) =>
      row === undefined ? undefined : (
        edgeStateSignature({
          fromKind: row.fromKind,
          fromId: row.fromId,
          toKind: row.toKind,
          toId: row.toId,
          live: row.meta.deletedAt === undefined,
          props: edgeProps(row),
        })
      ),
    buildError: (id, kind) =>
      new BaseVersionMismatchError(
        `mergeIncremental() observed committed edge "${id}" (kind "${kind}") while planning, but its endpoints, liveness, or props changed before the commit transaction; the resolved plan no longer describes the live target and was not applied.`,
        {
          details: { id, kind },
          suggestion:
            "Re-run mergeIncremental(); the re-planned merge resolves the inherited modifications against the now-committed rows.",
        },
      ),
  });
}

/**
 * The full incremental commit path (§6.6). The planner has already folded the live
 * target in as a preferred synthetic branch, so this path preflights destructive
 * row hazards inside the target transaction and then applies the normal merge plan.
 */
async function commitIncrementalPlan<G extends GraphDef>(
  target: Store<G>,
  plan: MergePlan<G>,
  guard: IncrementalCommitGuard<G>,
): Promise<MergedCounts> {
  if (!storeBackend(target).capabilities.transactions) {
    throw new MergeError(
      "mergeIncremental() requires a transaction-capable target backend. Incremental writes must preflight existing rows and commit atomically; non-transactional fallback would allow partial graph writes.",
      { details: { capability: "transactions" } },
    );
  }

  // Legacy targets use SERIALIZABLE + retry: the per-row guards read inside
  // this transaction, and SSI turns a conflicting concurrent write into a
  // retryable abort. Recorded-history targets cannot use SERIALIZABLE because
  // capture allocates its clock in read-committed mode; they instead acquire the
  // same graph write lock as every captured write before the guards run. In
  // PostgreSQL read committed each subsequent statement sees committed work that
  // landed before the lock was acquired, while the lock excludes later tracked
  // writes until this plan commits.
  return withTxConflictRetry(() =>
    target.transaction(async (tx) => {
      if (target.revisionTrackingEnabled) {
        await lockRecordedGraphWrite(transactionBackend(tx), target.graphId);
      }
      const nodesApi = tx.nodes as unknown as TxNodes;
      const edgesApi = tx.edges as unknown as TxEdges;
      // Identity-resolution TOCTOU guard: the base-source lookups ran OUTSIDE
      // this transaction, so re-derive them here (tx snapshot) and refuse the
      // plan if a matching committed row appeared in the window. `tx` exposes
      // the same `.nodes` collection record a `BaseLookupStore` needs.
      await assertBaseResolutionStable(tx as unknown as BaseLookupStore, guard);
      // Fold-peer TOCTOU guard: the bare-id peer probe also ran outside this
      // transaction; repeat it on the tx snapshot and refuse on drift.
      await assertIdentityPeersStable(
        target,
        transactionBackend(tx),
        guard,
        plan,
      );
      // Inherited-row TOCTOU guard: refuse if a committed node OR edge the plan
      // writes or deletes changed since it was observed at plan time (lost update).
      await assertInheritedTargetUnchanged(nodesApi, edgesApi, guard, plan);
      await validateIncrementalNodeWrites(target, nodesApi, plan);
      await validateIncrementalEdgeWrites(target, edgesApi, plan);
      return applyMergePlan(
        plan,
        nodesApi,
        edgesApi,
        target,
        transactionBackend(tx),
      );
    }, mergeCommitTransactionOptions(target)),
  );
}

/**
 * Incremental merge — the public fork-point-vs-live-target entry point (design
 * §6.4-B / §6.6). It treats `forkPoint` as the immutable ancestor, folds the live
 * `target` in as a preferred committed branch, resolves branch additions against
 * committed rows, and propagates inherited node/edge modifications and deletions
 * through the same three-way merge planner.
 *
 * Object-form args so the two same-typed stores (`forkPoint`, `target`) cannot be
 * swapped. `options.target` is ignored — `target` is the explicit arg.
 *
 * Preconditions (typed errors): every branch forked from `forkPoint`
 * (`branch.base === computeBaseVersion(forkPoint)`); `forkPoint` and `target` share a
 * schema hash (schema drift is fatal; target CONTENT may have advanced); and
 * `onBasePropertyConflict` is `"flag"` (keep-base for committed-row conflicts).
 */
export async function mergeIncremental<G extends GraphDef>(
  args: MergeIncrementalArguments<G>,
): Promise<Result<MergeReport<G>, MergeError>> {
  const { forkPoint, target, branches } = args;

  const normalized = tryNormalize(args.options ?? {});
  if (isErr(normalized)) {
    return err(normalized.error);
  }
  const options = normalized.data;

  // Keep-base pin: committed rows remain authoritative under unresolved base
  // conflicts. A non-keep-base policy would let a stale branch value overwrite a
  // newer committed value.
  if (options.onBasePropertyConflict !== "flag") {
    return err(
      new MergeError(
        'mergeIncremental() requires onBasePropertyConflict: "flag" (keep-base); a non-keep-base policy could overwrite a newer committed base value with a stale branch value.',
        { details: {} },
      ),
    );
  }

  // Every branch must have forked from THIS fork-point (honest diff).
  const forkPrecondition = await validateForkPointVersions(forkPoint, branches);
  if (isErr(forkPrecondition)) {
    return err(forkPrecondition.error);
  }
  const forkVersion = forkPrecondition.data;

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

  const targetBranch: GraphBranch<G> = {
    id: COMMITTED_TARGET_BRANCH,
    base: forkVersion,
    store: target,
  };
  return resolveMerge(
    forkPoint,
    target,
    [targetBranch, ...branches],
    options,
    true,
    { targetBranchId: COMMITTED_TARGET_BRANCH },
  );
}
