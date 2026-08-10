import { validateEdgeEndpoints } from "../constraints";
import { IdentityEndpointValidityError } from "../errors";
import { createDataKeyedBag, hasOwnKey } from "../utils/object";
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
import {
  BASE_PROVENANCE_BRANCH,
  canonicalizeCluster,
  COMMITTED_TARGET_BRANCH,
} from "./canonicalize";
import { buildSubClassClosure } from "./closures";
import type { ClusterResult } from "./clustering";
import {
  connectedComponents,
  decisiveEdgesForCluster,
  enforceBaseGuard,
  enforceDiameterWithEdges,
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
import {
  BRANCH_CREATED_EDGE_ORIGIN,
  buildCanonicalMap,
  INHERITED_EDGE_ORIGIN,
  repointEdges,
} from "./edge-repoint";
import {
  BaseVersionMismatchError,
  describeCause,
  InvalidMergeOptionsError,
  InvalidMergePlanError,
  MergeError,
  MergePlanCapabilityError,
  MergePlanDigestMismatchError,
  MergePlanningStaleError,
  MergePlanOriginMismatchError,
  MergePlanSchemaMismatchError,
  MergePlanTargetMismatchError,
  StaleMergePlanError,
  translateMergeCommitError,
  UnsupportedMergePlanVersionError,
} from "./errors";
import type { CandidateDiagnostic, CandidateDiagnostics } from "./evidence";
import { compareMatchEvidence } from "./evidence";
import {
  assertIdentityEndpointsNotDeleted,
  assertIdentityPeersStable,
  assertMergedIdentityClassesConsistent,
  assertNoContradictoryIdentityClosure,
  assertOneIdOneTruth,
  assertPlannedIdentityIdsFresh,
  buildIdentityPeerProbe,
  type IdentityPeerProbe,
  type LedgerAssertion,
  NO_STORED_ASSERTIONS,
  planIdentityChanges,
  type PlanIdentityContext,
  remapIdentityAssertionEndpoints,
  RETRACTION_DELETION_OVERRULED_DROP_REASON,
  translateIdentityCommitError,
} from "./merge-identity";
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
import type {
  MergePlanAnchors,
  MergePlanArtifact,
  MergePlanArtifactV1,
  MergePlanArtifactV1Input,
  MergePlanEdgeUpsert,
  MergePlanEntityRef,
  MergePlanNodeUpsert,
  MergePlanTargetFence,
} from "./plan-schema";
import {
  constructMergePlanArtifact,
  validateMergePlanArtifact,
} from "./plan-wire";
import type { ProvenanceGraph } from "./provenance-store";
import {
  contributionKey,
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
  StagedModifiedEdge,
  StagedModifiedNode,
  StagedNewEdge,
  StagedNewNode,
  StagedRetraction,
  StagingSet,
} from "./staging";
import { stageBranches } from "./staging";
import type { ModifiedNode } from "./state-diff";
import { withTxConflictRetry } from "./tx-retry";
import type { ReconcileClusterInput } from "./type-reconcile";
import { mostSpecificCommonKind, reconcileTypes } from "./type-reconcile";
import type {
  Edge,
  EdgeId,
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
  ValidityEndMutation,
} from "./typegraph-internal";
import {
  advanceRevisionClock,
  forceRecordedGraphRevision,
  forceWriteTransactionRevision,
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
  ValidityEndResolution,
} from "./types";
import type { ValidToChange } from "./valid-window";
import { resolveValidWindows } from "./valid-window";

/** A node id in its untyped (`NodeType`-default) branded form. */
type AnyNodeId = NodeId<NodeType>;

/** Reserved synthetic branch id for the live target in `mergeIncremental()`. */

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

  if (texts.size === 0) {
    return new Map<string, Float32Array>();
  }
  return embedSortedTexts(texts, embedder);
}

/**
 * Runs the injected {@link Embedder} over `texts` in sorted order and returns the
 * text→vector lookup. Sorting here is what makes every embedding call a pure
 * function of the text SET rather than of arrival order (the determinism
 * contract), and the one-vector-per-text contract is enforced loudly — a short
 * or long batch would otherwise silently mis-key the lookup.
 */
async function embedSortedTexts(
  texts: ReadonlySet<string>,
  embedder: Embedder,
): Promise<ReadonlyMap<string, Float32Array>> {
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
  const lookup = new Map<string, Float32Array>();
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
  return new Map([...existing, ...(await embedSortedTexts(missing, embedder))]);
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
      diagnostics: readonly CandidateDiagnostic[];
      diagnosticsTotal: number;
    }>,
    MergeError
  >
