/**
 * Store-side eligibility for every exact-root semantic mutation program.
 *
 * Each operation owns its static proof here, while exact-root provenance is
 * resolved once through the backend's unified mutation-program profile. SQL
 * lowering and row-state arbitration remain backend responsibilities.
 */
import {
  type AtomicEdgeBatchExecutor as BackendAtomicEdgeBatchExecutor,
  type AtomicEdgeDeleteBatchExecutor,
  type AtomicEdgeMutationProgramExecutor,
  type AtomicEdgeResolvedUpdateBatchExecutor,
  type AtomicNodeBatchExecutor as BackendAtomicNodeBatchExecutor,
  type AtomicNodeDeleteBatchExecutor,
  type AtomicNodeReplacementBatchExecutor,
  type AtomicNodeResolvedMutationSetExecutor,
  type AtomicNodeResolvedUpdateBatchExecutor,
  resolveAtomicMutationPrograms,
  supportsAtomicNodeClaimFamily,
  supportsAtomicNodeProjections,
} from "../../backend/capabilities/atomic-mutation-program";
import {
  type GraphBackend,
  supportsAtomicBatch,
  type TransactionBackend,
} from "../../backend/types";
import type { GraphDef } from "../../core/define-graph";
import { DatabaseOperationError } from "../../errors";
import type { KindRegistry } from "../../registry/kind-registry";
import { hasOwnKey } from "../../utils/object";
import { edgeKindIsInAcyclicRelation } from "../acyclicity";
import { edgeCardinalityAxisReferences } from "../claims/edge-claims";
import { edgeWriteNeedsConstraintFence } from "../constraints";
import { getEmbeddingFields } from "../embedding-sync";
import { getSearchableFields } from "../fulltext-sync";
import type { CreateEdgeInput, CreateNodeInput } from "../types";
import { compositionEdgeHasRequiredExistencePart } from "./composition-create";
import { diagnoseFusedSchemaFenceNoRow } from "./write-transaction";

type CommonAtomicMutationEligibility = Readonly<{
  backend: GraphBackend | TransactionBackend;
  graph: GraphDef;
  registry: KindRegistry;
  schemaVersion: number | undefined;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
}>;

function resolveAtomicMutationProfile(input: CommonAtomicMutationEligibility) {
  if (!supportsAtomicBatch(input.backend)) return;
  if (input.schemaVersion === undefined) return;
  if (input.historyEnabled || input.revisionTrackingEnabled) return;
  return resolveAtomicMutationPrograms(input.backend);
}

function atomicNodeProjectionFamilies(
  registration: NonNullable<GraphDef["nodes"][string]>,
): readonly ("embedding" | "fulltext")[] {
  return [
    ...(getEmbeddingFields(registration.type.schema).length === 0 ?
      []
    : (["embedding"] as const)),
    ...(getSearchableFields(registration.type.schema).length === 0 ?
      []
    : (["fulltext"] as const)),
  ];
}

/**
 * Interprets explicit fence evidence from a closed delete program.
 *
 * A matching diagnostic after the program reported no fence row is not
 * success: either state changed between the atomic batch and its diagnostic,
 * or the backend violated the program contract.
 */
export async function assertAtomicDeleteSchemaFenceMatched(
  matched: boolean,
  ctx: Readonly<{ graphId: string; schemaVersion: number | undefined }>,
  backend: GraphBackend | TransactionBackend,
  entity: "node" | "edge",
): Promise<void> {
  if (matched) return;
  await diagnoseFusedSchemaFenceNoRow(ctx, backend);
  throw new DatabaseOperationError(
    "Atomic delete reported a stale schema fence, but the current schema " +
      "matched during diagnosis. The schema may have changed concurrently, " +
      "or the backend returned inconsistent fence evidence.",
    { operation: "delete", entity },
  );
}

