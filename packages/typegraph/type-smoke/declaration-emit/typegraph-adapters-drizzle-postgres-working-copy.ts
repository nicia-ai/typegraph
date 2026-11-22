/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/adapters/drizzle/postgres/working-copy` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import { createPostgresWorkingCopyManager } from "@nicia-ai/typegraph/adapters/drizzle/postgres/working-copy";

export const workingCopies = (
  ...args: Parameters<typeof createPostgresWorkingCopyManager>
) => createPostgresWorkingCopyManager(...args);
