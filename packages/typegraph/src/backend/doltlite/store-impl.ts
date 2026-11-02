import { type GraphDef } from "../../core/define-graph";
import { createStoreWithSchema } from "../../store/store";
import { createSqliteTables } from "../drizzle/schema/sqlite";
import { closeAfterFailure } from "../types";
import { createDoltliteBackend } from "./index";
import { type DoltliteStoreOptions } from "./store";

export async function createDoltliteStoreImpl<G extends GraphDef>(
  graph: G,
  options: DoltliteStoreOptions,
) {
  const { path, branch, busyTimeoutMs, fulltext, capabilities, vector } =
    options;
  const { backend } = await createDoltliteBackend({
    ...(path === undefined ? {} : { path }),
    ...(branch === undefined ? {} : { branch }),
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
    ...(fulltext === undefined ? {} : { fulltext }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(vector === undefined ? {} : { vector }),
    ...(options.store?.schema === undefined ?
      {}
    : { tables: createSqliteTables(options.store.schema.tables) }),
  });
  try {
    const { schema: ignored, ...schemaManagement } =
      (options.schemaManagement ?? {}) as typeof options.schemaManagement & {
        schema?: unknown;
      };
    void ignored;
    const [store] = await createStoreWithSchema(graph, backend, {
      ...options.store,
      ...schemaManagement,
    });
    return store;
  } catch (error) {
    return closeAfterFailure(backend, error);
  }
}
