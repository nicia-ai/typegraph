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
  EngineAssemblyContext,
  EngineLateMembers,
  EngineOperationsContext,
  EngineProvisioning,
  EngineTableNames,
  GraphTemplateRuntime,
  IdentityRuntime,
  IndexMaterializationRuntime,
  KindRemovalRuntime,
  SqlEngineProfile,
} from "./profile";
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
 * so exporting a profile-returning function there would make every type
 * behind `buildOperations`/`lateMembers` reachable from a released surface.
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