export type AtomicNodeBatchEligibilityInput = CommonAtomicMutationEligibility &
  Readonly<{
    registry: KindRegistry;
    inputs: readonly CreateNodeInput[];
    identityEnabled: boolean;
  }>;

/** The one owner of the static store proof for atomic node creates. */
export function resolveAtomicNodeBatchExecutor(
  input: AtomicNodeBatchEligibilityInput,
): BackendAtomicNodeBatchExecutor | undefined {
  if (input.inputs.length === 0 || input.identityEnabled) return;
  // Item E.2: a fused node-batch program writes node rows only — it has no
  // shape for the composition edge a required-existence kind or a stated
  // `partOf` also owes. Declined by declaration, before any row is read: a
  // fused command is an optimization attempt, not evidence that its
  // dimensions ran.
  if (
    input.inputs.some(
      (item) =>
        item.partOf !== undefined ||
        input.registry.compositionExistence(item.kind) === "required",
    )
  ) {
    return;
  }
  const profile = resolveAtomicMutationProfile(input);
  if (profile?.createNodes === undefined) return;
  const claimSupport = profile.createNodes.claimSupport;
  const projectionSupport = profile.createNodes.projectionSupport;

  const registrations = input.inputs.map((item) => {
    if (!hasOwnKey(input.graph.nodes, item.kind)) return false;
    const registration = input.graph.nodes[item.kind];
    if (registration === undefined) return false;
    if (
      input.registry.getDisjointKinds(item.kind).length > 0 &&
      !supportsAtomicNodeClaimFamily(claimSupport, "disjointness")
    ) {
      return false;
    }
    if (
      !supportsAtomicNodeProjections(
        projectionSupport,
        atomicNodeProjectionFamilies(registration),
      )
    ) {
      return false;
    }
    return registration;
  });
  if (registrations.includes(false)) return;

  if (
    registrations.some(
      (registration) =>
        registration !== false && (registration.unique ?? []).length > 0,
    ) &&
    !supportsAtomicNodeClaimFamily(claimSupport, "uniqueness")
  ) {
    return;
  }

  return profile.createNodes;
}

export type AtomicNodeReplacementEligibilityInput =
  CommonAtomicMutationEligibility &
    Readonly<{
      registry: KindRegistry;
      kind: string;
      entryCount: number;
      identityEnabled: boolean;
    }>;

/** The one owner of the static store proof for blind node replacement. */
export function resolveAtomicNodeReplacementBatchProgram(
  input: AtomicNodeReplacementEligibilityInput,
):
  | Readonly<{
      executor: AtomicNodeReplacementBatchExecutor;
      releaseClaims: boolean;
    }>
  | undefined {
  if (input.entryCount === 0 || input.identityEnabled) return;
  if (!hasOwnKey(input.graph.nodes, input.kind)) return;
  const registration = input.graph.nodes[input.kind];
  if (registration === undefined) return;
  // Item E.2: a replacement that lands on no existing row CREATES the node,
  // and this fused program has no `partOf` parameter and no composition-edge
  // shape — a required-existence kind must take the portable path so
  // `resolveCompositionCreate` gets to refuse the bare create rather than
  // this program silently writing an orphan.
  if (input.registry.compositionExistence(input.kind) === "required") return;
  const executor = resolveAtomicMutationProfile(input)?.replaceNodes;
  if (executor === undefined) return;
  const releasedClaimFamilies = new Set(executor.releasedClaimFamilies);
  const hasDisjointness =
    input.registry.getDisjointKinds(input.kind).length > 0;
  const hasUniqueness = (registration.unique ?? []).length > 0;
  const maxEntries =
    hasDisjointness || hasUniqueness ?
      executor.maxEntries.claimed
    : executor.maxEntries.plain;
  if (input.entryCount > maxEntries) return;
  if (
    hasDisjointness &&
    (!supportsAtomicNodeClaimFamily(executor.claimSupport, "disjointness") ||
      !releasedClaimFamilies.has("disjointness"))
  ) {
    return;
  }
  if (
    hasUniqueness &&
    (!supportsAtomicNodeClaimFamily(executor.claimSupport, "uniqueness") ||
      !releasedClaimFamilies.has("uniqueness"))
  ) {
    return;
  }
  if (
    !supportsAtomicNodeProjections(
      executor.projectionSupport,
      atomicNodeProjectionFamilies(registration),
    )
  ) {
    return;
  }
  return {
    executor,
    releaseClaims: hasDisjointness || hasUniqueness,
  };
}

