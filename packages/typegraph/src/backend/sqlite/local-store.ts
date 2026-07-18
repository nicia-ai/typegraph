/**
 * Declaration-isolated local SQLite store for strict TypeScript consumers.
 *
 * This Node.js-only entrypoint owns its public options and deliberately omits
 * query-builder, raw backend, transaction, and Drizzle surfaces. Use the root
 * package entrypoint when those advanced APIs are required.
 */
import { type GraphDef } from "../../core/define-graph";
import { createStoreWithSchema } from "../../store/store";
import { type TypedStoreFacade } from "../../store/typed-store-facade";
import { createLocalSqliteBackend } from "./local";

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

/** Options accepted by {@link createLocalSqliteStore}. */
export type LocalSqliteStoreOptions = Readonly<{
  /** SQLite file path. Defaults to an in-memory database. */
  path?: string;
}>;

/**
 * Creates, provisions, and returns a typed local SQLite store.
 *
 * This convenience entrypoint is Node.js-only because it opens
 * `better-sqlite3`. It uses the standard TypeGraph tables and default local
 * SQLite pragmas. Import advanced backend, query, transaction, history, or raw
 * SQL APIs from the existing root and SQLite entrypoints instead.
 */
export async function createLocalSqliteStore<G extends GraphDef>(
  graph: G,
  options: LocalSqliteStoreOptions = {},
): Promise<TypedStoreFacade<G>> {
  const { backend } = createLocalSqliteBackend(
    options.path === undefined ? {} : { path: options.path },
  );
  try {
    const [store] = await createStoreWithSchema(graph, backend);
    return store;
  } catch (error) {
    await backend.close();
    throw error;
  }
}
