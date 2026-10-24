import { KindNotFoundError } from "../errors";

/** The point read a node collection — live, transactional or pinned — exposes. */
export type NodeByIdReader = Readonly<{
  getById: (id: string) => Promise<unknown>;
}>;

/**
 * Reads the node a `{ kind, id }` reference names through the node collection
 * `collectionFor(kind)` resolves, so every surface (store, transaction, view)
 * resolves a reference with its own collections' scope and coordinate. A kind
 * the surface has no collection for is refused with `KindNotFoundError`
 * rather than read as an absent node; the refusal rejects the returned
 * promise like a failed read.
 */
export async function readNodeByReference(
  collectionFor: (kind: string) => NodeByIdReader | undefined,
  reference: Readonly<{ kind: string; id: string }>,
  graphId: string,
): Promise<unknown> {
  const collection = collectionFor(reference.kind);
  if (collection === undefined) {
    throw new KindNotFoundError(reference.kind, "node", { graphId });
  }
  return collection.getById(reference.id);
}
