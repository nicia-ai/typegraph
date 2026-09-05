/**
 * The SQL engine profile barrel: the profile types every engine builds
 * against, the one factory (`createSqlBackend`) that assembles a backend
 * from one, the two bundled builders that produce a profile in the first
 * place, and `deriveEngineProfile` for building a variant of one.
 */
export { createSqlBackend } from "./create-sql-backend";
export {
  DERIVABLE_ENGINE_PROFILE_KEYS,
  type DerivableEngineProfileKey,
  type DerivableEngineProfileOverrides,
  deriveEngineProfile,
} from "./derive-profile";
export type {
  BaseSchemaRuntime,
  ContributionRuntime,
  EngineProvisioning,
  EngineTableNames,
  GraphTemplateRuntime,
  IdentityRuntime,
  IndexMaterializationRuntime,
  KindRemovalRuntime,
  SqlEngineProfile,
} from "./profile";
/**
 * The opaque type `SqlEngineProfile.assembly` carries — see `./assembly`'s
 * module doc for what it hides. Exported so the type is nameable at this
 * entrypoint; its only constructor, `assembleEngine`, and the resolver
 * `createSqlBackend` uses, `resolveEngineAssembly`, are exported from
 * `./assembly` for the two bundled builders and `createSqlBackend` alone,
 * never from here.
 */
export type { EngineAssembly } from "./assembly";
/**
 * The serialized-resource verdict a profile carries as `resourceAudit`
 * (`SqlEngineProfile.resourceAudit`) — public here because
 * `DerivableEngineProfileOverrides` exposes that field for override, so an
 * author building a derived profile's replacement verdict needs the type to
 * construct one.
 */
export type { BackendResourceAudit } from "../../transaction-resource";
/**
 * The PostgreSQL {@link SqlEngineProfile} builder — the derivation base
 * `deriveEngineProfile` (this entrypoint) starts every derived PostgreSQL
 * profile from. Exported here, not from `./adapters/drizzle/postgres`: that
 * entrypoint is released and only ever hands a caller a finished backend,
 * so exporting a profile-returning function there would pull the profile's
 * whole head type graph (`execution`, `strategy`, `provisioning`, the
 * `*Runtime` deps) onto a released surface; the opaque `assembly` keeps only
 * the operation and late-member closures off it.
 * This entrypoint is unreleased and is exactly where profile instances
 * belong. The returned object, and only that object, is first-party — see
 * `SqlEngineProfile`'s own doc comment.
 */
export { buildPostgresEngineProfile } from "../postgres";
/**
 * The SQLite {@link SqlEngineProfile} builder — the derivation base
 * `deriveEngineProfile` (this entrypoint) starts every derived SQLite
 * profile from. Exported here, not from `./adapters/drizzle/sqlite`, for
 * the same reason as {@link buildPostgresEngineProfile}. The returned
 * object, and only that object, is first-party — see `SqlEngineProfile`'s
 * own doc comment.
 */
export { buildSqliteEngineProfile } from "../sqlite";
