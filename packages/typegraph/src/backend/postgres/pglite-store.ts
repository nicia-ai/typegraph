/**
 * Declaration-isolated local PGlite store for strict TypeScript consumers.
 *
 * This entrypoint owns its public options and deliberately omits query-builder,
 * raw backend, transaction, and Drizzle surfaces. Use the root PostgreSQL and
 * PGlite entrypoints when those advanced APIs are required.
 */
import { type GraphDef } from "../../core/define-graph";
import { createStoreWithSchema } from "../../store/store";
import { type TypedStoreFacade } from "../../store/typed-store-facade";
import { createLocalPgliteBackend } from "./pglite";

export type {
  TypedCreateOptions,
  TypedEdge,
  TypedEdgeCollection,
  TypedEdgeCollections,
  TypedEdgeCreateArguments,
  TypedEdgeMeta,
  TypedFindOptions,
  TypedNode,
  TypedNodeCollection,
  TypedNodeCollections,
  TypedNodeMeta,
  TypedNodeRef,
  TypedStoreFacade,
} from "../../store/typed-store-facade";

/** Options accepted by {@link createLocalPgliteStore}. */
export type LocalPgliteStoreOptions = Readonly<{
  /** PGlite data directory. Defaults to an in-memory database. */
  dataDir?: string;
  /** Whether to load pgvector. Defaults to true. */
  vector?: boolean;
}>;

/**
 * Creates, provisions, and returns a typed local PGlite store.
 *
 * The facade uses standard TypeGraph tables. It loads pgvector by default;
 * pass `{ vector: false }` when the graph has no embedding fields and the
 * optional pgvector package is not installed.
 */
export async function createLocalPgliteStore<G extends GraphDef>(
  graph: G,
  options: LocalPgliteStoreOptions = {},
): Promise<TypedStoreFacade<G>> {
  const { backend } = await createLocalPgliteBackend({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.vector === false ? { vector: false as const } : {}),
  });
  try {
    const [store] = await createStoreWithSchema(graph, backend);
    return store;
  } catch (error) {
    await backend.close();
    throw error;
  }
}