export type AtomicEdgeBatchEligibilityInput = CommonAtomicMutationEligibility &
  Readonly<{ inputs: readonly CreateEdgeInput[] }>;

export type AtomicEdgeBatchExecutor = BackendAtomicEdgeBatchExecutor;

export type AtomicEdgeConvergenceEligibilityInput =
  CommonAtomicMutationEligibility &
    Readonly<{
      kind: string;
      matchOn: readonly string[];
      inputs: readonly Readonly<{
        validFrom?: string | null;
        validTo?: string;
        clearValidTo?: true;
        onImmutableLowerBound?: "preserve" | "refuse";
      }>[];
      uniqueEntryCount: number;
      ifExists: "return" | "update";
    }>;

/** The one owner of the static proof for durable bulk edge convergence. */
export function resolveAtomicEdgeConvergenceExecutor(
  input: AtomicEdgeConvergenceEligibilityInput,
): AtomicEdgeMutationProgramExecutor | undefined {
  if (input.inputs.length === 0 || input.ifExists !== "return") return;
  if (
    input.inputs.some(
      (item) =>
        item.validFrom !== undefined ||
        item.validTo !== undefined ||
        item.clearValidTo === true ||
        item.onImmutableLowerBound !== undefined,
    )
  ) {
    return;
  }
  if (!hasOwnKey(input.graph.edges, input.kind)) return;
  const registration = input.graph.edges[input.kind];
  if (registration?.matchIdentity === undefined) {
    return;
  }
  // No native program applies a constrained cardinality axis or acyclicity;
  // such a create must re-enter the portable path, which probes and refuses.
  if (
    edgeWriteNeedsConstraintFence({
      ...registration,
      acyclic: edgeKindIsInAcyclicRelation(
        input.graph,
        input.registry,
        input.kind,
      ),
      composition: input.registry.isCompositionEdge(input.kind),
    }) !== undefined
  ) {
    return;
  }
  const declaredFields = registration.matchIdentity.fields;
  if (
    declaredFields.length !== input.matchOn.length ||
    declaredFields.some((field, index) => field !== input.matchOn[index])
  ) {
    return;
  }
  const executor = resolveAtomicMutationProfile(input)?.mutateEdges;
  if (
    executor === undefined ||
    input.uniqueEntryCount > executor.maxEntries.durableConvergence
  ) {
    return;
  }
  return executor;
}

