import { type GraphDef } from "../core/define-graph";
import { requireDefined } from "../utils/presence";
import { assertRegisteredNodeKinds } from "./registered-kinds";

/** The point read a node collection — live, transactional or pinned — exposes. */
export type NodeByIdReader = Readonly<{
  getById: (id: string) => Promise<unknown>;
}>;

/**
 * Reads the node a `{ kind, id }` reference names through the node collection
 * `collectionFor(kind)` resolves, so every surface (store, transaction, view)
 * resolves a reference with its own collections' scope and coordinate. A kind
 * the graph does not register is refused with `KindNotFoundError` rather than
 * read as an absent node; the refusal rejects the returned promise like a
 * failed read.
 */
export async function readNodeByReference(
  graph: GraphDef,
  collectionFor: (kind: string) => NodeByIdReader | undefined,
  reference: Readonly<{ kind: string; id: string }>,
): Promise<unknown> {
  assertRegisteredNodeKinds(graph, [reference.kind]);
  return requireDefined(collectionFor(reference.kind)).getById(reference.id);
}
