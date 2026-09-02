/**
 * The SQL engine profile barrel: the profile types every engine builds
 * against, and the one factory (`createSqlBackend`) that assembles a
 * backend from one.
 */
export { createSqlBackend } from "./create-sql-backend";
export type {
  BaseSchemaRuntime,
  ContributionRuntime,
  EngineAssemblyContext,
  EngineLateMembers,
  EngineProvisioning,
  EngineTableNames,
  GraphTemplateRuntime,
  IdentityRuntime,
  IndexMaterializationRuntime,
  KindRemovalRuntime,
  SqlEngineProfile,
} from "./profile";
