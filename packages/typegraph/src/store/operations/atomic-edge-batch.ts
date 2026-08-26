/**
 * Eligibility and root resolution for the atomic edge-create batch program.
 * This module owns the complete store-side proof; callers should not repeat
 * individual checks before selecting the program.
 */
import {
  type AtomicEdgeBatchExecutor as BackendAtomicEdgeBatchExecutor,
  resolveBundledRootAtomicEdgeBatch,
} from "../../backend/capabilities/atomic-edge-batch";
import { isBundledRootAutocommitEligible } from "../../backend/capabilities/autocommit-single-statement";
import type { GraphBackend, TransactionBackend } from "../../backend/types";
import type { GraphDef } from "../../core/define-graph";
import { hasOwnKey } from "../../utils/object";
import type { CreateEdgeInput } from "../types";

export type AtomicEdgeBatchEligibilityInput = Readonly<{
  backend: GraphBackend | TransactionBackend;
  graph: GraphDef;
  inputs: readonly CreateEdgeInput[];
  schemaVersion: number | undefined;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
}>;

export type AtomicEdgeBatchExecutor = BackendAtomicEdgeBatchExecutor;

/**
 * The one owner of the store proof for a native edge batch.
 *
 * The program covers direct edge batches whose endpoint, durable identity and
 * cardinality decisions can all be enforced by the native atomic program.
 * Dynamic get-or-create convergence is a separate API and never reaches this
 * classifier. The exact-root marker is checked after the portable predicates
 * so an unmarked or derived backend always fails closed.
 */
export function resolveAtomicEdgeBatchExecutor(
  input: AtomicEdgeBatchEligibilityInput,
): AtomicEdgeBatchExecutor | undefined {
  const {
    backend,
    graph,
    inputs,
    schemaVersion,
    historyEnabled,
    revisionTrackingEnabled,
  } = input;

  if (inputs.length === 0) return;
  if (!isBundledRootAutocommitEligible(backend)) return;
  if (schemaVersion === undefined) return;
  if (historyEnabled || revisionTrackingEnabled) return;

  const eligible = inputs.every((item) => {
    if (!hasOwnKey(graph.edges, item.kind)) return false;
    const registration = graph.edges[item.kind];
    if (registration === undefined) return false;
    return true;
  });
  if (!eligible) return;

  // SQL lowering is a dialect concern registered separately from this
  // generic resolver. Absence remains an ordinary session fallback.
  return resolveBundledRootAtomicEdgeBatch(backend);
}
