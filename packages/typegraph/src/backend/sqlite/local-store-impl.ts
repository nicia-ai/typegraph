/**
 * `createLocalSqliteStore`'s implementation body, loaded behind a dynamic
 * import from `./local-store.ts` so a missing `drizzle-orm` peer surfaces as
 * a typed refusal rather than a bare module-resolution stack (design §4.4b).
 *
 * This module owns every value import that reaches `drizzle-orm` for this
 * entrypoint. `local-store.ts` must hold no static reference to this module
 * — only the `import("./local-store-impl")` expression inside its factory —
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
import { createSqliteTables } from "../drizzle/schema/sqlite";
import { closeAfterFailure } from "../types";
import { createLocalSqliteBackend } from "./local";
// Type-only import: the option types are defined in `local-store.ts`, which
// is this module's ONLY caller. A static value import in the other direction
// would give `collectModuleEdges` a real edge from the store module to this
// one, turning I12's `load` verdict dirty; a type-only import is erased at
// runtime (no `verbatimModuleSyntax` in `tsconfig.base.json`), so this
// back-edge never becomes a value cycle — the same precedent documented at
// `src/errors/index.ts:26-29`.
import type { LocalSqliteStoreOptions } from "./local-store";

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

/** {@link createLocalSqliteStore}'s implementation body, verbatim from before the split. */
export async function createLocalSqliteStoreImpl<G extends GraphDef>(
  graph: G,
  options: LocalSqliteStoreOptions,
): Promise<Store<G> | HistoryStore<G> | RecordedReadStore<G>> {
  const tables =
    options.store?.schema === undefined ?
      undefined
    : createSqliteTables(options.store.schema.tables);
  const { backend } = createLocalSqliteBackend({
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.pragmas === undefined ? {} : { pragmas: options.pragmas }),
    ...(options.capabilities === undefined ?
      {}
    : { capabilities: options.capabilities }),
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
