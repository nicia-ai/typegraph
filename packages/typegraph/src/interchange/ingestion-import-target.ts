/**
 * Private capability bridge from an opaque ingestion branch to interchange.
 *
 * The branch handle must not expose its relaxed-schema Store, but interchange
 * still needs the real Store so it can reuse the one import implementation that
 * owns validation, temporal windows, edge endpoints, and stream leases.
 */

import type { GraphDef } from "../core/define-graph";
import { ConfigurationError } from "../errors";
import { STORE_RUNTIME } from "../store/runtime-port";
import type { Store } from "../store/store";

declare const INGESTION_IMPORT_TARGET_BRAND: unique symbol;

/** Opaque capability implemented by ingestion branches accepted by import. */
export type IngestionImportTarget<G extends GraphDef> = Readonly<{
  [INGESTION_IMPORT_TARGET_BRAND]: G;
}>;

const INGESTION_IMPORT_TARGETS = new WeakMap<object, unknown>();

/** Registers the private Store represented by an opaque ingestion handle. */
export function registerIngestionImportTarget<G extends GraphDef>(
  handle: object,
  store: Store<G>,
): void {
  INGESTION_IMPORT_TARGETS.set(handle, store);
}

/** Resolves an import target without making the hidden Store public. */
export function resolveIngestionImportTarget<G extends GraphDef>(
  target: Store<G> | object,
): Store<G> {
  const registeredStore = INGESTION_IMPORT_TARGETS.get(target);
  if (registeredStore !== undefined) return registeredStore as Store<G>;
  if (STORE_RUNTIME in target) return target as Store<G>;
  throw new ConfigurationError(
    "Interchange import received an unrecognized ingestion target",
    { target: "unregistered-ingestion-target" },
    {
      suggestion:
        "Pass a Store or the exact handle returned by ingestionBranch() from this TypeGraph installation.",
    },
  );
}