/** The one owner of the static store proof for atomic edge creates. */
export function resolveAtomicEdgeBatchExecutor(
  input: AtomicEdgeBatchEligibilityInput,
): AtomicEdgeBatchExecutor | undefined {
  if (input.inputs.length === 0) return;
  const profile = resolveAtomicMutationProfile(input);
  if (profile?.createEdges === undefined) return;
  if (
    !input.inputs.every(
      (item) =>
        hasOwnKey(input.graph.edges, item.kind) &&
        input.graph.edges[item.kind] !== undefined &&
        // No native program applies acyclicity: acyclicity's fence has no
        // database key to claim through (`CONSTRAINT_FENCE_BACKING.
        // edgeAcyclicity === "lockOnly"`), which this fused program's claim
        // rows cannot express. Any acyclic kind in the batch sends the WHOLE
        // batch through the portable path, which probes the combined insert
        // once, after it lands.
        // This ALREADY excludes every composition edge kind, with no
        // separate check needed: `compositionAcyclicRelation`
        // (`src/store/acyclicity.ts`) folds every composition-realizing edge
        // kind into D-10's union the moment the graph declares ANY
        // `partOf`/`hasPart` pair, so `edgeKindIsInAcyclicRelation` answers
        // `true` for such a kind regardless of whether ITS OWN write would
        // close a cycle. That is load-bearing here for an unrelated reason:
        // a composition edge kind owes a SECOND claim (the reserved
        // relation-wide axis, `compositionClaim`) beyond whatever ordinary
        // axis its own registration declares — a fact the two-axis check
        // below cannot see, because it counts only
        // `edgeCardinalityAxisReferences`. `assertMatchingFusedEdgeClaim`
        // (`operation-backend-core.ts`) is the belt behind this gate, for
        // both reasons alike.
        !edgeKindIsInAcyclicRelation(input.graph, input.registry, item.kind),
    )
  ) {
    return;
  }
  // A kind declaring BOTH axes claims two rows per edge; the native program
  // matches claim results back to edges one-to-one
  // (`executeAtomicEdgeBatch`), so it refuses the whole batch rather than
  // silently dropping the second axis for the affected rows. The portable
  // path (`createEdge`'s single-write route) handles a two-axis kind fine —
  // it issues every claim in `claimEdgeCardinalities`'s loop, not a single
  // matched statement.
  if (
    input.inputs.some((item) => {
      const registration = input.graph.edges[item.kind];
      return (
        registration !== undefined &&
        edgeCardinalityAxisReferences(registration).length > 1
      );
    })
  ) {
    return;
  }
  return profile.createEdges;
}

export type AtomicEdgeDeleteBatchEligibilityInput =
  CommonAtomicMutationEligibility &
    Readonly<{
      expectedKind: string;
      ids: readonly string[];
    }>;

/** The one owner of the static store proof for atomic edge soft deletes. */
export function resolveAtomicEdgeDeleteBatchExecutor(
  input: AtomicEdgeDeleteBatchEligibilityInput,
): AtomicEdgeDeleteBatchExecutor | undefined {
  if (input.ids.length === 0) return;
  if (!hasOwnKey(input.graph.edges, input.expectedKind)) return;
  // Item E.2: `assertCompositionExistencePreserved` reads the part row under
  // the held write lock — a decision this read-free fused command cannot
  // express. A composition edge kind realizing a required-existence part
  // must take the portable path for its delete, exactly as its create-side
  // counterpart (`resolveAtomicNodeBatchExecutor`) declines the fused
  // program for a required-existence node create.
  if (
    compositionEdgeHasRequiredExistencePart(input.registry, input.expectedKind)
  ) {
    return;
  }
  return resolveAtomicMutationProfile(input)?.deleteEdges;
}

export type AtomicNodeDeleteBatchEligibilityInput =
  CommonAtomicMutationEligibility &
    Readonly<{
      kind: string;
      ids: readonly string[];
      identityEnabled: boolean;
      registry: KindRegistry;
    }>;

