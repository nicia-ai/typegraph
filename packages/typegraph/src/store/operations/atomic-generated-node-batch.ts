/**
 * Eligibility and root resolution for the first generated-id node batch
 * program. This module owns the complete store-side proof; callers should
 * not repeat individual checks before selecting the program.
 */
import { isBundledRootAutocommitEligible } from "../../backend/capabilities/autocommit-single-statement";
import {
  type GeneratedNodeBatchExecutor as BackendGeneratedNodeBatchExecutor,
  resolveBundledRootGeneratedNodeBatch,
} from "../../backend/capabilities/generated-node-batch";
import type { GraphBackend, TransactionBackend } from "../../backend/types";
import type { GraphDef } from "../../core/define-graph";
import type { KindRegistry } from "../../registry/kind-registry";
import { getEmbeddingFields } from "../embedding-sync";
import { getSearchableFields } from "../fulltext-sync";
import type { CreateNodeInput } from "../types";

export type AtomicGeneratedNodeBatchEligibilityInput = Readonly<{
  backend: GraphBackend | TransactionBackend;
  graph: GraphDef;
  registry: KindRegistry;
  inputs: readonly CreateNodeInput[];
  schemaVersion: number | undefined;
  identityEnabled: boolean;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
}>;

export type GeneratedNodeBatchExecutor = BackendGeneratedNodeBatchExecutor;

/**
 * The one owner of the first generated-id batch program's store proof.
 *
 * The root marker is intentional: this path must be the exact bundled root
 * that owns the static executor, never a derived or transaction-scoped
 * backend. Constraints and projections remain on the existing session path
 * until their static SQL contracts are complete.
 */
export function resolveAtomicGeneratedNodeBatchExecutor(
  input: AtomicGeneratedNodeBatchEligibilityInput,
): GeneratedNodeBatchExecutor | undefined {
  const {
    backend,
    graph,
    registry,
    inputs,
    identityEnabled,
    historyEnabled,
    revisionTrackingEnabled,
  } = input;
  if (inputs.length === 0) return;
  if (!isBundledRootAutocommitEligible(backend)) return;
  if (input.schemaVersion === undefined) return;
  if (identityEnabled || historyEnabled || revisionTrackingEnabled) {
    return;
  }

  const eligible = inputs.every((item) => {
    if (item.id !== undefined) return false;
    const registration = graph.nodes[item.kind];
    if (registration === undefined) return false;
    if ((registration.unique ?? []).length > 0) return false;
    if (registry.getDisjointKinds(item.kind).length > 0) return false;
    if (getSearchableFields(registration.type.schema).length > 0) return false;
    return getEmbeddingFields(registration.type.schema).length === 0;
  });
  if (!eligible) return;

  // SQL lowering is a dialect concern registered separately from the generic
  // portable executor. Absence remains an ordinary session fallback.
  return resolveBundledRootGeneratedNodeBatch(backend);
}
