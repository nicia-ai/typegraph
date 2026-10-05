/**
 * A table-backed working copy owns the relations allocated for one fixed graph
 * schema. Store evolution could introduce new physical vector tables or
 * graph indexes outside the allocated name map that its ledger cannot own.
 * Register the exact backend handed to the copy Store after bootstrap; clones
 * of that Store retain the same backend object.
 */
import type { GraphBackend } from "../backend/types";
import { ConfigurationError } from "../errors";

const FIXED_SCHEMA_BACKENDS = new WeakSet<GraphBackend>();

/** @internal Bind the fixed-schema policy to the handed-out backend object. */
export function markFixedSchemaWorkingCopyBackend(backend: GraphBackend): void {
  FIXED_SCHEMA_BACKENDS.add(backend);
}

/** @internal Refuse a schema transition before its first preflight or write. */
export function assertFixedSchemaWorkingCopyAllows(
  backend: GraphBackend,
  operation: string,
): void {
  if (!FIXED_SCHEMA_BACKENDS.has(backend)) return;
  throw new ConfigurationError(
    `Managed PostgreSQL table-backed working copies have a fixed schema; ${operation} is unsupported.`,
    { code: "WORKING_COPY_SCHEMA_EVOLUTION_UNSUPPORTED", operation },
  );
}