> {
  const allEdges: CandidateEdge[] = [];
  const warnings: string[] = [];
  const baseMembers: BaseMember[] = [];
  const diagnostics: CandidateDiagnostic[] = [];
  let diagnosticsTotal = 0;
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
            diagnostics: readonly CandidateDiagnostic[];
            diagnosticsTotal: number;
          }>,
          MergeError
        >
      > => {
        const resolveConfig = options.resolve[kind];
        if (resolveConfig === undefined) {
          // No resolution config for this kind: merge by id only (no candidate
          // edges, so every new node stays a singleton cluster).
          return ok({
            edges: [],
            warnings: [],
            baseMembers: [],
            diagnostics: [],
            diagnosticsTotal: 0,
          });
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
          options.candidateDiagnostics?.limit ?? 0,
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
          diagnostics: scored.data.diagnostics,
          diagnosticsTotal: scored.data.diagnosticsTotal,
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
    if (options.candidateDiagnostics !== undefined) {
      diagnostics.push(...result.data.diagnostics);
      diagnostics.sort((left, right) =>
        compareMatchEvidence(left.evidence, right.evidence),
      );
      diagnostics.splice(options.candidateDiagnostics.limit);
    }
    diagnosticsTotal += result.data.diagnosticsTotal;
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
    diagnostics,
    diagnosticsTotal,
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
        ...(staged.node.row.valid_from === undefined ?
          {}
        : { validFrom: staged.node.row.valid_from }),
        ...(staged.node.row.valid_to === undefined ?
          {}
        : { validTo: staged.node.row.valid_to }),
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
        ...(base.validFrom === undefined ? {} : { validFrom: base.validFrom }),
        ...(base.validTo === undefined ? {} : { validTo: base.validTo }),
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
 * `staging.modifiedEdges`. That reconciler is the authority on a row several
 * branches modified: it survived delete/modify resolution, merged the props, and
 * already recorded any {@link PropertyConflict} the disagreement raised. Staging
 * each branch's copy separately would put the same row through a second
 * arbitration in the repoint fold and report the same conflict twice.
 *
 * Every inherited edge is staged WITH the base props it was diffed against, which is
 * what lets the fold's property union tell an authored value from an untouched one
 * (issue #408). A branch-created edge carries none — nothing preceded it.
 *
 * Each edge's diff bucket is carried through as its staged ORIGIN
 * ({@link INHERITED_EDGE_ORIGIN} / {@link BRANCH_CREATED_EDGE_ORIGIN}): the modified
 * and re-windowed buckets hold rows the base already has, the new bucket holds rows a
 * branch created. This is the ONLY place that distinction is known — the repoint phase
 * needs it to fold onto a row the target holds, and an edge id says nothing about
 * where the row came from.
 *
 * `windowOnlyCarried` names the identities staged ONLY to carry an ending. Their
 * `branchId` is a write vehicle rather than a contribution (see the loop below),
 * which the provenance fold must know so it does not credit it.
 */
function buildStagedEdges(
  staging: StagingSet,
  modifiedEdges: readonly StagedModifiedEdge[],
  edgeValidityEnds: ReadonlyMap<MergeKey, ValidToChange>,
  edgeDeletions: ReadonlyMap<MergeKey, string>,
): Readonly<{
  edges: readonly StagedEdge[];
  windowOnlyCarried: ReadonlySet<MergeKey>;
}> {
  const staged: StagedEdge[] = [];
  const stagedIdentities = new Set<MergeKey>();
  const windowOnlyCarried = new Set<MergeKey>();
  for (const items of staging.newEdgesByKind.values()) {
    for (const item of items) {
      staged.push(toStagedEdge(item.branchId, item));
    }
  }
  for (const item of modifiedEdges) {
    const identity = mergeKeyOf(item.edge);
    stagedIdentities.add(identity);
    const validToChange = edgeValidityEnds.get(identity);
    staged.push({
      id: item.edge.id,
      kind: item.edge.kind,
      origin: INHERITED_EDGE_ORIGIN,
      fromId: item.edge.fromId,
      toId: item.edge.toId,
      fromKind: item.edge.fromKind,
      toKind: item.edge.toKind,
      props: item.edge.forkProps as Readonly<Record<string, JsonValue>>,
      baseProps: item.edge.baseProps as Readonly<Record<string, JsonValue>>,
      branchId: item.branchId,
      ...(validToChange?.kind === "set" ? { validTo: validToChange.validTo }
      : validToChange?.kind === "clear" ? { clearValidTo: true as const }
      : {}),
    });
  }
  // An inherited edge whose ONLY change is its end-of-validity is in neither the
  // new nor the modified bucket, so it must be staged here or the ending would
  // have nothing to ride on. Its props are the fork's, which equal the base's by
  // construction — the write carries the window and leaves the row's content
  // alone. Finally-deleted edges are excluded: deletion absorbs the ending.
  //
  // WHICH branch's copy carries it is arbitrary — the first in the staging order,
  // `(kind, id, branch)` — and stays that way. The copy is staged WITH the base it
  // was diffed against, so the repoint fold's property union sees that it authored
  // nothing and it contributes no claim under any label (issue #408); the carrier's
  // `branchId` is then a write vehicle only. It is still recorded as window-only
  // carried, because provenance reads the staged copies too and the ending's author
  // is credited from the resolution rather than from whoever carried the row.
  for (const item of staging.windowedEdges) {
    const identity = mergeKeyOf(item.edge);
    const validToChange = edgeValidityEnds.get(identity);
    if (
      validToChange === undefined ||
      stagedIdentities.has(identity) ||
      edgeDeletions.has(identity)
    ) {
      continue;
    }
    stagedIdentities.add(identity);
    windowOnlyCarried.add(identity);
    staged.push({
      id: item.edge.id,
      kind: item.edge.kind,
      origin: INHERITED_EDGE_ORIGIN,
      fromId: item.edge.fromId,
      toId: item.edge.toId,
      fromKind: item.edge.fromKind,
      toKind: item.edge.toKind,
      props: item.edge.props as Readonly<Record<string, JsonValue>>,
      baseProps: item.edge.baseProps as Readonly<Record<string, JsonValue>>,
      branchId: item.branchId,
      ...(validToChange.kind === "set" ?
        { validTo: validToChange.validTo }
      : { clearValidTo: true as const }),
    });
  }
  return { edges: staged, windowOnlyCarried };
}

/**
 * Projects a {@link StagedNewEdge} onto the repoint-phase {@link StagedEdge}.
 *
 * A new edge's valid-time window travels with it, exactly as a staged new
 * node's does: without it a branch edge authored over an ENDED window would
 * commit as CURRENT at merge time, leaving a live edge between endpoints that
 * are themselves no longer valid.
 */
function toStagedEdge(branchId: BranchId, item: StagedNewEdge): StagedEdge {
  return {
    id: item.edge.id,
    kind: item.edge.kind,
    origin: BRANCH_CREATED_EDGE_ORIGIN,
    fromId: item.edge.fromId,
    toId: item.edge.toId,
    fromKind: item.edge.fromKind,
    toKind: item.edge.toKind,
    props: item.edge.props as Readonly<Record<string, JsonValue>>,
    branchId,
    ...(item.edge.row.valid_from === undefined ?
      {}
    : { validFrom: item.edge.row.valid_from }),
    ...(item.edge.row.valid_to === undefined ?
      {}
    : { validTo: item.edge.row.valid_to }),
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
 * Empty per-branch trust weights used by policies that do not consult weights.
 * Option validation requires a non-empty map whenever `"provenanceWeighted"`
 * is selected, so this value is never a silent fallback for that policy.
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
  // The REAL member->survivor canonical map the commit repoints edges and
  // assertion endpoints with, carried on the plan so every closure re-run
  // judges endpoints at their post-merge identity. Never reconstruct this
  // from `resolutions` — those record only multi-bare-id clusters, keyed by
  // the survivor's kind, so a reconstruction drops pure ontology-retype
  // clusters and mis-keys mixed-kind members.
  canonicalOf: ReadonlyMap<MergeKey, MergeKey>;
  /**
   * `(kind, id) -> validTo` for every inherited NODE whose end-of-validity the
   * merge itself decided — a branch's ending that differs from the base's, on a
   * row the committed target did not already re-window. Keyed on the PRE-retype
   * identity, exactly as the modification fold is. An identity absent here has
   * no reconciled ending, and the commit passes no window for it at all — never
   * the base value re-asserted, and never the target's own value written back at
   * itself, which is what lets an unchanged window coalesce.
   */
  nodeValidityEnds: ReadonlyMap<MergeKey, ValidToChange>;
  /** The edge half of {@link nodeValidityEnds}, consumed by the repoint phase. */
  edgeValidityEnds: ReadonlyMap<MergeKey, ValidToChange>;
  validityEnds: readonly ValidityEndResolution[];
  resolutions: readonly EntityResolution[];
  propertyConflicts: readonly PropertyConflict<G>[];
  deleteModifyConflicts: readonly DeleteModifyConflict[];
  typeReconciliations: readonly TypeReconciliation[];
  dropped: readonly DroppedItem[];
  baseAmbiguities: readonly BaseAmbiguity[];
  provenanceRecords: readonly ProvenanceRecord[];
  warnings: readonly string[];
  candidateDiagnostics?: CandidateDiagnostics;
  identityAssertions: readonly IdentityTransferAssertion[];
  // Complete expected rows, never bare ids: a retraction ends whatever CURRENT
  // row carries its id, so it is only legal against the exact truth the branch
  // retracted. The plan therefore carries the full staged assertion, and both
  // validation layers (the plan-time filter and the in-transaction freshness
  // guard) compare it to the target's row before the id is ended.
  identityRetractions: readonly IdentityTransferAssertion[];
}>;

/**
 * Resolves the entire merge into a {@link MergePlan} WITHOUT touching the target.
 * Pure composition of the T3–T10 phases over the staged union; every step is
 * order-independent given the captured `branchRank`.
 */
function buildInternalMergePlan<G extends GraphDef>(
  staging: StagingSet,
  candidateEdges: readonly CandidateEdge[],
  candidateWarnings: readonly string[],
  candidateDiagnostics: readonly CandidateDiagnostic[],
  candidateDiagnosticsTotal: number,
  baseMembers: readonly BaseMember[],
  options: NormalizedMergeOptions<G>,
  branchRank: ReadonlyMap<BranchId, number>,
  subClassClosure: ReturnType<typeof buildSubClassClosure>,
  identityContext: PlanIdentityContext,
  storedIdentityRowsById: ReadonlyMap<string, LedgerAssertion>,
  targetPeers: readonly Readonly<{ kind: string; id: string }>[],
  preferredBranchId?: BranchId,
): MergePlan<G> {
  const identity = planIdentityChanges(staging, storedIdentityRowsById);
  const provenanceRecords: ProvenanceRecord[] = [];
  // The contributions already recorded, keyed by `contributionKey` — the sidecar
  // row's own identity, so a repeat is the same row written twice and never new
  // information. Several phases legitimately observe the SAME contribution: an
  // inherited edge is credited once when its modification survives delete/modify
  // and again when the repoint folds it, and a fold set's `mergedIds` lists one
  // entry per staged COPY, so a row staged by several branches re-offers each of
  // its branches once per copy. Repeats inflate `provenancePersisted.count` and,
  // because `bulkUpsertById` cannot create the same id twice in one batch, fail the
  // whole best-effort persist. Collapsing at this single funnel keeps the record
  // list, the in-memory index and the reported count all speaking about DISTINCT
  // contributions.
  const recordedContributions = new Set<string>();
  // Per-branch trust weights for the `"provenanceWeighted"` policy, or empty when
  // the caller supplied none (then the policy falls back to the stable branch order).
  const weights = options.provenanceWeights ?? EMPTY_WEIGHTS;
  // Records a branch's contribution of a CANONICAL node id (`role: "node"`) or a
  // SURVIVING edge id (`role: "edge"`), keeping its source.
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
    const record: ProvenanceRecord = {
      role,
      canonicalId,
      canonicalKind,
      branchId,
      sourceId,
    };
    const key = contributionKey(record);
    if (recordedContributions.has(key)) {
      return;
    }
    recordedContributions.add(key);
    provenanceRecords.push(record);
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
  const diameterGuard =
    options.clusterMaxDiameter === undefined ?
      {
        clusters: guard.clusters,
        survivingEdges: guard.survivingEdges,
        excludedEdges: [],
      }
    : enforceDiameterWithEdges(
        guard.clusters,
        clusterEdges,
        options.clusterMaxDiameter,
      );
  const clusters = diameterGuard.clusters;
  const baseSurvivingEdges = new Set(guard.survivingEdges);
  const survivingEdges = diameterGuard.survivingEdges.filter((edge) =>
    baseSurvivingEdges.has(edge),
  );
  const excludedByEndpoints = new Map<string, "diameter" | "baseAmbiguity">();
  for (const excluded of [
    ...guard.excludedEdges,
    ...diameterGuard.excludedEdges,
  ]) {
    excludedByEndpoints.set(
      JSON.stringify([excluded.edge.a, excluded.edge.b]),
      excluded.reason,
    );
  }
  const diagnosticsWithDisposition: CandidateDiagnostic[] =
    candidateDiagnostics.map((diagnostic): CandidateDiagnostic => {
      if (diagnostic.evidence.decision === "definitional") return diagnostic;
      if (diagnostic.scoreDecision === "rejected") return diagnostic;
      const a = mergeKey(diagnostic.evidence.a.kind, diagnostic.evidence.a.id);
      const b = mergeKey(diagnostic.evidence.b.kind, diagnostic.evidence.b.id);
      const reason = excludedByEndpoints.get(JSON.stringify([a, b]));
      return {
        ...diagnostic,
        clusterDisposition:
          reason === undefined ?
            ("retained" as const)
          : ({ kind: "excluded" as const, reason } as const),
      } as CandidateDiagnostic;
    });
  const definitionalExclusions: CandidateDiagnostic[] = [
    ...guard.excludedEdges,
    ...diameterGuard.excludedEdges,
  ]
    .filter((excluded) => excluded.edge.evidence.decision === "definitional")
    .map((excluded) => ({
      evidence: excluded.edge.evidence as Extract<
        CandidateEdge["evidence"],
        Readonly<{ decision: "definitional" }>
      >,
      scoreDecision: "accepted" as const,
      clusterDisposition: {
        kind: "excluded" as const,
        reason: excluded.reason,
      },
    }));
  const retainedDiagnostics = [
    ...diagnosticsWithDisposition,
    ...definitionalExclusions,
  ].sort((left, right) => compareMatchEvidence(left.evidence, right.evidence));
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
  const clusterByCanonicalIdentity = new Map<MergeKey, ClusterResult>();
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
    clusterByCanonicalIdentity.set(
      mergeKey(entity.kind, entity.canonicalId),
      cluster,
    );
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
      resolutions.push({
        ...entity.resolution,
        decisiveEdges: decisiveEdgesForCluster(cluster, survivingEdges),
      });
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
  // A node soft-delete CASCADES: it ends every open assertion touching the
  // node, at the node's own deletion instant. The diff derives that cause and
  // stages the ending as a `cascade` retraction naming the deleted node
  // (StagedRetraction.cause); every other ending is the branch's own act and is
  // staged `explicit`.
  //
  // A cascade's fate therefore belongs to the deletion that caused it. When the
  // delete/modify resolution OVERRULES that deletion ("flag"/"modifyWins" keep
  // the modification), applying the ending anyway would let the losing
  // deletion's side effect outlive the decision and strip the resurrected
  // node's identity truth — so the ending is dropped with its cause, visibly.
  // A retraction survives as soon as ONE branch staged it explicitly, or one
  // cause deletion survived: those are intents the deletion decision does not
  // speak to.
  const anyDeletionOverruled = staging.deletedNodes.some(
    (deletion) =>
      !nodeDeletions.has(mergeKey(deletion.node.kind, deletion.node.id)),
  );
  const stagedRetractionsById = new Map<string, StagedRetraction[]>();
  for (const staged of staging.retractedIdentityAssertions) {
    const contributions = stagedRetractionsById.get(staged.assertion.id) ?? [];
    contributions.push(staged);
    stagedRetractionsById.set(staged.assertion.id, contributions);
  }
  const overruledRetractionDrops: DroppedItem[] = [];
  const survivingRetractions =
    anyDeletionOverruled ?
      identity.retractions.filter((retraction) => {
        const contributions = stagedRetractionsById.get(retraction.id) ?? [];
        const everyContributionOverruled =
          contributions.length > 0 &&
          contributions.every(
            (staged) =>
              staged.cause.kind === "cascade" &&
              !nodeDeletions.has(
                mergeKey(
                  staged.cause.deletedNode.kind,
                  staged.cause.deletedNode.id,
                ),
              ),
          );
        if (!everyContributionOverruled) return true;
        overruledRetractionDrops.push({
          kind: "identity",
          id: retraction.id,
          reason: RETRACTION_DELETION_OVERRULED_DROP_REASON,
        });
        return false;
      })
    : identity.retractions;
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

  // (6-window) reconcile the inherited valid-time windows the branches moved.
  // Runs AFTER both delete/modify resolutions because a finally-deleted row
  // absorbs its own ending: deleting and ending are both "no longer true", and
  // the stronger statement wins without recording a conflict.
  const validWindows = resolveValidWindows(
    staging,
    new Set(nodeDeletions.keys()),
    new Set(edgeDeletions.keys()),
    preferredBranchId,
  );

  // (6-window provenance) credit the branches that AUTHORED a committed node
  // ending. Ending a row is authored state, but a branch whose only change to a
  // node is its window is neither a cluster member nor a surviving modification,
  // and the write that carries the ending names no branch — so without this the
  // branch whose claim the commit applied is absent from the provenance sidecar
  // entirely (issue #402). The credit comes from the resolution because only the
  // resolution knows whose claim won; a claim that LOST the least-claim rule is
  // not in `nodeCredits` and is not credited, since provenance records
  // contribution to COMMITTED state.
  //
  // Edges take the same credit through `stagedEdgeBranches` below, where the
  // repoint's surviving edge id is known.
  //
  // A branch that edited the node's props AND moved its window is already
  // credited with this exact record by the modification loop above; re-recording
  // it would count one sidecar row twice. A record whose `sourceId` differs from
  // its canonical is a DIFFERENT contribution (a fork id folded into a survivor)
  // and never stands in for the in-place one.
  const creditedNodeIdentities = new Map<MergeKey, Set<BranchId>>();
  for (const record of provenanceRecords) {
    if (record.role !== "node" || record.sourceId !== record.canonicalId) {
      continue;
    }
    const identity = mergeKey(record.canonicalKind, record.canonicalId);
    const credited =
      creditedNodeIdentities.get(identity) ?? new Set<BranchId>();
    credited.add(record.branchId);
    creditedNodeIdentities.set(identity, credited);
  }
  for (const [identity, branchIds] of validWindows.nodeCredits) {
    for (const branchId of branchIds) {
      if (creditedNodeIdentities.get(identity)?.has(branchId) === true) {
        continue;
      }
      const id = idOf(identity);
      recordProvenance("node", branchId, id, kindOf(identity), id);
    }
  }

  // (7) opt-in ontology type reconciliation over the public-closure glue. Inputs
  // (incl. base member kinds) were collected per cluster in the canonicalize loop.
  const reconciliation = reconcileTypes(
    reconcileInputs,
    subClassClosure,
    options.reconcileTypes,
  );
  const reconciledClusterByEntityId = new Map<string, ClusterResult>();
  for (const identity of reconciliation.retypeMap.keys()) {
    const entityId = idOf(identity);
    const cluster = clusterByCanonicalIdentity.get(identity);
    if (cluster !== undefined && !reconciledClusterByEntityId.has(entityId)) {
      reconciledClusterByEntityId.set(entityId, cluster);
    }
  }
  const typeReconciliations: readonly TypeReconciliation[] =
    reconciliation.reconciliations.map((item) => {
      const cluster = reconciledClusterByEntityId.get(item.entityId);
      return cluster === undefined ? item : (
          {
            ...item,
            decisiveEdges: decisiveEdgesForCluster(cluster, survivingEdges),
          }
        );
    });

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
  const canonicalEndpointWindows = new Map<
    MergeKey,
    Readonly<{ validFrom?: string; validTo?: string }>
  >();
  for (const entity of canonicalEntities) {
    if (
      entity.endpointValidFrom === undefined &&
      entity.endpointValidTo === undefined
    ) {
      continue;
    }
    const sourceKey = mergeKey(entity.kind, entity.canonicalId);
    const finalKind = reconciliation.retypeMap.get(sourceKey) ?? entity.kind;
    canonicalEndpointWindows.set(mergeKey(finalKind, entity.canonicalId), {
      ...(entity.endpointValidFrom === undefined ?
        {}
      : { validFrom: entity.endpointValidFrom }),
      ...(entity.endpointValidTo === undefined ?
        {}
      : { validTo: entity.endpointValidTo }),
    });
  }
  // Repoint identity-assertion endpoints through the same canonical + retype maps
  // the edges use, so an assertion naming a folded or retyped branch node
  // references its survivor instead of a dangling `(kind, id)` the commit-time
  // endpoint guard would reject. The two guards that follow turn the remaining
  // commit-time identity failures into deterministic plan-time conflicts.
  const identityRemap = remapIdentityAssertionEndpoints(
    identity.assertions,
    canonicalOf,
    reconciliation.retypeMap,
    storedIdentityRowsById,
    canonicalEndpointWindows,
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
    survivingRetractions.map((retraction) => retraction.id),
    staging.baseIdentityAssertions,
    new Set(nodeDeletions.keys()),
    canonicalOf,
    reconciliation.retypeMap,
    identityContext,
    identityNodeUniverse,
  );
  const { edges: stagedEdges, windowOnlyCarried } = buildStagedEdges(
    staging,
    reconciledEdgeModifications.survivingModifications,
    validWindows.edgeEnds,
    edgeDeletions,
  );
  // An edge id can be staged by MORE THAN ONE branch (e.g. an inherited edge
  // modified by two branches), so map each id to the SET of contributing branches.
  // A plain last-write Map would credit only one branch's provenance.
  //
  // A branch that authored the row's committed END is a contributor too, and the
  // staged copy cannot name it: an identity is staged ONCE, so a branch whose only
  // change is the window has no copy of its own whenever another branch's props
  // edit already staged the row (issue #402). Folding the window authors in here —
  // from the resolution that chose the end — credits them against the SURVIVING
  // edge the repoint decides, exactly as a modifying branch is credited, and a
  // `Set` keeps a branch that both edited props and moved the window one
  // contributor.
  //
  // A WINDOW-ONLY CARRIER is the exception: that copy exists only to give the
  // ending a row to ride on, its props are the base's, and the branch holding it
  // is whichever sorted first — possibly one whose later claim the merge
  // discarded. Crediting it would name a branch that put nothing in the committed
  // row, so the row's credit comes from the resolution alone.
  const stagedEdgeBranches = new Map<string, Set<BranchId>>();
  for (const staged of stagedEdges) {
    const identity = mergeKeyOf(staged);
    const branches = stagedEdgeBranches.get(staged.id) ?? new Set<BranchId>();
    if (!windowOnlyCarried.has(identity)) {
      branches.add(staged.branchId);
    }
    for (const branchId of validWindows.edgeCredits.get(identity) ?? []) {
      branches.add(branchId);
    }
    stagedEdgeBranches.set(staged.id, branches);
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
    ...overruledRetractionDrops,
    ...identityRemap.dropped,
    ...validWindows.dropped,
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
    canonicalOf,
    nodeValidityEnds: validWindows.nodeEnds,
    edgeValidityEnds: validWindows.edgeEnds,
    validityEnds: validWindows.resolutions,
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
    typeReconciliations,
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
    warnings: [...candidateWarnings, ...identityRemap.warnings],
    ...(options.candidateDiagnostics === undefined ?
      {}
    : {
        candidateDiagnostics: {
          entries: retainedDiagnostics.slice(
            0,
            options.candidateDiagnostics.limit,
          ),
          total: candidateDiagnosticsTotal + definitionalExclusions.length,
          limit: options.candidateDiagnostics.limit,
          truncated:
            candidateDiagnosticsTotal + definitionalExclusions.length >
            options.candidateDiagnostics.limit,
        },
      }),
    identityAssertions: identityRemap.assertions,
    identityRetractions: survivingRetractions,
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
 *
 * The bag is null-prototype ({@link createDataKeyedBag}) because its keys are
 * DATA — property names read off committed rows, and `trustedImportGraph`
 * writes a caller's bag verbatim, so a stored bag CAN carry an own `__proto__`
 * (`JSON.parse` mints it as ordinary own data). Writing the deletion marker for
 * that key into a `{}` literal does not create an entry: it invokes
 * `Object.prototype`'s `__proto__` setter, which with `undefined` as the value
 * is a silent no-op. The tombstone this function exists to write would simply
 * not be written.
 *
 * SCOPE OF THE CLAIM, measured rather than assumed: no reachable write carries
 * an own `__proto__` back into a committed row anyway — Zod drops the key in
 * strip AND loose mode, so the base value does not survive a merge commit with
 * or without the tombstone, and `branch()`'s validating clone refuses such a
 * base outright. So this is the function honoring its own contract
 * independently of what a distant layer happens to strip, NOT a user-visible
 * defect being fixed: the end state is currently identical either way, which is
 * why no end-to-end test guards it (one would pass under the mutation). The
 * live-ammunition key for the deletion contract is a DECLARED prototype-named
 * field such as `toString`, which this file's tests cover.
 */
function commitModificationProps(
  baseProps: Readonly<Record<string, unknown>>,
  forkProps: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const props = createDataKeyedBag<unknown>();
  for (const key of Object.keys(forkProps)) {
    props[key] = forkProps[key];
  }
  for (const key of Object.keys(baseProps)) {
    if (!hasOwnKey(forkProps, key)) {
      props[key] = undefined;
    }
  }
  return props;
}

/**
 * The `(kind, id)` an edge endpoint finally carries in the committed target: its
 * own kind unless the ontology retype cascade reconciled that identity to a more
 * specific one. Every consumer — the commit's edge upserts, the write signature,
 * and the incremental endpoint guard — resolves endpoints through here, so a
 * guard can never compare a pre-retype endpoint against a post-retype row.
 */
function finalEdgeEndpoint<G extends GraphDef>(
  plan: MergePlan<G>,
  kind: string,
  id: AnyNodeId,
): Readonly<{ kind: string; id: AnyNodeId }> {
  return { kind: plan.retypeMap.get(mergeKey(kind, id)) ?? kind, id };
}

/**
 * One node row a plan writes: the identity it lands on, the canonical cluster
 * entity it came from (absent for a modification-only write), and the surviving
 * inherited modification folded into it (absent when nothing modified the row).
 *
 * A write with NEITHER is a window-only write: an inherited row whose sole
 * change is its reconciled end-of-validity. It carries no props, and the upsert
 * patch-merges, so it moves the row's window and nothing else.
 */
type PlannedNodeWrite = Readonly<{
  identity: MergeKey;
  kind: string;
  id: AnyNodeId;
  entity?: CanonicalEntity;
  modification?: ModifiedNode;
  /**
   * The valid-time window the write carries. `validFrom` comes only from a
   * staged canonical survivor (the commit cannot move a live row's lower bound
   * — see `valid-window.ts`); `validTo` is the survivor's authored end, or, for
   * an inherited row, the reconciled end-of-validity. Absent means "do not touch
   * the committed window", which is what lets an otherwise-unchanged write
   * coalesce.
   */
  validFrom?: string;
}> &
  ValidityEndMutation;

/**
 * THE node-write enumeration: every node row a resolved plan writes, in commit
 * order — surviving inherited modifications first, then canonical cluster
 * survivors. Both the commit ({@link applyMergePlan}) and the incremental write
 * guards consume this one function, so which rows a plan touches, which are
 * skipped (finally deleted, or folded into a canonical write), and which kind
 * the retype cascade lands them on are decided in exactly one place. The
 * consumers differ only in how they derive the final props from each write; see
 * {@link nodeWriteProps}.
 *
 * A canonical survivor can ALSO be an inherited modification. Its two writes are
 * folded into one — the standalone modification write is skipped and the entity
 * carries the modification — because the canonical upsert is built from the
 * cluster union, which holds the OLDER base props and would otherwise clobber
 * the fork's edit.
 */
function plannedNodeWrites<G extends GraphDef>(
  plan: MergePlan<G>,
): readonly PlannedNodeWrite[] {
  const canonicalIdentities = new Set<MergeKey>();
  for (const entity of plan.canonicalEntities) {
    canonicalIdentities.add(mergeKey(entity.kind, entity.canonicalId));
  }
  const modificationsByIdentity = new Map<MergeKey, ModifiedNode>();
  for (const modification of plan.survivingModifications) {
    modificationsByIdentity.set(
      mergeKeyOf(modification.node),
      modification.node,
    );
  }

  const writes: PlannedNodeWrite[] = [];
  const written = new Set<MergeKey>();
  for (const modification of plan.survivingModifications) {
    const identity = mergeKeyOf(modification.node);
    if (plan.nodeDeletions.has(identity) || canonicalIdentities.has(identity)) {
      continue;
    }
    written.add(identity);
    const validToChange = plan.nodeValidityEnds.get(identity);
    writes.push({
      identity,
      kind: modification.node.kind,
      id: modification.node.id,
      modification: modification.node,
      ...(validToChange?.kind === "set" ? { validTo: validToChange.validTo }
      : validToChange?.kind === "clear" ? { clearValidTo: true as const }
      : {}),
    });
  }
  for (const entity of plan.canonicalEntities) {
    // The retype cascade is keyed on the PRE-retype identity, as is the
    // modification fold: both index the entity as the plan staged it.
    const sourceIdentity = mergeKey(entity.kind, entity.canonicalId);
    if (plan.nodeDeletions.has(sourceIdentity)) {
      continue;
    }
    const kind = plan.retypeMap.get(sourceIdentity) ?? entity.kind;
    const modification = modificationsByIdentity.get(sourceIdentity);
    written.add(sourceIdentity);
    // A staged survivor's own authored window is the canonicalize decision —
    // including the committed-target precedence that module applies — so it
    // takes priority. The reconciled inherited end fills in only where the
    // survivor claims no end of its own.
    const validToChange = plan.nodeValidityEnds.get(sourceIdentity);
    writes.push({
      identity: mergeKey(kind, entity.canonicalId),
      kind,
      id: entity.canonicalId,
      entity,
      ...(modification === undefined ? {} : { modification }),
      ...(entity.validFrom === undefined ?
        {}
      : { validFrom: entity.validFrom }),
      ...(typeof entity.validTo === "string" ? { validTo: entity.validTo }
      : validToChange?.kind === "set" ? { validTo: validToChange.validTo }
      : validToChange?.kind === "clear" ? { clearValidTo: true as const }
      : {}),
    });
  }
  // An inherited row whose ONLY change is its end-of-validity has neither a
  // surviving modification nor a canonical entity, so it has no write yet. It
  // gets one carrying the ending and NO props: the upsert patch-merges, so an
  // empty bag leaves the row's content exactly as committed. Sorted by identity
  // so the enumeration stays a pure function of the plan.
  for (const identity of [...plan.nodeValidityEnds.keys()].sort((left, right) =>
    compareMergeKeys(left, right),
  )) {
    if (written.has(identity) || plan.nodeDeletions.has(identity)) {
      continue;
    }
    const kind = plan.retypeMap.get(identity) ?? kindOf(identity);
    const validToChange = requireDefined(plan.nodeValidityEnds.get(identity));
    writes.push({
      identity: mergeKey(kind, idOf(identity)),
      kind,
      id: idOf(identity),
      ...(validToChange.kind === "set" ?
        { validTo: validToChange.validTo }
      : { clearValidTo: true as const }),
    });
  }
  return writes;
}

/**
 * Folds a planned write's sources into the prop bag to write, with the caller
 * supplying the only piece that differs between them: how a folded modification
 * contributes. The commit honors the fork's property DELETIONS (see
 * {@link commitModificationProps}); the incremental guard compares against the
 * fork's raw intended state. Modification props land ON TOP of the cluster
 * union so an explicit fork edit is never lost to the (older) base props the
 * union carried.
 */
function nodeWriteProps(
  write: PlannedNodeWrite,
  modificationProps: (
    modification: ModifiedNode,
  ) => Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...write.entity?.props,
    ...(write.modification === undefined ?
      undefined
    : modificationProps(write.modification)),
  };
}

type NodeWriteWindowOptions = Readonly<{ validFrom?: string }> &
  ValidityEndMutation;

/** Converts the plan's explicit set/clear state into the collection option union. */
function nodeWriteWindowOptions(
  write: NodeWriteWindowOptions,
): NodeWriteWindowOptions {
  const validFrom =
    write.validFrom === undefined ? {} : { validFrom: write.validFrom };
  if (write.clearValidTo === true) {
    return { ...validFrom, clearValidTo: true };
  }
  return {
    ...validFrom,
    ...(write.validTo === undefined ? {} : { validTo: write.validTo }),
  };
}

type MechanicalNodeWrite = Readonly<{
  kind: string;
  id: string;
  props: Readonly<Record<string, unknown>>;
  validFrom?: string;
}> &
  ValidityEndMutation;

type MechanicalEdgeWrite = Readonly<{
  kind: string;
  item: EdgeUpsert;
}>;

async function applyNodeRows(
  nodesApi: TxNodes,
  deletions: readonly MergePlanEntityRef[],
  upserts: readonly MechanicalNodeWrite[],
): Promise<number> {
  for (const deletion of deletions) {
    await nodeCollection(nodesApi, deletion.kind).delete(deletion.id);
  }
  const committed = new Set<MergeKey>();
  for (const upsert of upserts) {
    await nodeCollection(nodesApi, upsert.kind).upsertByIdFromRecord(
      upsert.id,
      upsert.props,
      nodeWriteWindowOptions(upsert),
    );
    committed.add(mergeKey(upsert.kind, upsert.id));
  }
  return committed.size;
}

async function applyEdgeRows(
  edgesApi: TxEdges,
  deletions: readonly MergePlanEntityRef[],
  upserts: readonly MechanicalEdgeWrite[],
): Promise<number> {
  for (const deletion of deletions) {
    await edgeCollection(edgesApi, deletion.kind).delete(deletion.id);
  }
  const byKind = new Map<string, EdgeUpsert[]>();
  for (const upsert of upserts) {
    const items = byKind.get(upsert.kind);
    if (items === undefined) byKind.set(upsert.kind, [upsert.item]);
    else items.push(upsert.item);
  }
  let committed = 0;
  for (const [kind, items] of byKind) {
    await edgeCollection(edgesApi, kind).bulkUpsertById(items);
    committed += items.length;
  }
  return committed;
}

async function applyIdentityRows<G extends GraphDef>(
  target: Store<G>,
  txBackend: TransactionBackend,
  assertions: readonly IdentityTransferAssertion[],
  retractions: readonly IdentityTransferAssertion[],
  assertConsistent?: () => Promise<void>,
): Promise<Readonly<{ asserted: number; retracted: number }>> {
  try {
    const applied = await storeRuntime(target).applyIdentityMergeAtTarget(
      txBackend,
      retractions.map((retraction) => retraction.id),
      assertions,
    );
    if (assertConsistent !== undefined) await assertConsistent();
    return { asserted: applied.created, retracted: applied.retracted };
  } catch (error) {
    throw translateIdentityCommitError(error);
  }
}

/**
 * Applies a resolved {@link MergePlan} through a transaction's collection API.
 * Shared by `commitPlan()` and the guarded `mergeIncremental()` commit path so
 * both modes execute the same resolved semantics.
 */
async function applyInternalMergePlan<G extends GraphDef>(
  plan: MergePlan<G>,
  nodesApi: TxNodes,
  edgesApi: TxEdges,
  target: Store<G>,
  txBackend: TransactionBackend,
): Promise<MergedCounts> {
  const nodeDeletions = [...plan.nodeDeletions].map(([identity, kind]) => ({
    kind,
    id: idOf(identity),
  }));
  const nodeUpserts = plannedNodeWrites(plan).map((write) => ({
    kind: write.kind,
    id: write.id,
    props: nodeWriteProps(write, (modification) =>
      commitModificationProps(modification.baseProps, modification.forkProps),
    ),
    ...(write.validFrom === undefined ? {} : { validFrom: write.validFrom }),
    ...(write.clearValidTo === true ? { clearValidTo: true as const }
    : write.validTo === undefined ? {}
    : { validTo: write.validTo }),
  }));
  const validityEndedNodes = new Set(
    nodeUpserts
      .filter((write) => "validTo" in write)
      .map((write) => mergeKey(write.kind, write.id)),
  );
  const earlyIdentityRetractions = plan.identityRetractions.filter(
    (retraction) =>
      validityEndedNodes.has(mergeKeyOf(retraction.a)) ||
      validityEndedNodes.has(mergeKeyOf(retraction.b)),
  );
  const earlyIdentity = await applyIdentityRows(
    target,
    txBackend,
    [],
    earlyIdentityRetractions,
  );
  let committedNodes: number;
  try {
    committedNodes = await applyNodeRows(nodesApi, nodeDeletions, nodeUpserts);
  } catch (error) {
    throw error instanceof IdentityEndpointValidityError ?
        translateIdentityCommitError(error)
      : error;
  }

  const edgeDeletions = [...plan.edgeDeletions].map(([identity, kind]) => ({
    kind,
    id: idOf(identity),
  }));
  const edgeUpserts: MechanicalEdgeWrite[] = [];
  for (const edge of plan.mergedEdges) {
    // Honor a fork's property deletion on an inherited edge: drop base keys absent
    // from the merged props (the edge upsert PATCH-merges, so a removed key would
    // otherwise survive). New edges have no base entry, so their props pass through.
    const edgeBaseProps = plan.inheritedEdgeBaseProps.get(edge.id);
    const props =
      edgeBaseProps === undefined ?
        edge.props
      : commitModificationProps(edgeBaseProps, edge.props);
    // A staged edge's valid-time window travels with the write, mirroring the
    // canonical-entity upsert above: on a fresh insert it IS the branch's
    // window, on a resurrection it stops the upsert from resetting a
    // branch-authored (possibly already ENDED) window to merge time, and on an
    // inherited edge it is the reconciled end-of-validity. An edge with no
    // window leaves its committed one untouched.
    edgeUpserts.push({
      kind: edge.kind,
      item: {
        id: edge.id,
        from: finalEdgeEndpoint(plan, edge.fromKind, edge.fromId),
        to: finalEdgeEndpoint(plan, edge.toKind, edge.toId),
        props,
        ...(edge.validFrom === undefined ? {} : { validFrom: edge.validFrom }),
        ...(edge.clearValidTo === true ? { clearValidTo: true as const }
        : edge.validTo === undefined ? {}
        : { validTo: edge.validTo }),
      },
    });
  }
  const committedEdges = await applyEdgeRows(
    edgesApi,
    edgeDeletions,
    edgeUpserts,
  );

  // The IDENTITY-APPLIER boundary: any refusal from the apply below is an
  // identity statement by construction, so it is translated into the typed
  // conflict error here — the completeness backstop for applier invariants
  // the plan-time simulation does not (yet) mirror.
  //
  // The post-write assertion shares the boundary because it is the same kind
  // of statement, made one step later: with every node, edge and identity
  // write of this merge in place, the affected identity classes must carry no
  // contradiction. It is what makes the committed ledger correct independently
  // of the plan-time simulation, and it runs for BOTH commit modes because
  // both commit through here.
  const appliedIdentity = await applyIdentityRows(
    target,
    txBackend,
    plan.identityAssertions,
    plan.identityRetractions,
    () => assertMergedIdentityClassesConsistent(target, txBackend, plan),
  );

  return {
    nodes: committedNodes,
    edges: committedEdges,
    // ACTUAL ledger effects from the applier: rows created (idempotent
    // exact/pair matches the target already held are excluded — the normal
    // incremental case, where the target's own additions are staged back at
    // it) and rows ended (already-ended or unknown ids excluded). Any apply
    // failure aborts the whole merge, so the counts never describe a
    // partial commit.
    identity: {
      asserted: appliedIdentity.asserted,
      retracted: earlyIdentity.retracted + appliedIdentity.retracted,
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
  return runMergeCommit(() =>
    withTxConflictRetry(() =>
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
        await assertPlannedIdentityIdsFresh(
          target,
          transactionBackend(tx),
          plan,
        );
        return applyInternalMergePlan(
          plan,
          tx.nodes as unknown as TxNodes,
          tx.edges as unknown as TxEdges,
          target,
          transactionBackend(tx),
        );
      }, mergeCommitTransactionOptions(target)),
    ),
  );
}

/** Runs one atomic commit while preserving the merge boundary's error taxonomy. */
async function runMergeCommit<Output>(
  commit: () => Promise<Output>,
): Promise<Output> {
  try {
    return await commit();
  } catch (error) {
    throw translateMergeCommitError(error);
  }
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
  getByIds: (
    ids: readonly string[],
    options?: Readonly<{ temporalMode?: "includeTombstones" }>,
  ) => Promise<readonly (Node | undefined)[]>;
  upsertByIdFromRecord: (
    id: string,
    data: Record<string, unknown>,
    options?: Readonly<{ validFrom?: string }> & ValidityEndMutation,
  ) => Promise<unknown>;
  delete: (id: string) => Promise<void>;
}>;

/** The edge-collection surface the commit uses (runtime, kind-string keyed). */
type EdgeCollectionLike = Readonly<{
  getByIds: (
    ids: readonly string[],
    options?: Readonly<{ temporalMode?: "includeTombstones" }>,
  ) => Promise<readonly (Edge | undefined)[]>;
  bulkUpsertById: (
    items: readonly (Readonly<{
      id: string;
      from: Readonly<{ kind: string; id: string }>;
      to: Readonly<{ kind: string; id: string }>;
      props?: Record<string, unknown>;
      validFrom?: string;
    }> &
      ValidityEndMutation)[],
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
  refusedOptions: readonly (keyof MergeOptions<G>)[] = [],
): Result<NormalizedMergeOptions<G>, MergeError> {
  const refusedOption = refusedOptions.find((option) =>
    hasOwnKey(optionsInput, option),
  );
  if (refusedOption !== undefined) {
    return err(
      new InvalidMergeOptionsError(
        `This merge operation does not accept options.${refusedOption}.`,
        { details: { option: refusedOption } },
      ),
    );
  }

  try {
    return ok(normalizeMergeOptions(optionsInput));
  } catch (error) {
    return err(
      new InvalidMergeOptionsError("Invalid merge options.", { cause: error }),
    );
  }
}

/**
 * Opens (creating if needed) the target's provenance sidecar BEFORE the merge
 * mutates anything, converting a refusal into a typed merge result.
 *
 * `openProvenanceStore` refuses two classes of state — an occupied sidecar graph
 * id (`GRAPH_MERGE_PROVENANCE_ID_COLLISION`) and a backend that cannot fence the
 * ownership claim (`GRAPH_MERGE_PROVENANCE_CLAIM_UNFENCED`) — and both are pure
 * configuration verdicts: they are as true before the merge as after it, and
 * nothing the merge does changes them. Reporting them post-commit as a warning
 * would leave the caller with a committed graph and an option it stated,
 * TypeGraph accepted, and then silently dropped. They are therefore refusals of
 * `options.persistProvenance` itself, carried as `InvalidMergeOptionsError`
 * (`category: "user"`, catchable exactly like every other refused merge option)
 * with the originating `ConfigurationError` as its cause.
 *
 * Any OTHER failure is a backend failure, not a verdict about the option, and is
 * wrapped as a plain `MergeError` — still pre-commit, because a merge whose
 * provenance sidecar cannot be reached should not commit half a contract either.
 */
async function tryOpenProvenanceStore<G extends GraphDef>(
  target: Store<G>,
): Promise<Result<Store<ProvenanceGraph>, MergeError>> {
  try {
    return ok(await openProvenanceStore(target));
  } catch (error) {
    const code =
      error instanceof TypeGraphError ?
        (error.details as Readonly<{ code?: unknown }> | undefined)?.code
      : undefined;
    const details = {
      option: "persistProvenance",
      graphId: provenanceGraphId(target.graphId),
      targetGraphId: target.graphId,
      ...(typeof code === "string" ? { provenanceErrorCode: code } : {}),
    };
    const message = `options.persistProvenance was requested but the merge-provenance sidecar cannot be opened: ${describeCause(error)}`;
    return err(
      (
        code === "GRAPH_MERGE_PROVENANCE_ID_COLLISION" ||
          code === "GRAPH_MERGE_PROVENANCE_CLAIM_UNFENCED"
      ) ?
        new InvalidMergeOptionsError(message, { details, cause: error })
      : new MergeError(message, { details, cause: error }),
    );
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
type ResolvedMerge<G extends GraphDef> = Readonly<{
  target: Store<G>;
  plan: MergePlan<G>;
  options: NormalizedMergeOptions<G>;
  expectedBaseVersion?: BaseVersion;
  incrementalGuard?: IncrementalCommitGuard<G>;
}>;

function assertPublicPlanCapability<G extends GraphDef>(
  target: Store<G>,
): void {
  if (!storeBackend(target).capabilities.transactions) {
    throw new MergePlanCapabilityError(
      "Public merge plans require a transaction-capable target backend.",
      { details: { capability: "transactions" } },
    );
  }
  if (!target.revisionTrackingEnabled) {
    throw new MergePlanCapabilityError(
      "Public merge plans require durable target revision tracking.",
      {
        details: { capability: "revisionTracking" },
        suggestion:
          "Create the target Store with { revisionTracking: true } (or history enabled), then create a new plan.",
      },
    );
  }
}

async function captureMergePlanTargetFence<G extends GraphDef>(
  target: Store<G>,
): Promise<MergePlanTargetFence> {
  assertPublicPlanCapability(target);
  const [activeSchema, schemaHash, origin, revision] = await Promise.all([
    storeBackend(target).getActiveSchema(target.graphId),
    computeSchemaComponent(target),
    target.revisionOriginNow(),
    target.revisionNow(),
  ]);
  return {
    graphId: target.graphId,
    schema: {
      managed: activeSchema !== undefined,
      version: activeSchema?.version ?? 1,
      hash: activeSchema?.schema_hash ?? schemaHash,
    },
    revision: { origin, revision: revision ?? null },
  };
}

function sameMergePlanTargetFence(
  left: MergePlanTargetFence,
  right: MergePlanTargetFence,
): boolean {
  return (
    left.graphId === right.graphId &&
    left.schema.managed === right.schema.managed &&
    left.schema.version === right.schema.version &&
    left.schema.hash === right.schema.hash &&
    left.revision.origin === right.revision.origin &&
    left.revision.revision === right.revision.revision
  );
}

async function assertPlanningFenceUnchanged<G extends GraphDef>(
  target: Store<G>,
  startingFence: MergePlanTargetFence,
): Promise<void> {
  const endingFence = await captureMergePlanTargetFence(target);
  if (sameMergePlanTargetFence(startingFence, endingFence)) return;
  throw new MergePlanningStaleError(
    "The merge target changed while the plan was being computed; no reviewable plan was produced.",
    { details: { startingFence, endingFence } },
  );
}

function splitWireProps(props: Readonly<Record<string, unknown>>): Readonly<{
  setProps: Readonly<Record<string, JsonValue>>;
  unsetProps: readonly string[];
}> {
  const setProps = createDataKeyedBag<JsonValue>();
  const unsetProps: string[] = [];
  for (const key of Object.keys(props).sort(compareStrings)) {
    const value = props[key];
    if (value === undefined) {
      unsetProps.push(key);
    } else {
      setProps[key] = value as JsonValue;
    }
  }
  return { setProps, unsetProps };
}

function wireEntityRef(kind: string, id: string): MergePlanEntityRef {
  return { kind, id };
}

function resolvedNodeUpserts<G extends GraphDef>(
  plan: MergePlan<G>,
): readonly MergePlanNodeUpsert[] {
  return plannedNodeWrites(plan).map((write) => ({
    kind: write.kind,
    id: write.id,
    ...splitWireProps(
      nodeWriteProps(write, (modification) =>
        commitModificationProps(modification.baseProps, modification.forkProps),
      ),
    ),
    ...(write.validFrom === undefined ? {} : { validFrom: write.validFrom }),
    ...(write.validTo === undefined ? {} : { validTo: write.validTo }),
  }));
}

async function resolvedMergeArtifact<G extends GraphDef>(
  resolved: ResolvedMerge<G>,
  mode: "snapshot" | "incremental",
  targetFence: MergePlanTargetFence,
  anchors: MergePlanAnchors,
): Promise<MergePlanArtifactV1> {
  const { plan, options } = resolved;
  const nodeUpserts = resolvedNodeUpserts(plan);
  const edgeUpserts = plan.mergedEdges.map((edge) => {
    const baseProps = plan.inheritedEdgeBaseProps.get(edge.id);
    const props =
      baseProps === undefined ?
        edge.props
      : commitModificationProps(baseProps, edge.props);
    return {
      kind: edge.kind,
      id: edge.id,
      from: finalEdgeEndpoint(plan, edge.fromKind, edge.fromId),
      to: finalEdgeEndpoint(plan, edge.toKind, edge.toId),
      ...splitWireProps(props),
      ...(edge.validFrom === undefined ? {} : { validFrom: edge.validFrom }),
      ...(edge.validTo === undefined ? {} : { validTo: edge.validTo }),
    };
  });
  const input: MergePlanArtifactV1Input = {
    formatVersion: 1,
    mode,
    target: targetFence,
    anchors,
    proposed: {
      nodes: {
        upserts: nodeUpserts.length,
        deletions: plan.nodeDeletions.size,
      },
      edges: {
        upserts: edgeUpserts.length,
        deletions: plan.edgeDeletions.size,
      },
      identity: {
        assertions: plan.identityAssertions.length,
        retractions: plan.identityRetractions.length,
      },
    },
    writes: {
      nodeDeletes: [...plan.nodeDeletions].map(([identity, kind]) =>
        wireEntityRef(kind, idOf(identity)),
      ),
      nodeUpserts,
      edgeDeletes: [...plan.edgeDeletions].map(([identity, kind]) =>
        wireEntityRef(kind, idOf(identity)),
      ),
      edgeUpserts,
      identityAssertions: plan.identityAssertions,
      identityRetractions: plan.identityRetractions,
    },
    guards: {
      canonicalMappings: [...plan.canonicalOf]
        .sort(([left], [right]) => compareMergeKeys(left, right))
        .map(([member, canonical]) => ({
          member: wireEntityRef(kindOf(member), idOf(member)),
          canonical: wireEntityRef(kindOf(canonical), idOf(canonical)),
        })),
      retypes: [...plan.retypeMap]
        .sort(([left], [right]) => compareMergeKeys(left, right))
        .map(([entity, toKind]) => ({
          entity: wireEntityRef(kindOf(entity), idOf(entity)),
          toKind,
        })),
      deletedNodes: [...plan.nodeDeletions].map(([identity, kind]) =>
        wireEntityRef(kind, idOf(identity)),
      ),
      ...(resolved.incrementalGuard === undefined ?
        {}
      : {
          incremental: {
            tombstoneResurrection: "refuse" as const,
            lossyUpdates: "refuse" as const,
            edgeIdentity: "preserve" as const,
          },
        }),
    },
    review: {
      resolutions: plan.resolutions,
      conflicts: plan.propertyConflicts as unknown as readonly JsonValue[],
      deleteModifyConflicts: plan.deleteModifyConflicts,
      typeReconciliations: plan.typeReconciliations,
      dropped: plan.dropped,
      validityEnds: plan.validityEnds,
      baseAmbiguities: plan.baseAmbiguities,
      provenanceRecords: plan.provenanceRecords,
      warnings: plan.warnings,
      ...(plan.candidateDiagnostics === undefined ?
        {}
      : { diagnostics: plan.candidateDiagnostics }),
    },
    provenance: {
      includeInReport: options.provenance,
      persist: options.persistProvenance,
    },
  };
  return constructMergePlanArtifact(input);
}

async function resolveMerge<G extends GraphDef, Output>(
  store: Store<G>,
  target: Store<G>,
  branches: readonly GraphBranch<G>[],
  options: NormalizedMergeOptions<G>,
  useBaseSources: boolean,
  incremental: IncrementalConfig<G> | undefined,
  expectedBaseVersion: BaseVersion | undefined,
  complete: (resolved: ResolvedMerge<G>) => Promise<Output>,
): Promise<Result<Output, MergeError>> {
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

  // A branch must be a DATA fork. A schema operation on the branch's store
  // after forking (evolve, migrateSchema, removeKinds) mutates rows through
  // its own preflights, and the state diff would project those side effects
  // into the merge as ordinary data changes detached from the schema change
  // that caused them — e.g. a kind removal's cascaded assertion cleanup
  // arriving as bare identity retractions against a target that still has the
  // kind. The check compares the branch's CURRENT committed schema row to the
  // (version, hash) anchor `branch()` captured at fork — version included, so
  // a ROUND-TRIP migration that restores the original document hash while
  // its preflights mutated rows is still refused. Hand-built branch objects
  // without an anchor fall back to hash equality against the fork source
  // (which also keeps unmanaged, row-less sources mergeable).
  for (const branch of branches) {
    const branchSchemaRow = await storeBackend(branch.store).getActiveSchema(
      branch.store.graphId,
    );
    let drifted: boolean;
    if ("schemaAnchor" in branch) {
      const anchor = branch.schemaAnchor;
      drifted =
        anchor === undefined ?
          branchSchemaRow !== undefined
        : branchSchemaRow?.version !== anchor.version ||
          branchSchemaRow.schema_hash !== anchor.hash;
    } else {
      const sourceSchemaRow = await storeBackend(store).getActiveSchema(
        store.graphId,
      );
      drifted = branchSchemaRow?.schema_hash !== sourceSchemaRow?.schema_hash;
    }
    if (drifted) {
      return err(
        new BaseVersionMismatchError(
          `Branch "${branch.id}"'s store has a committed schema different from its at-fork state — a schema operation ran on the branch after forking. Merge carries data changes only; apply the schema change to the target first (or re-fork), then merge.`,
          {
            details: {
              branchId: branch.id,
              branchSchemaVersion: branchSchemaRow?.version,
              branchSchemaHash: branchSchemaRow?.schema_hash,
              anchor: "schemaAnchor" in branch ? branch.schemaAnchor : "absent",
            },
          },
        ),
      );
    }
  }

  try {
    // (2) stage the provenance-tagged union of every branch's diff. For the
    // incremental path, capture the committed target branch's node versions from
    // its diff enumeration — the plan-time baseline for the commit-time
    // lost-update guard (assertInheritedTargetUnchanged).
    const preferredBranchId = incremental?.targetBranchId;
    const staging = await stageBranches(store, branches, preferredBranchId);
    // Pure over the (now fixed) staging set, so the deterministic per-kind order
    // is computed once and shared by every consumer below.
    const stagedNewByKind = newNodesByKind(staging);

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
          stagedNewByKind,
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
    // or base id. One kind-free indexed probe.
    // The identity guard protects EVERY identity-enabled incremental merge —
    // explicit same/different assertions exist under both profiles. Only the
    // same-id peer expansion (and the direct-peer window check) is
    // fold-specific.
    const identityProbeIds =
      target.graph.identity === undefined ?
        undefined
      : [
          ...new Set([
            ...[...stagedNewByKind.values()].flatMap((entries) =>
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

    // Every staged assertion and retraction id's target row, fetched BEFORE
    // planning. Retractions are validated against the complete truth their id
    // identifies on the target (a current row with DIFFERENT truth — the
    // target reused the id independently — must not be ended by a branch that
    // never saw it), and the survivor dedupe must know which staged ids are
    // ALREADY COMMITTED on the target: the applier is idempotent per semantic
    // pair, so a committed row can never lose the survivor pick to a branch's
    // freshly minted id.
    const stagedIdentityIds = [
      ...new Set([
        ...staging.newIdentityAssertions.map((staged) => staged.assertion.id),
        ...staging.retractedIdentityAssertions.map(
          (staged) => staged.assertion.id,
        ),
      ]),
    ];
    const storedIdentityRowsById =
      stagedIdentityIds.length === 0 || target.graph.identity === undefined ?
        NO_STORED_ASSERTIONS
      : await storeRuntime(target).identityAssertionRowsByIds(
          stagedIdentityIds,
        );

    // The target's identity semantics, shared by the plan-time simulation and
    // the post-plan recheck so both judge legality under one context.
    const identityContext: PlanIdentityContext = {
      sameIdAcrossKinds: target.graph.identity?.sameIdAcrossKinds,
      areDisjoint: (left, right) => target.registry.areDisjoint(left, right),
    };

    // (4–8) resolve the whole merge into a commit-ready plan.
    const plan = buildInternalMergePlan(
      staging,
      candidates.data.edges,
      candidates.data.warnings,
      candidates.data.diagnostics,
      candidates.data.diagnosticsTotal,
      candidates.data.baseMembers,
      options,
      branchRank,
      subClassClosure,
      identityContext,
      storedIdentityRowsById,
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

    let identityGuard: IdentityPeerProbe | undefined;
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
      // identity, exactly as the in-plan check judged them — through the
      // REAL canonical map the plan carries.
      const canonicalIdentityOf = plan.canonicalOf;
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
        new Set(plan.nodeDeletions.keys()),
        canonicalIdentityOf,
        plan.retypeMap,
        identityContext,
        // The snapshot's (deletion-filtered) class MEMBERS join the universe
        // as unlinked refs: their same-id fold links at ids outside the probe
        // range are re-derived by the checker's fold union, and their
        // assertion links come from the fresh ledger — never from the old
        // class shape itself.
        [...built.probe.seeds, ...built.snapshot.groups.flat()],
      );
      identityGuard = built.probe;
    }

    const incrementalGuard =
      incremental === undefined ? undefined : (
        ({
          stagedNewByKind,
          options,
          introspectionKinds,
          forkPoint: incremental.forkPoint,
          ...(identityGuard === undefined ?
            {}
          : { identityPeerProbe: identityGuard }),
          plannedBaseMatchKeys: new Set(
            candidates.data.baseMembers.map((member) => mergeKeyOf(member)),
          ),
          targetNodeVersions: staging.targetNodeVersions,
          targetEdgeSignatures: staging.targetEdgeSignatures,
        } satisfies IncrementalCommitGuard<G>)
      );

    return ok(
      await complete({
        target,
        plan,
        options,
        ...(expectedBaseVersion === undefined ? {} : { expectedBaseVersion }),
        ...(incrementalGuard === undefined ? {} : { incrementalGuard }),
      }),
    );
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

/** Commits one already-resolved merge and constructs its compatibility report. */
async function commitResolvedMerge<G extends GraphDef>(
  resolved: ResolvedMerge<G>,
): Promise<MergeReport<G>> {
  const { target, plan, options } = resolved;
  const provenanceStore =
    options.persistProvenance ?
      await tryOpenProvenanceStore(target)
    : undefined;
  if (provenanceStore !== undefined && isErr(provenanceStore)) {
    throw provenanceStore.error;
  }
  const merged =
    resolved.incrementalGuard === undefined ?
      await commitPlan(target, plan, resolved.expectedBaseVersion)
    : await commitIncrementalPlan(target, plan, resolved.incrementalGuard);

  const provenance: ProvenanceIndex =
    options.provenance ?
      buildProvenanceIndex(plan.provenanceRecords)
    : { byBranch: () => ({ nodeIds: [], edgeIds: [] }) };
  const warnings = [...plan.warnings];
  let provenancePersisted: MergeReport<G>["provenancePersisted"];
  if (provenanceStore !== undefined && !isErr(provenanceStore)) {
    try {
      const count = await persistProvenanceRecords(
        provenanceStore.data,
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

  return {
    merged,
    resolutions: plan.resolutions,
    conflicts: plan.propertyConflicts,
    deleteModifyConflicts: plan.deleteModifyConflicts,
    typeReconciliations: plan.typeReconciliations,
    dropped: plan.dropped,
    validityEnds: plan.validityEnds,
    baseAmbiguities: plan.baseAmbiguities,
    provenance,
    warnings,
    ...(plan.candidateDiagnostics === undefined ?
      {}
    : { candidateDiagnostics: plan.candidateDiagnostics }),
    ...(provenancePersisted === undefined ? {} : { provenancePersisted }),
  };
}

function incrementalBaseConflictPolicyError<G extends GraphDef>(
  options: NormalizedMergeOptions<G>,
): InvalidMergeOptionsError {
  return new InvalidMergeOptionsError(
    'mergeIncremental() requires onBasePropertyConflict: "flag" (keep-base); a non-keep-base policy could overwrite a newer committed base value with a stale branch value.',
    {
      details: {
        option: "onBasePropertyConflict",
        accepted: "flag",
        received: options.onBasePropertyConflict,
      },
    },
  );
}

function incrementalSchemaError(): MergeError {
  return new MergeError(
    "mergeIncremental() requires target and forkPoint to share a schema; schema drift is not supported (the target content may differ — only the schema must match).",
    { details: {} },
  );
}

/** Builds a durable, reviewable snapshot merge plan without mutating the target. */
export async function planMerge<G extends GraphDef>(
  store: Store<G>,
  branches: readonly GraphBranch<G>[],
  optionsInput: MergeOptions<G> = {},
): Promise<Result<MergePlanArtifact, MergeError>> {
  const normalized = tryNormalize(optionsInput);
  if (isErr(normalized)) return err(normalized.error);
  const options = normalized.data;
  const target = options.target ?? store;
  let targetFence: MergePlanTargetFence;
  try {
    targetFence = await captureMergePlanTargetFence(target);
  } catch (error) {
    return err(
      error instanceof MergeError ? error : (
        new MergePlanCapabilityError(
          `Unable to capture the target's durable plan fence: ${describeCause(error)}`,
          { cause: error },
        )
      ),
    );
  }
  const precondition = await validateBaseVersions(target, branches);
  if (isErr(precondition)) return err(precondition.error);
  const anchors: MergePlanAnchors = {
    kind: "snapshot",
    base: { graphId: store.graphId, baseVersion: precondition.data },
    branches: [...branches]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((branch) => ({
        branchId: branch.id,
        baseVersion: branch.base,
      })),
  };
  return resolveMerge(
    store,
    target,
    branches,
    options,
    false,
    undefined,
    precondition.data,
    async (resolved) => {
      await assertPlanningFenceUnchanged(target, targetFence);
      return resolvedMergeArtifact(resolved, "snapshot", targetFence, anchors);
    },
  );
}

/** Builds a durable, reviewable incremental merge plan without mutating the target. */
export async function planMergeIncremental<G extends GraphDef>(
  args: MergeIncrementalArguments<G>,
): Promise<Result<MergePlanArtifact, MergeError>> {
  const { forkPoint, target, branches } = args;
  const normalized = tryNormalize(args.options ?? {}, ["target"]);
  if (isErr(normalized)) return err(normalized.error);
  const options = normalized.data;
  if (options.onBasePropertyConflict !== "flag") {
    return err(incrementalBaseConflictPolicyError(options));
  }
  let targetFence: MergePlanTargetFence;
  try {
    targetFence = await captureMergePlanTargetFence(target);
  } catch (error) {
    return err(
      error instanceof MergeError ? error : (
        new MergePlanCapabilityError(
          `Unable to capture the target's durable plan fence: ${describeCause(error)}`,
          { cause: error },
        )
      ),
    );
  }
  const forkPrecondition = await validateForkPointVersions(forkPoint, branches);
  if (isErr(forkPrecondition)) return err(forkPrecondition.error);
  const forkVersion = forkPrecondition.data;
  const [forkSchema, targetSchema] = await Promise.all([
    computeSchemaComponent(forkPoint),
    computeSchemaComponent(target),
  ]);
  if (forkSchema !== targetSchema) return err(incrementalSchemaError());
  const forkActiveSchema = await storeBackend(forkPoint).getActiveSchema(
    forkPoint.graphId,
  );
  const targetBranch: GraphBranch<G> = {
    id: COMMITTED_TARGET_BRANCH,
    base: forkVersion,
    store: target,
  };
  const anchors: MergePlanAnchors = {
    kind: "incremental",
    forkPoint: {
      graphId: forkPoint.graphId,
      baseVersion: forkVersion,
      schema: {
        managed: forkActiveSchema !== undefined,
        version: forkActiveSchema?.version ?? 1,
        hash: forkActiveSchema?.schema_hash ?? forkSchema,
      },
    },
    branches: [...branches]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((branch) => ({
        branchId: branch.id,
        baseVersion: branch.base,
      })),
  };
  return resolveMerge(
    forkPoint,
    target,
    [targetBranch, ...branches],
    options,
    true,
    {
      targetBranchId: COMMITTED_TARGET_BRANCH,
      forkPoint: { store: forkPoint, version: forkVersion },
    },
    undefined,
    async (resolved) => {
      await assertPlanningFenceUnchanged(target, targetFence);
      await assertForkPointUnchanged({
        store: forkPoint,
        version: forkVersion,
      });
      return resolvedMergeArtifact(
        resolved,
        "incremental",
        targetFence,
        anchors,
      );
    },
  );
}

function mergePlanValidationError(
  failure: Exclude<
    Awaited<ReturnType<typeof validateMergePlanArtifact>>,
    Readonly<{ success: true }>
  >["error"],
): MergeError {
  switch (failure.kind) {
    case "unsupported-version": {
      return new UnsupportedMergePlanVersionError(
        `Unsupported merge plan format version ${String(failure.received)}.`,
        { details: { received: failure.received } },
      );
    }
    case "digest-mismatch": {
      return new MergePlanDigestMismatchError(
        "The merge plan digest does not match its canonical content.",
        { details: { expected: failure.expected, received: failure.received } },
      );
    }
    case "malformed": {
      return new InvalidMergePlanError("The merge plan is malformed.", {
        details: { issues: failure.issues },
      });
    }
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

function wireWriteProps(
  setProps: Readonly<Record<string, JsonValue>>,
  unsetProps: readonly string[],
): Record<string, unknown> {
  const props = createDataKeyedBag<unknown>();
  for (const [key, value] of Object.entries(setProps)) props[key] = value;
  for (const key of unsetProps) props[key] = undefined;
  return props;
}

function resolvedWireProps(
  current: Readonly<Record<string, unknown>>,
  setProps: Readonly<Record<string, JsonValue>>,
  unsetProps: readonly string[],
): Record<string, unknown> {
  const props = createDataKeyedBag<unknown>();
  const unset = new Set(unsetProps);
  for (const [key, value] of Object.entries(current)) {
    if (!unset.has(key)) props[key] = value;
  }
  for (const [key, value] of Object.entries(setProps)) props[key] = value;
  return props;
}

function invalidPlanForTarget(
  message: string,
  details: Readonly<Record<string, unknown>>,
): InvalidMergePlanError {
  return new InvalidMergePlanError(message, { details });
}

async function preflightWireMergeWrites<G extends GraphDef>(
  target: Store<G>,
  nodesApi: TxNodes,
  edgesApi: TxEdges,
  artifact: MergePlanArtifactV1,
): Promise<void> {
  const graphNodes = target.graph.nodes as Record<string, unknown>;
  const graphEdges = target.graph.edges as Record<
    string,
    (typeof target.graph.edges)[keyof typeof target.graph.edges] | undefined
  >;
  const assertNodeKind = (kind: string): void => {
    if (!hasOwnKey(graphNodes, kind)) {
      throw invalidPlanForTarget(
        `The merge plan references unknown node kind "${kind}".`,
        { kind, role: "node" },
      );
    }
  };
  const assertEdgeKind = (kind: string): void => {
    if (!hasOwnKey(graphEdges, kind) || graphEdges[kind] === undefined) {
      throw invalidPlanForTarget(
        `The merge plan references unknown edge kind "${kind}".`,
        { kind, role: "edge" },
      );
    }
  };

  for (const item of [
    ...artifact.writes.nodeDeletes,
    ...artifact.writes.nodeUpserts,
    ...artifact.guards.deletedNodes,
    ...artifact.guards.canonicalMappings.flatMap((mapping) => [
      mapping.member,
      mapping.canonical,
    ]),
    ...artifact.guards.retypes.map((retype) => retype.entity),
    ...artifact.writes.identityAssertions.flatMap((assertion) => [
      assertion.a,
      assertion.b,
    ]),
    ...artifact.writes.identityRetractions.flatMap((assertion) => [
      assertion.a,
      assertion.b,
    ]),
  ]) {
    assertNodeKind(item.kind);
  }
  for (const retype of artifact.guards.retypes) assertNodeKind(retype.toKind);
  for (const item of [
    ...artifact.writes.edgeDeletes,
    ...artifact.writes.edgeUpserts,
  ]) {
    assertEdgeKind(item.kind);
  }

  const plannedNodes = new Set(
    artifact.writes.nodeUpserts.map((upsert) =>
      mergeKey(upsert.kind, upsert.id),
    ),
  );
  const deletedNodes = new Set(
    artifact.writes.nodeDeletes.map((deletion) =>
      mergeKey(deletion.kind, deletion.id),
    ),
  );
  const endpointRows = new Map<MergeKey, Node | undefined>();
  const readEndpoint = async (
    endpoint: MergePlanEntityRef,
  ): Promise<Node | undefined> => {
    const key = mergeKey(endpoint.kind, endpoint.id);
    if (endpointRows.has(key)) return endpointRows.get(key);
    const row = (
      await nodeCollection(nodesApi, endpoint.kind).getByIds(
        [endpoint.id],
        INCLUDE_TOMBSTONES,
      )
    )[0];
    endpointRows.set(key, row);
    return row;
  };
  const nodeUpsertsByKind = new Map<string, MergePlanNodeUpsert[]>();
  for (const upsert of artifact.writes.nodeUpserts) {
    const upserts = nodeUpsertsByKind.get(upsert.kind) ?? [];
    upserts.push(upsert);
    nodeUpsertsByKind.set(upsert.kind, upserts);
  }
  const currentNodesByIdentity = new Map<MergeKey, Node | undefined>();
  for (const [kind, upserts] of nodeUpsertsByKind) {
    const rows = await nodeCollection(nodesApi, kind).getByIds(
      upserts.map((upsert) => upsert.id),
      INCLUDE_TOMBSTONES,
    );
    for (const [index, upsert] of upserts.entries()) {
      const row = rows[index];
      const identity = mergeKey(kind, upsert.id);
      currentNodesByIdentity.set(identity, row);
      endpointRows.set(identity, row);
    }
  }
  for (const upsert of artifact.writes.nodeUpserts) {
    const current = currentNodesByIdentity.get(
      mergeKey(upsert.kind, upsert.id),
    );
    if (
      artifact.guards.incremental !== undefined &&
      current?.meta.deletedAt !== undefined
    ) {
      throw invalidPlanForTarget(
        `The incremental merge plan would resurrect soft-deleted committed node "${upsert.id}".`,
        { kind: upsert.kind, id: upsert.id, role: "node" },
      );
    }
    const props = resolvedWireProps(
      current === undefined ? {} : nodeProps(current),
      upsert.setProps,
      upsert.unsetProps,
    );
    const schema = nodeSchemaFor(target, upsert.kind);
    if (schema !== undefined && !schema.safeParse(props).success) {
      throw invalidPlanForTarget(
        `The merge plan's node write for "${upsert.id}" does not validate against the active schema.`,
        { kind: upsert.kind, id: upsert.id, role: "node" },
      );
    }
    if (artifact.guards.incremental !== undefined && current !== undefined) {
      const analysis = analyzeRevalidatingWrite(
        schema,
        nodeProps(current),
        wireWriteProps(upsert.setProps, upsert.unsetProps),
      );
      assertValidRevalidatingWrite(
        analysis,
        `The incremental merge plan found committed node "${upsert.id}" with props that do not validate against the active schema.`,
        { kind: upsert.kind, id: upsert.id, role: "node" },
      );
      if (analysis.stripsCurrentProps && analysis.schemaWouldChange) {
        throw invalidPlanForTarget(
          `The incremental merge plan would strip existing props while updating committed node "${upsert.id}".`,
          { kind: upsert.kind, id: upsert.id, role: "node" },
        );
      }
    }
  }

  const currentEdgeIds = new Set<string>();
  const edgeUpsertsByKind = new Map<string, MergePlanEdgeUpsert[]>();
  for (const upsert of artifact.writes.edgeUpserts) {
    const upserts = edgeUpsertsByKind.get(upsert.kind) ?? [];
    upserts.push(upsert);
    edgeUpsertsByKind.set(upsert.kind, upserts);
  }
  const currentEdgesByIdentity = new Map<MergeKey, Edge | undefined>();
  for (const [kind, upserts] of edgeUpsertsByKind) {
    const rows = await edgeCollection(edgesApi, kind).getByIds(
      upserts.map((upsert) => upsert.id),
      INCLUDE_TOMBSTONES,
    );
    for (const [index, upsert] of upserts.entries()) {
      const row = rows[index];
      currentEdgesByIdentity.set(mergeKey(kind, upsert.id), row);
      if (row !== undefined) currentEdgeIds.add(upsert.id);
    }
  }
  for (const upsert of artifact.writes.edgeUpserts) {
    const registration = requireDefined(graphEdges[upsert.kind]);
    const endpointError = validateEdgeEndpoints(
      upsert.kind,
      upsert.from.kind,
      upsert.to.kind,
      registration,
      target.registry,
    );
    if (endpointError !== undefined) {
      throw invalidPlanForTarget(endpointError.message, {
        kind: upsert.kind,
        id: upsert.id,
        role: "edge",
      });
    }
    for (const endpoint of [upsert.from, upsert.to]) {
      assertNodeKind(endpoint.kind);
      const key = mergeKey(endpoint.kind, endpoint.id);
      if (deletedNodes.has(key)) {
        throw invalidPlanForTarget(
          `The merge plan deletes an endpoint required by edge "${upsert.id}".`,
          { edgeKind: upsert.kind, edgeId: upsert.id, endpoint },
        );
      }
      if (plannedNodes.has(key)) continue;
      const row = await readEndpoint(endpoint);
      if (row === undefined || row.meta.deletedAt !== undefined) {
        throw invalidPlanForTarget(
          `The merge plan references a missing edge endpoint "${endpoint.id}".`,
          { edgeKind: upsert.kind, edgeId: upsert.id, endpoint },
        );
      }
    }
    const current = currentEdgesByIdentity.get(
      mergeKey(upsert.kind, upsert.id),
    );
    if (
      artifact.guards.incremental !== undefined &&
      current?.meta.deletedAt !== undefined
    ) {
      throw invalidPlanForTarget(
        `The incremental merge plan would resurrect soft-deleted committed edge "${upsert.id}".`,
        { kind: upsert.kind, id: upsert.id, role: "edge" },
      );
    }
    const props = resolvedWireProps(
      current === undefined ? {} : edgeProps(current),
      upsert.setProps,
      upsert.unsetProps,
    );
    const schema = edgeSchemaFor(target, upsert.kind);
    if (schema !== undefined && !schema.safeParse(props).success) {
      throw invalidPlanForTarget(
        `The merge plan's edge write for "${upsert.id}" does not validate against the active schema.`,
        { kind: upsert.kind, id: upsert.id, role: "edge" },
      );
    }
    if (artifact.guards.incremental !== undefined && current !== undefined) {
      const analysis = analyzeRevalidatingWrite(
        schema,
        edgeProps(current),
        wireWriteProps(upsert.setProps, upsert.unsetProps),
      );
      assertValidRevalidatingWrite(
        analysis,
        `The incremental merge plan found committed edge "${upsert.id}" with props that do not validate against the active schema.`,
        { kind: upsert.kind, id: upsert.id, role: "edge" },
      );
      if (analysis.stripsCurrentProps && analysis.schemaWouldChange) {
        throw invalidPlanForTarget(
          `The incremental merge plan would strip existing props while updating committed edge "${upsert.id}".`,
          { kind: upsert.kind, id: upsert.id, role: "edge" },
        );
      }
    }
    if (
      current !== undefined &&
      (current.fromKind !== upsert.from.kind ||
        current.fromId !== upsert.from.id ||
        current.toKind !== upsert.to.kind ||
        current.toId !== upsert.to.id)
    ) {
      throw invalidPlanForTarget(
        `The merge plan would change the immutable endpoints of edge "${upsert.id}".`,
        { kind: upsert.kind, id: upsert.id, role: "edge" },
      );
    }
  }

  const missingEdgeIds = artifact.writes.edgeUpserts
    .map((upsert) => upsert.id)
    .filter((id) => !currentEdgeIds.has(id));
  if (missingEdgeIds.length > 0) {
    const plannedEdgeById = new Map(
      artifact.writes.edgeUpserts.map((upsert) => [upsert.id, upsert]),
    );
    for (const kind of Object.keys(target.graph.edges)) {
      const rows = await edgeCollection(edgesApi, kind).getByIds(
        missingEdgeIds,
        INCLUDE_TOMBSTONES,
      );
      for (const [index, row] of rows.entries()) {
        if (row === undefined) continue;
        const id = requireDefined(missingEdgeIds[index]);
        const planned = plannedEdgeById.get(id);
        if (planned !== undefined && planned.kind !== row.kind) {
          throw invalidPlanForTarget(
            `The merge plan reuses edge id "${id}" across kinds.`,
            { id, committedKind: row.kind, plannedKind: planned.kind },
          );
        }
      }
    }
  }
}

async function assertMergePlanFenceInsideTransaction<G extends GraphDef>(
  target: Store<G>,
  txBackend: TransactionBackend,
  artifact: MergePlanArtifactV1,
): Promise<void> {
  await lockRecordedGraphWrite(txBackend, target.graphId);
  const activeSchema = await txBackend.getActiveSchema(target.graphId);
  const liveSchema = {
    managed: activeSchema !== undefined,
    version: activeSchema?.version ?? 1,
    hash: activeSchema?.schema_hash ?? (await computeSchemaComponent(target)),
  };
  if (
    liveSchema.managed !== artifact.target.schema.managed ||
    liveSchema.version !== artifact.target.schema.version ||
    liveSchema.hash !== artifact.target.schema.hash
  ) {
    throw new MergePlanSchemaMismatchError(
      "The target's active schema no longer matches the merge plan.",
      { details: { expected: artifact.target.schema, live: liveSchema } },
    );
  }
  const liveOrigin = await readRevisionOrigin(
    txBackend,
    target.revisionSchema,
    target.graphId,
  );
  if (liveOrigin !== artifact.target.revision.origin) {
    throw new MergePlanOriginMismatchError(
      "The merge plan belongs to a different target revision origin.",
      {
        details: {
          expectedOrigin: artifact.target.revision.origin,
          liveOrigin,
        },
      },
    );
  }
  const liveRevision =
    (await readRecordedClock(
      txBackend,
      target.revisionSchema,
      target.graphId,
    )) ?? null;
  if (liveRevision !== artifact.target.revision.revision) {
    throw new StaleMergePlanError(
      "The target revision changed after this merge plan was created; the plan was not applied.",
      {
        details: {
          expectedRevision: artifact.target.revision.revision,
          liveRevision,
        },
      },
    );
  }
}

function identityConsistencySeeds(
  artifact: MergePlanArtifactV1,
  profile: "fold" | "ignore" | undefined,
): readonly MergePlanEntityRef[] {
  const deleted = new Set(
    artifact.writes.nodeDeletes.map((entity) =>
      mergeKey(entity.kind, entity.id),
    ),
  );
  const byIdentity = new Map<MergeKey, MergePlanEntityRef>();
  const add = (entity: MergePlanEntityRef): void => {
    const identity = mergeKey(entity.kind, entity.id);
    if (!deleted.has(identity)) byIdentity.set(identity, entity);
  };
  for (const assertion of [
    ...artifact.writes.identityAssertions,
    ...artifact.writes.identityRetractions,
  ]) {
    add(assertion.a);
    add(assertion.b);
  }
  if (profile === "fold") {
    for (const upsert of artifact.writes.nodeUpserts) add(upsert);
  }
  return [...byIdentity]
    .sort(([left], [right]) => compareMergeKeys(left, right))
    .map(([, entity]) => entity);
}

async function applyWireMergeWrites<G extends GraphDef>(
  target: Store<G>,
  nodesApi: TxNodes,
  edgesApi: TxEdges,
  txBackend: TransactionBackend,
  artifact: MergePlanArtifactV1,
): Promise<MergedCounts> {
  const committedNodes = await applyNodeRows(
    nodesApi,
    artifact.writes.nodeDeletes,
    artifact.writes.nodeUpserts.map((upsert) => ({
      kind: upsert.kind,
      id: upsert.id,
      props: wireWriteProps(upsert.setProps, upsert.unsetProps),
      ...(upsert.validFrom === undefined ?
        {}
      : { validFrom: upsert.validFrom }),
      ...(upsert.validTo === undefined ? {} : { validTo: upsert.validTo }),
    })),
  );
  const committedEdges = await applyEdgeRows(
    edgesApi,
    artifact.writes.edgeDeletes,
    artifact.writes.edgeUpserts.map((upsert) => ({
      kind: upsert.kind,
      item: {
        id: upsert.id,
        from: upsert.from,
        to: upsert.to,
        props: wireWriteProps(upsert.setProps, upsert.unsetProps),
        ...(upsert.validFrom === undefined ?
          {}
        : { validFrom: upsert.validFrom }),
        ...(upsert.validTo === undefined ? {} : { validTo: upsert.validTo }),
      },
    })),
  );
  const identityAssertions = artifact.writes
    .identityAssertions as readonly IdentityTransferAssertion[];
  const identityRetractions = artifact.writes
    .identityRetractions as readonly IdentityTransferAssertion[];
  const appliedIdentity = await applyIdentityRows(
    target,
    txBackend,
    identityAssertions,
    identityRetractions,
    () =>
      storeRuntime(target).assertIdentityClassesConsistentAtTarget(
        txBackend,
        identityConsistencySeeds(
          artifact,
          target.graph.identity?.sameIdAcrossKinds,
        ),
      ),
  );
  if (
    !forceRecordedGraphRevision(txBackend, target.graphId) &&
    !forceWriteTransactionRevision(txBackend)
  ) {
    await advanceRevisionClock(
      txBackend,
      target.revisionSchema,
      target.graphId,
      true,
    );
  }
  return {
    nodes: committedNodes,
    edges: committedEdges,
    identity: {
      asserted: appliedIdentity.asserted,
      retracted: appliedIdentity.retracted,
    },
  };
}

function reportFromArtifact<G extends GraphDef>(
  artifact: MergePlanArtifactV1,
  merged: MergedCounts,
  warnings: readonly string[],
  provenancePersisted?: MergeReport<G>["provenancePersisted"],
): MergeReport<G> {
  const provenanceRecords = artifact.review
    .provenanceRecords as unknown as readonly ProvenanceRecord[];
  return {
    merged,
    resolutions: artifact.review
      .resolutions as unknown as readonly EntityResolution[],
    conflicts: artifact.review
      .conflicts as unknown as readonly PropertyConflict<G>[],
    deleteModifyConflicts: artifact.review
      .deleteModifyConflicts as unknown as readonly DeleteModifyConflict[],
    typeReconciliations: artifact.review
      .typeReconciliations as unknown as readonly TypeReconciliation[],
    dropped: artifact.review.dropped as unknown as readonly DroppedItem[],
    validityEnds: artifact.review
      .validityEnds as unknown as readonly ValidityEndResolution[],
    baseAmbiguities: artifact.review
      .baseAmbiguities as unknown as readonly BaseAmbiguity[],
    provenance:
      artifact.provenance.includeInReport ?
        buildProvenanceIndex(provenanceRecords)
      : { byBranch: () => ({ nodeIds: [], edgeIds: [] }) },
    warnings,
    ...(artifact.review.diagnostics === undefined ?
      {}
    : {
        candidateDiagnostics: artifact.review
          .diagnostics as unknown as CandidateDiagnostics,
      }),
    ...(provenancePersisted === undefined ? {} : { provenancePersisted }),
  };
}

/** Validates and atomically applies an approved serialized merge plan. */
export async function applyMergePlan<G extends GraphDef>(
  target: Store<G>,
  input: MergePlanArtifact,
): Promise<Result<MergeReport<G>, MergeError>> {
  let validation: Awaited<ReturnType<typeof validateMergePlanArtifact>>;
  try {
    validation = await validateMergePlanArtifact(input);
  } catch (error) {
    return err(
      new InvalidMergePlanError(
        `Merge plan validation failed: ${describeCause(error)}`,
        { cause: error },
      ),
    );
  }
  if (!validation.success)
    return err(mergePlanValidationError(validation.error));
  const artifact = validation.artifact;
  if (artifact.target.graphId !== target.graphId) {
    return err(
      new MergePlanTargetMismatchError(
        "The merge plan names a different target graph.",
        {
          details: {
            expectedGraphId: artifact.target.graphId,
            receivedGraphId: target.graphId,
          },
        },
      ),
    );
  }
  try {
    assertPublicPlanCapability(target);
    const provenanceStore =
      artifact.provenance.persist ?
        await tryOpenProvenanceStore(target)
      : undefined;
    if (provenanceStore !== undefined && isErr(provenanceStore)) {
      return err(provenanceStore.error);
    }
    const merged = await withTxConflictRetry(() =>
      target.transaction(async (tx) => {
        const txBackend = transactionBackend(tx);
        await assertMergePlanFenceInsideTransaction(
          target,
          txBackend,
          artifact,
        );
        await preflightWireMergeWrites(
          target,
          tx.nodes as unknown as TxNodes,
          tx.edges as unknown as TxEdges,
          artifact,
        );
        await assertPlannedIdentityIdsFresh(target, txBackend, {
          identityAssertions: artifact.writes.identityAssertions,
          identityRetractions: artifact.writes.identityRetractions,
        });
        return applyWireMergeWrites(
          target,
          tx.nodes as unknown as TxNodes,
          tx.edges as unknown as TxEdges,
          txBackend,
          artifact,
        );
      }, mergeCommitTransactionOptions(target)),
    );
    const warnings = [...artifact.review.warnings];
    let provenancePersisted: MergeReport<G>["provenancePersisted"];
    if (provenanceStore !== undefined && !isErr(provenanceStore)) {
      try {
        const records = artifact.review
          .provenanceRecords as unknown as readonly ProvenanceRecord[];
        const count = await persistProvenanceRecords(
          provenanceStore.data,
          target.graphId,
          records,
        );
        provenancePersisted = {
          graphId: provenanceGraphId(target.graphId),
          count,
        };
      } catch (error) {
        warnings.push(
          "provenance persistence failed (graph committed; provenance not persisted): " +
            describeCause(error),
        );
      }
    }
    return ok(
      reportFromArtifact(artifact, merged, warnings, provenancePersisted),
    );
  } catch (error) {
    const translated = translateMergeCommitError(error);
    return err(
      translated instanceof MergeError ? translated : (
        new MergeError(
          `Merge plan apply failed: ${describeCause(translated)}`,
          {
            cause: translated,
          },
        )
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
    commitResolvedMerge,
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
    commitResolvedMerge,
  );
}

// --- mergeIncremental: full fork-point-vs-live-target entry point (§6.6) -------

/**
 * The fork-point premise {@link mergeIncremental} established BEFORE planning:
 * this store, at this `base@V`, is the immutable ancestor every branch diff was
 * computed against. Carried into the commit so it can be re-established at the
 * point of no return (see {@link assertForkPointUnchanged}).
 */
type ForkPointPrecondition<G extends GraphDef> = Readonly<{
  store: Store<G>;
  version: BaseVersion;
}>;

/** Internal config carried into {@link resolveMerge} for incremental mode. */
type IncrementalConfig<G extends GraphDef> = Readonly<{
  targetBranchId: BranchId;
  forkPoint: ForkPointPrecondition<G>;
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
 * Models TypeGraph's re-validating update semantics for one row —
 * `schema.safeParse({...current, ...planned})`, then storing the parsed result —
 * so `mergeIncremental()` can route each planned write to create / update / skip /
 * error from INSIDE the target transaction, where `current` is the row the commit
 * will actually overwrite.
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
  // Data-keyed: schema property names spread onto the public node.
  const props = createDataKeyedBag<unknown>();
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
  // Data-keyed: schema property names spread onto the public edge.
  const props = createDataKeyedBag<unknown>();
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

function assertValidRevalidatingWrite(
  analysis: RevalidatingWriteAnalysis,
  message: string,
  details: Record<string, unknown>,
): asserts analysis is Extract<RevalidatingWriteAnalysis, { status: "valid" }> {
  if (analysis.status === "invalid") {
    throw new MergeError(message, { details });
  }
}

function edgeWriteSignature<G extends GraphDef>(
  edge: MergedEdge,
  plan: MergePlan<G>,
): string {
  const from = finalEdgeEndpoint(plan, edge.fromKind, edge.fromId);
  const to = finalEdgeEndpoint(plan, edge.toKind, edge.toId);
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
      nodeWriteProps(write, (modification) => modification.forkProps),
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

    const from = finalEdgeEndpoint(plan, edge.fromKind, edge.fromId);
    const to = finalEdgeEndpoint(plan, edge.toKind, edge.toId);
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
   * The fork point and the `base@V` every branch declared against it, checked
   * before planning and re-checked at the commit (see
   * {@link assertForkPointUnchanged}).
   */
  forkPoint: ForkPointPrecondition<G>;
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
   * The plan-time identity probe: the bare ids probed, the live peer keys
   * observed, per-seed class fingerprints, and the negative-ledger
   * fingerprint. Present for EVERY identity-enabled incremental merge (both
   * profiles — explicit assertions change legality under `"ignore"` too; only
   * the direct-peer window check is fold-specific). The commit-time guard
   * revalidates all of it through the transaction backend and refuses
   * plan→commit drift as a typed replan error.
   */
  identityPeerProbe?: IdentityPeerProbe;
}>;

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
 * Re-establishes `mergeIncremental()`'s fork-point premise at the point of no
 * return — the incremental analogue of the snapshot path's
 * {@link assertTargetUnchanged}.
 *
 * `mergeIncremental()` reads the fork point's `base@V` BEFORE planning, refuses
 * any branch that declares a different one, and then derives the whole plan
 * from fork-point→branch diffs. A write landing on the fork point in that
 * window makes every one of those diffs describe an ancestor that no longer
 * exists — and nothing downstream notices, because the incremental commit
 * deliberately does NOT re-check the TARGET's `base@V` (an advancing target is
 * the feature). Re-reading the fork point here turns that into a typed refusal
 * instead of a committed plan derived from state that is gone.
 *
 * The token is recomputed by {@link computeBaseVersion} — the same and only
 * definition of a store's `base@V` that produced the value being compared, so
 * there is no second spelling of the comparison to drift. The SCHEMA half needs
 * no separate re-check: `computeSchemaComponent` hashes the serialized graph
 * with the version excluded, making it a pure function of the in-memory graph
 * definition, which is exactly why `assertTargetUnchanged` re-checks only the
 * content half too. The fork point's active schema VERSION is covered anyway —
 * it is part of the revision-anchored token.
 *
 * The re-read goes through the fork point's OWN backend rather than this
 * transaction: the fork point is a different store, and what must hold is its
 * COMMITTED state. Deliberately no advisory lock either — the fork point is
 * immutable by contract, so this detects a violated contract rather than
 * excluding a legal writer, and taking the graph write lock on a second
 * connection would deadlock against this very transaction whenever the fork
 * point and the target share one database.
 */
async function assertForkPointUnchanged<G extends GraphDef>(
  precondition: ForkPointPrecondition<G>,
): Promise<void> {
  const liveVersion = await computeBaseVersion(precondition.store);
  if (liveVersion === precondition.version) return;
  throw new BaseVersionMismatchError(
    "The mergeIncremental() fork point was modified between the fork-point precondition and the commit transaction; every branch diff was computed against the previous fork-point state, so the resolved plan was not applied.",
    {
      details: {
        expectedForkPointBase: precondition.version,
        liveForkPointBase: liveVersion,
      },
      suggestion:
        "Keep the fork-point store immutable for the duration of the merge (it is the diff reference, not a merge target), then re-run mergeIncremental().",
    },
  );
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
  return runMergeCommit(() =>
    withTxConflictRetry(() =>
      target.transaction(async (tx) => {
        if (target.revisionTrackingEnabled) {
          await lockRecordedGraphWrite(transactionBackend(tx), target.graphId);
        }
        // Fork-point TOCTOU guard: the ancestor the whole plan was diffed
        // against is re-read here, so a write to it in the plan→commit window
        // refuses the merge instead of committing diffs against a fork point
        // that has moved. Runs first: it is the premise every later guard's
        // baseline was derived under, and on a revision-anchored fork point it
        // is an O(1) read.
        await assertForkPointUnchanged(guard.forkPoint);
        const nodesApi = tx.nodes as unknown as TxNodes;
        const edgesApi = tx.edges as unknown as TxEdges;
        // Identity-resolution TOCTOU guard: the base-source lookups ran OUTSIDE
        // this transaction, so re-derive them here (tx snapshot) and refuse the
        // plan if a matching committed row appeared in the window. `tx` exposes
        // the same `.nodes` collection record a `BaseLookupStore` needs.
        await assertBaseResolutionStable(
          tx as unknown as BaseLookupStore,
          guard,
        );
        // Identity window guards: the by-id freshness check runs DIRECTLY (not
        // via the probe guard, whose early return must never be able to skip
        // it), then the probe-based layers revalidate peers, classes, the
        // negative ledger, and finally re-run the full identity simulation on
        // the tx snapshot.
        await assertPlannedIdentityIdsFresh(
          target,
          transactionBackend(tx),
          plan,
        );
        await assertIdentityPeersStable(
          target,
          transactionBackend(tx),
          guard.identityPeerProbe,
          plan,
        );
        // Inherited-row TOCTOU guard: refuse if a committed node OR edge the plan
        // writes or deletes changed since it was observed at plan time (lost update).
        await assertInheritedTargetUnchanged(nodesApi, edgesApi, guard, plan);
        await validateIncrementalNodeWrites(target, nodesApi, plan);
        await validateIncrementalEdgeWrites(target, edgesApi, plan);
        return applyInternalMergePlan(
          plan,
          nodesApi,
          edgesApi,
          target,
          transactionBackend(tx),
        );
      }, mergeCommitTransactionOptions(target)),
    ),
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
 * swapped. The named `target` is authoritative; an untyped caller that also
 * supplies `options.target` is refused rather than silently ignored.
 *
 * Preconditions (typed errors): every branch forked from `forkPoint`
 * (`branch.base === computeBaseVersion(forkPoint)`); `forkPoint` and `target` share a
 * schema hash (schema drift is fatal; target CONTENT may have advanced); and
 * `onBasePropertyConflict` is `"flag"` (keep-base for committed-row conflicts).
 *
 * The fork-point precondition is not merely an entry check: it is re-verified
 * inside the commit transaction, so `forkPoint` must stay immutable for the
 * duration of the call. A write to it while the merge is in flight makes every
 * branch diff describe an ancestor that no longer exists, and is refused with
 * `BaseVersionMismatchError` rather than committed (see
 * {@link assertForkPointUnchanged}). The TARGET, by contrast, may advance
 * throughout — that is what "incremental" means.
 */
export async function mergeIncremental<G extends GraphDef>(
  args: MergeIncrementalArguments<G>,
): Promise<Result<MergeReport<G>, MergeError>> {
  const { forkPoint, target, branches } = args;

  const normalized = tryNormalize(args.options ?? {}, ["target"]);
  if (isErr(normalized)) {
    return err(normalized.error);
  }
  const options = normalized.data;

  // Keep-base pin: committed rows remain authoritative under unresolved base
  // conflicts. A non-keep-base policy would let a stale branch value overwrite a
  // newer committed value.
  if (options.onBasePropertyConflict !== "flag") {
    return err(incrementalBaseConflictPolicyError(options));
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
    return err(incrementalSchemaError());
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
    {
      targetBranchId: COMMITTED_TARGET_BRANCH,
      // The fork-point precondition just validated, carried to the commit so
      // it is re-established there rather than assumed to have held for the
      // whole of planning (see `assertForkPointUnchanged`).
      forkPoint: { store: forkPoint, version: forkVersion },
    },
    undefined,
    commitResolvedMerge,
  );
}