/** The one owner of the read-free atomic node-delete shape. */
export function resolveAtomicNodeDeleteBatchExecutor(
  input: AtomicNodeDeleteBatchEligibilityInput,
): AtomicNodeDeleteBatchExecutor | undefined {
  if (input.ids.length === 0 || input.identityEnabled) return;
  if (!hasOwnKey(input.graph.nodes, input.kind)) return;
  const registration = input.graph.nodes[input.kind];
  if (registration === undefined) return;
  // A composition whole's delete cascades to its parts through the portable
  // pipeline (`planCompositionCascade`, `node-operations.ts`) — a decision
  // that reads rows and recurses, which the fused command's single read-free
  // SQL shape cannot express. Statically ineligible by declaration, before
  // any row is read: "does this kind declare parts?" is a property of the
  // registry, not of this particular delete.
  //
  // A kind that is itself a composition PART (`registry.isCompositionPart`)
  // is equally ineligible, for a second, independent reason: composition edges
  // never count against `restrict`, on either end
  // (composition-contract-design.md's binding ruling), and only the portable
  // path's `enforceNodeDeleteBehavior` (`node-write-pipeline.ts`) knows how
  // to exclude them from its restrict count — the fused command's read-free
  // refusal diagnosis has no such filter and would misreport a composition
  // edge as a live restrict obstacle. This is the second, declared owner
  // `nodeDeletePolicyRequiresPortablePath`'s doc cross-references: that
  // predicate owns the two `NodeDeletePolicy`-shaped dimensions
  // (`enforceDeleteBehavior`, `consumedEdgeIds`); this guard owns the
  // registry-shaped one (static composition participation).
  if (
    input.registry.isCompositionWhole(input.kind) ||
    input.registry.isCompositionPart(input.kind)
  ) {
    return;
  }
  const executor = resolveAtomicMutationProfile(input)?.deleteNodes;
  if (executor === undefined) return;
  const releasedClaimFamilies = new Set(executor.releasedClaimFamilies);
  if (
    input.registry.getDisjointKinds(input.kind).length > 0 &&
    !releasedClaimFamilies.has("disjointness")
  ) {
    return;
  }
  if (
    (registration.unique ?? []).length > 0 &&
    !releasedClaimFamilies.has("uniqueness")
  ) {
    return;
  }
  if (
    registration.onDelete !== undefined &&
    registration.onDelete !== "restrict"
  ) {
    return;
  }
  if (getSearchableFields(registration.type.schema).length > 0) return;
  if (getEmbeddingFields(registration.type.schema).length > 0) return;
  return executor;
}

export type AtomicNodeResolvedUpdateEligibilityInput =
  CommonAtomicMutationEligibility &
    Readonly<{
      kind: string;
      entryCount: number;
      identityEnabled: boolean;
      registry: KindRegistry;
    }>;

type AtomicResolvedNodeKindEligibility = Readonly<{
  graph: GraphDef;
  kind: string;
  identityEnabled: boolean;
  registry: KindRegistry;
}>;

function isAtomicResolvedNodeKindEligible(
  input: AtomicResolvedNodeKindEligibility,
): boolean {
  if (input.identityEnabled || !hasOwnKey(input.graph.nodes, input.kind)) {
    return false;
  }
  const registration = input.graph.nodes[input.kind];
  return registration !== undefined && (registration.unique ?? []).length === 0;
}

function supportsAtomicResolvedNodeKindProjections(
  input: AtomicResolvedNodeKindEligibility,
  support: AtomicNodeResolvedMutationSetExecutor["projectionSupport"],
): boolean {
  const registration = input.graph.nodes[input.kind];
  return (
    registration !== undefined &&
    supportsAtomicNodeProjections(
      support,
      atomicNodeProjectionFamilies(registration),
    )
  );
}

function isAtomicResolvedEdgeKindEligible(
  input: Readonly<{ graph: GraphDef; registry: KindRegistry; kind: string }>,
): boolean {
  if (!hasOwnKey(input.graph.edges, input.kind)) return false;
  const registration = input.graph.edges[input.kind];
  return (
    registration !== undefined &&
    // No native program applies a constrained cardinality axis, acyclicity,
    // or composition; such a create must re-enter the portable path, which
    // probes and refuses.
    edgeWriteNeedsConstraintFence({
      ...registration,
      acyclic: edgeKindIsInAcyclicRelation(
        input.graph,
        input.registry,
        input.kind,
      ),
      composition: input.registry.isCompositionEdge(input.kind),
    }) === undefined &&
    registration.matchIdentity === undefined
  );
}

