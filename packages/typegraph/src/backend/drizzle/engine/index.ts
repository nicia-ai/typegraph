/**
 * The SQL engine profile barrel: the profile types every engine builds
 * against, and the one factory (`createSqlBackend`) that assembles a
 * backend from one.
 */
export { createSqlBackend } from "./create-sql-backend";
export type {
  EngineAssemblyContext,
  EngineLateMembers,
  EngineProvisioning,
  EngineTableNames,
  OperationFusionHooks,
  SqlEngineProfile,
} from "./profile";
