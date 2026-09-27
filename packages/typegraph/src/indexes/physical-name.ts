/** Physical relational-index names bound to an exact managed backend. */
import type { GraphBackend } from "../backend/types";
import { ConfigurationError } from "../errors";
import type { RelationalIndexDeclaration } from "./types";

const INDEX_NAMES = new WeakMap<GraphBackend, ReadonlyMap<string, string>>();

/** An unambiguous declaration identity, independent of schema serialization. */
export function relationalIndexIdentity(
  declaration: RelationalIndexDeclaration,
): string {
  return JSON.stringify([
    declaration.entity,
    declaration.kind,
    declaration.name,
  ]);
}

/** @internal Bind the allocation's attested name map to the Store backend. */
export function bindRelationalIndexNames(
  backend: GraphBackend,
  names: ReadonlyMap<string, string>,
): void {
  INDEX_NAMES.set(backend, new Map(names));
}

/** Resolve one declaration through the backend that owns its physical tables. */
export function relationalIndexPhysicalName(
  backend: GraphBackend,
  declaration: RelationalIndexDeclaration,
): string {
  const bound = INDEX_NAMES.get(backend);
  if (bound === undefined) return declaration.name;
  const physicalName = bound.get(relationalIndexIdentity(declaration));
  if (physicalName !== undefined) return physicalName;
  throw new ConfigurationError(
    `Managed PostgreSQL working copy cannot materialize undeclared index "${declaration.name}".`,
    { code: "WORKING_COPY_INDEX_UNDECLARED" },
  );
}
