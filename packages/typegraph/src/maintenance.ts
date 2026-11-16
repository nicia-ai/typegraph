/**
 * `@nicia-ai/typegraph/maintenance`: operator tooling for a database that
 * holds TypeGraph graphs. Lists and inspects the graphs a database holds, and
 * runs the one-shot storage migrations and repairs.
 *
 * Maintenance that runs through a store (`materializeSystemIndexes`,
 * `verifyContributions`, ...) stays on `Store`.
 */

export {
  type GraphStorageConsistency,
  type GraphStorageInspection,
  type GraphStorageRelation,
  listGraphIds,
  type ListGraphIdsOptions,
} from "./backend/graph-storage";
export {
  deleteLegacyRecordedAnchorMap,
  type DeleteLegacyRecordedAnchorMapOptions,
  migrateLegacyRecordedTime,
  type MigrateLegacyRecordedTimeOptions,
  type MigrateLegacyRecordedTimeResult,
  migrateRecordedAnchor,
  type MigrateRecordedAnchorOptions,
} from "./backend/migrate-recorded-time";
export {
  type LegacyEmbeddingSlotConfig,
  migrateLegacyEmbeddings,
  type MigrateLegacyEmbeddingsOptions,
  type MigrateLegacyEmbeddingsResult,
} from "./backend/migrate-vectors";
export {
  repairInvertedValidityWindows,
  type RepairInvertedWindowsOptions,
  type RepairInvertedWindowsReport,
  type RepairRelation,
  type RepairRelationScope,
} from "./backend/repair-validity-windows";
export { inspectGraphStorage } from "./store/inspect-graph-storage";
