/**
 * Store-side eligibility and root resolution for the atomic node-create batch
 * program. The backend owns the SQL semantics for generated and caller
 * supplied ids; this module owns only the static store proof.
 */
import {
  type AtomicNodeBatchExecutor as BackendAtomicNodeBatchExecutor,
  resolveBundledRootAtomicNodeBatch,
} from "../../backend/capabilities/atomic-node-batch";
import { isBundledRootAutocommitEligible } from "../../backend/capabilities/autocommit-single-statement";
import type { GraphBackend, TransactionBackend } from "../../backend/types";
import type { GraphDef } from "../../core/define-graph";
import type { KindRegistry } from "../../registry/kind-registry";
import { hasOwnKey } from "../../utils/object";
import { getEmbeddingFields } from "../embedding-sync";
import { getSearchableFields } from "../fulltext-sync";
import type { CreateNodeInput } from "../types";

export type AtomicNodeBatchEligibilityInput = Readonly<{
  backend: GraphBackend | TransactionBackend;
  graph: GraphDef;
  registry: KindRegistry;
  inputs: readonly CreateNodeInput[];
  schemaVersion: number | undefined;
  identityEnabled: boolean;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
}>;

/**
 * The one owner of the static store proof for the atomic node batch.
 *
 * The decision deliberately does not inspect row state: the backend program
 * owns absent-insert, tombstone-resurrection, and live-duplicate semantics.
 * Preparation performs input validation and duplicate detection after this
 * static decision succeeds, before dispatch.
 */
export function resolveAtomicNodeBatchExecutor(
  input: AtomicNodeBatchEligibilityInput,
): BackendAtomicNodeBatchExecutor | undefined {
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
  if (identityEnabled || historyEnabled || revisionTrackingEnabled) return;

  const eligible = inputs.every((item) => {
    if (!hasOwnKey(graph.nodes, item.kind)) return false;
    const registration = graph.nodes[item.kind];
    if (registration === undefined) return false;
    if ((registration.unique ?? []).length > 0) return false;
    if (registry.getDisjointKinds(item.kind).length > 0) return false;
    if (getSearchableFields(registration.type.schema).length > 0) return false;
    return getEmbeddingFields(registration.type.schema).length === 0;
  });
  if (!eligible) return;

  return resolveBundledRootAtomicNodeBatch(backend);
}