/** The one owner of the static proof for resolved live-node set updates. */
export function resolveAtomicNodeResolvedUpdateBatchExecutor(
  input: AtomicNodeResolvedUpdateEligibilityInput,
): AtomicNodeResolvedUpdateBatchExecutor | undefined {
  if (input.entryCount === 0 || !isAtomicResolvedNodeKindEligible(input)) {
    return;
  }
  const executor = resolveAtomicMutationProfile(input)?.updateNodes;
  if (
    executor === undefined ||
    input.entryCount > executor.maxEntries ||
    !supportsAtomicResolvedNodeKindProjections(
      input,
      executor.projectionSupport,
    )
  ) {
    return;
  }
  return executor;
}

export type AtomicEdgeResolvedUpdateEligibilityInput =
  CommonAtomicMutationEligibility &
    Readonly<{ kind: string; entryCount: number }>;

/** The one owner of the static proof for resolved live-edge set updates. */
export function resolveAtomicEdgeResolvedUpdateBatchExecutor(
  input: AtomicEdgeResolvedUpdateEligibilityInput,
): AtomicEdgeResolvedUpdateBatchExecutor | undefined {
  if (input.entryCount === 0 || !isAtomicResolvedEdgeKindEligible(input)) {
    return;
  }
  const executor = resolveAtomicMutationProfile(input)?.updateEdges;
  if (executor === undefined || input.entryCount > executor.maxEntries) return;
  return executor;
}

export type AtomicNodeResolvedMutationSetEligibilityInput =
  CommonAtomicMutationEligibility &
    Readonly<{
      kind: string;
      creates: readonly CreateNodeInput[];
      updateCount: number;
      identityEnabled: boolean;
      registry: KindRegistry;
    }>;

/** The one owner of the static proof for mixed resolved node mutations. */
export function resolveAtomicNodeResolvedMutationSetExecutor(
  input: AtomicNodeResolvedMutationSetEligibilityInput,
): AtomicNodeResolvedMutationSetExecutor | undefined {
  const entryCount = input.creates.length + input.updateCount;
  if (entryCount === 0 || !isAtomicResolvedNodeKindEligible(input)) return;
  // A mixed set may create rows, so its program must carry disjoint claim
  // acquisition and refusal. Update-only sets owe no disjoint transition and
  // are independently eligible through `updateNodes`.
  if (input.registry.getDisjointKinds(input.kind).length > 0) return;
  if (
    input.creates.some(
      (item) => item.kind !== input.kind || item.id === undefined,
    )
  ) {
    return;
  }
  // Item E.2: same reasoning as the other two node-create fused resolvers —
  // no shape here for the composition edge a `partOf` or a required-existence
  // kind also owes.
  if (
    input.creates.some(
      (item) =>
        item.partOf !== undefined ||
        input.registry.compositionExistence(item.kind) === "required",
    )
  ) {
    return;
  }
  const executor = resolveAtomicMutationProfile(input)?.mutateNodes;
  if (
    executor === undefined ||
    entryCount > executor.maxEntries ||
    !supportsAtomicResolvedNodeKindProjections(
      input,
      executor.projectionSupport,
    )
  ) {
    return;
  }
  return executor;
}

export type AtomicEdgeResolvedMutationSetEligibilityInput =
  CommonAtomicMutationEligibility &
    Readonly<{
      kind: string;
      creates: readonly CreateEdgeInput[];
      updateCount: number;
    }>;

/** The one owner of the static proof for mixed resolved edge mutations. */
export function resolveAtomicEdgeResolvedMutationSetExecutor(
  input: AtomicEdgeResolvedMutationSetEligibilityInput,
): AtomicEdgeMutationProgramExecutor | undefined {
  const entryCount = input.creates.length + input.updateCount;
  if (entryCount === 0 || !isAtomicResolvedEdgeKindEligible(input)) return;
  if (
    input.creates.some(
      (item) => item.kind !== input.kind || item.id === undefined,
    )
  ) {
    return;
  }
  const executor = resolveAtomicMutationProfile(input)?.mutateEdges;
  if (executor === undefined || entryCount > executor.maxEntries.resolvedSet) {
    return;
  }
  return executor;
}
