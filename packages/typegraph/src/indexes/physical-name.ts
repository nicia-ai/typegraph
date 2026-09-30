/**
 * Physical relational-index names bound to a managed backend and inherited by
 * every backend derived from it.
 */
import { backendDerivationChain } from "../backend/derive-backend";
import type { GraphBackend } from "../backend/types";
import { ConfigurationError } from "../errors";
import type { IndexDeclaration, RelationalIndexDeclaration } from "./types";

/**
 * Names the given declarations' physical indexes. A binding whose graph is
 * unknown when the backend is allocated supplies one so names can be minted
 * when a Store first presents its declarations.
 */
export type RelationalIndexNameResolver = (
  declarations: readonly RelationalIndexDeclaration[],
) => Promise<ReadonlyMap<string, string>>;

type IndexNameBinding = Readonly<{
  names: Map<string, string>;
  resolve: RelationalIndexNameResolver | undefined;
}>;

const INDEX_NAMES = new WeakMap<object, IndexNameBinding>();

function indexNameBinding(backend: GraphBackend): IndexNameBinding | undefined {
  for (const link of backendDerivationChain(backend)) {
    const binding = INDEX_NAMES.get(link);
    if (binding !== undefined) return binding;
  }
  return undefined;
}

const INDEX_NAME_COLLISION_CODE = "WORKING_COPY_INDEX_NAME_COLLISION";

/** The one error for two declarations that resolve to one physical index name. */
export function indexNameCollisionError(message: string): ConfigurationError {
  return new ConfigurationError(message, { code: INDEX_NAME_COLLISION_CODE });
}

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
  INDEX_NAMES.set(backend, { names: new Map(names), resolve: undefined });
}

/**
 * @internal Bind a resolver for a backend allocated before any graph exists.
 * Names are minted by {@link prepareRelationalIndexNames}; an unprepared
 * declaration is still refused rather than falling back to its global name.
 */
export function bindRelationalIndexNameResolver(
  backend: GraphBackend,
  resolve: RelationalIndexNameResolver,
): void {
  INDEX_NAMES.set(backend, { names: new Map(), resolve });
}

/**
 * Mint physical names for every not-yet-resolved relational declaration on a
 * backend bound through {@link bindRelationalIndexNameResolver}. A no-op for
 * every other backend, so callers need not know which kind they hold.
 */
export async function prepareRelationalIndexNames(
  backend: GraphBackend,
  declarations: readonly IndexDeclaration[],
): Promise<void> {
  const binding = indexNameBinding(backend);
  if (binding?.resolve === undefined) return;
  const unresolved = declarations.filter(
    (declaration): declaration is RelationalIndexDeclaration =>
      declaration.entity !== "vector" &&
      !binding.names.has(relationalIndexIdentity(declaration)),
  );
  if (unresolved.length === 0) return;
  const minted = await binding.resolve(unresolved);
  const owners = new Map(
    [...binding.names].map(([identity, name]) => [name, identity]),
  );
  for (const [identity, physicalName] of minted) {
    const owner = owners.get(physicalName);
    if (owner !== undefined && owner !== identity) {
      throw indexNameCollisionError(
        `Managed PostgreSQL working copy resolved index "${physicalName}" for two declarations.`,
      );
    }
    owners.set(physicalName, identity);
    binding.names.set(identity, physicalName);
  }
}

/** Resolve one declaration through the backend that owns its physical tables. */
export function relationalIndexPhysicalName(
  backend: GraphBackend,
  declaration: RelationalIndexDeclaration,
): string {
  const bound = indexNameBinding(backend);
  if (bound === undefined) return declaration.name;
  const physicalName = bound.names.get(relationalIndexIdentity(declaration));
  if (physicalName !== undefined) return physicalName;
  throw new ConfigurationError(
    `Managed PostgreSQL working copy cannot materialize undeclared index "${declaration.name}".`,
    { code: "WORKING_COPY_INDEX_UNDECLARED" },
  );
}
