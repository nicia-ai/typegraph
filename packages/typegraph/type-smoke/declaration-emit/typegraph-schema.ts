/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/schema` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  computeSchemaDiff,
  createVerifiedStore,
  ensureSchema,
  getSchemaChanges,
  migrateSchema,
  serializeSchema,
} from "@nicia-ai/typegraph/schema";

export const serialize = (...args: Parameters<typeof serializeSchema>) =>
  serializeSchema(...args);
export const diff = (...args: Parameters<typeof computeSchemaDiff>) =>
  computeSchemaDiff(...args);
export const ensure = (...args: Parameters<typeof ensureSchema>) =>
  ensureSchema(...args);
export const migrate = (...args: Parameters<typeof migrateSchema>) =>
  migrateSchema(...args);
export const changes = (...args: Parameters<typeof getSchemaChanges>) =>
  getSchemaChanges(...args);
export const verifiedStore = (
  ...args: Parameters<typeof createVerifiedStore>
) => createVerifiedStore(...args);
