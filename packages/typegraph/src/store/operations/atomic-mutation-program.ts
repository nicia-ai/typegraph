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
  type AtomicNodeBatchExecutor as BackendAtomicNodeBatchExecutor,
  type AtomicNodeDeleteBatchExecutor,
  resolveBundledRootAtomicMutationPrograms,
} from "../../backend/capabilities/atomic-mutation-program";
import { isBundledRootAutocommitEligible } from "../../backend/capabilities/autocommit-single-statement";
import type { GraphBackend, TransactionBackend } from "../../backend/types";
import type { GraphDef } from "../../core/define-graph";
import { DatabaseOperationError } from "../../errors";
import type { KindRegistry } from "../../registry/kind-registry";
import { hasOwnKey } from "../../utils/object";
import { getEmbeddingFields } from "../embedding-sync";
import { getSearchableFields } from "../fulltext-sync";
import type { CreateEdgeInput, CreateNodeInput } from "../types";
import { diagnoseFusedSchemaFenceNoRow } from "./write-transaction";

type CommonAtomicMutationEligibility = Readonly<{
  backend: GraphBackend | TransactionBackend;
  graph: GraphDef;
  schemaVersion: number | undefined;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
}>;

function resolveAtomicMutationProfile(input: CommonAtomicMutationEligibility) {
  if (!isBundledRootAutocommitEligible(input.backend)) return;
  if (input.schemaVersion === undefined) return;
  if (input.historyEnabled || input.revisionTrackingEnabled) return;
  return resolveBundledRootAtomicMutationPrograms(input.backend);
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
  const profile = resolveAtomicMutationProfile(input);
  if (profile?.createNodes === undefined) return;

  const registrations = input.inputs.map((item) => {
    if (!hasOwnKey(input.graph.nodes, item.kind)) return false;
    const registration = input.graph.nodes[item.kind];
    if (registration === undefined) return false;
    if (input.registry.getDisjointKinds(item.kind).length > 0) return false;
    if (getSearchableFields(registration.type.schema).length > 0) return false;
    if (getEmbeddingFields(registration.type.schema).length > 0) return false;
    return registration;
  });
  if (registrations.includes(false)) return;

  const hasDeclaredClaims = registrations.some(
    (registration) =>
      registration !== false && (registration.unique ?? []).length > 0,
  );
  if (hasDeclaredClaims) {
    if (input.inputs.some((item) => item.id !== undefined)) return;
    if (
      registrations.some(
        (registration) =>
          registration !== false &&
          ((registration.unique ?? []).length > 1 ||
            (registration.unique ?? []).some(
              (constraint) => constraint.scope !== "kind",
            )),
      )
    ) {
      return;
    }
  }

  return profile.createNodes;
}

export type AtomicEdgeBatchEligibilityInput = CommonAtomicMutationEligibility &
  Readonly<{ inputs: readonly CreateEdgeInput[] }>;

export type AtomicEdgeBatchExecutor = BackendAtomicEdgeBatchExecutor;

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
        input.graph.edges[item.kind] !== undefined,
    )
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
  if (input.registry.getDisjointKinds(input.kind).length > 0) return;
  if ((registration.unique ?? []).length > 0) return;
  if (
    registration.onDelete !== undefined &&
    registration.onDelete !== "restrict"
  ) {
    return;
  }
  if (getSearchableFields(registration.type.schema).length > 0) return;
  if (getEmbeddingFields(registration.type.schema).length > 0) return;
  return resolveAtomicMutationProfile(input)?.deleteNodes;
}
