/**
 * `createLocalPgliteStore`'s implementation body, loaded behind a dynamic
 * import from `./pglite-store.ts` so a missing `drizzle-orm` peer surfaces as
 * a typed refusal rather than a bare module-resolution stack (design §4.4b).
 *
 * This module owns every value import that reaches `drizzle-orm` for this
 * entrypoint. `pglite-store.ts` must hold no static reference to this module
 * — only the `import("./pglite-store-impl")` expression inside its factory —
 * so the dynamic import survives into its own chunk in both the ESM and CJS
 * shipped artifacts (I12).
 */
import { type GraphDef } from "../../core/define-graph";
import { type SchemaManagerOptions } from "../../schema/manager";
import {
  createStoreWithSchema,
  type HistoryStore,
  type RecordedReadStore,
  type Store,
} from "../../store/store";
import { createPostgresTables } from "../drizzle/schema/postgres";
import { closeAfterFailure } from "../types";
import { createLocalPgliteBackend } from "./pglite";
// Type-only import: the option types are defined in `pglite-store.ts`, which
// is this module's ONLY caller. A static value import in the other direction
// would give `collectModuleEdges` a real edge from the store module to this
// one, turning I12's `load` verdict dirty; a type-only import is erased at
// runtime (no `verbatimModuleSyntax` in `tsconfig.base.json`), so this
// back-edge never becomes a value cycle — the same precedent documented at
// `src/errors/index.ts:26-29`.
import type { LocalPgliteStoreOptions } from "./pglite-store";

/**
 * Drops a smuggled `schema` from the nested schema-management options: the
 * effective `SqlSchema` has exactly one source (`store.schema`), which also
 * drives physical table provisioning in this constructor.
 */
function withoutSchemaOverride(
  schemaManagement: Omit<SchemaManagerOptions, "schema"> | undefined,
): Omit<SchemaManagerOptions, "schema"> {
  if (schemaManagement === undefined) return {};
  const { schema: smuggled, ...rest } =
    schemaManagement as SchemaManagerOptions;
  void smuggled;
  return rest;
}

/** {@link createLocalPgliteStore}'s implementation body, verbatim from before the split. */
export async function createLocalPgliteStoreImpl<G extends GraphDef>(
  graph: G,
  options: LocalPgliteStoreOptions,
): Promise<Store<G> | HistoryStore<G> | RecordedReadStore<G>> {
  const tables =
    options.store?.schema === undefined ?
      undefined
    : createPostgresTables(options.store.schema.tables);
  const { backend } = await createLocalPgliteBackend({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.vector === false ? { vector: false as const } : {}),
    ...(tables === undefined ? {} : { tables }),
  });
  try {
    const [store] = await createStoreWithSchema(graph, backend, {
      ...options.store,
      // The type already excludes `schema` here; the runtime strip guards
      // untyped callers, so the provisioned schema (or the default tables)
      // can never diverge from the one the Store reads.
      ...withoutSchemaOverride(options.schemaManagement),
    });
    return store;
  } catch (error) {
    return closeAfterFailure(backend, error);
  }
}
