import { type GraphBackend, type TransactionBackend } from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { ConfigurationError } from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { lockRecordedGraphWrite } from "../store/recorded-capture";
import {
  type IdentityRebuildContext,
  lockIdentityEnablementNodes,
  lockIdentityGraph,
  rebuildIdentityClosureForContext,
} from "./service";

/** The identity relations a schema transition reads, writes, and locks. */
function identityTableNames(schema: SqlSchema): Readonly<{
  identityAssertions: string;
  recordedIdentityAssertions: string;
  identityClosure: string;
}> {
  return {
    identityAssertions: schema.tables.identityAssertions,
    recordedIdentityAssertions: schema.tables.recordedIdentityAssertions,
    identityClosure: schema.tables.identityClosure,
  };
}

/**
 * Ensures the identity relations exist before a schema-commit transaction
 * opens. The preflight runs *inside* that transaction and reads/writes these
 * tables, so issuing their DDL there would re-enter the per-graph write lock
 * the commit already holds.
 *
 * `enablement` (the target schema turns identity on for the first time) is the
 * only case allowed to provision missing tables. On an already-enabled graph a
 * missing relation is data loss, not a provisioning gap, so it is refused.
 */
export async function ensureIdentitySchemaStorage(
  backend: GraphBackend,
  schema: SqlSchema,
  options: Readonly<{ graphId: string; enablement: boolean }>,
): Promise<void> {
  const missingTables =
    (await backend.ensureIdentityTables?.(identityTableNames(schema), {
      provisionMissing: options.enablement,
    })) ?? [];
  if (options.enablement) return;
  assertIdentityStoragePresent(options.graphId, missingTables);
}

function assertIdentityStoragePresent(
  graphId: string,
  missingTables: readonly string[],
): void {
  if (missingTables.length === 0) return;
  throw new ConfigurationError(
    "Operational Identity storage was missing from an already enabled graph.",
    {
      code: "IDENTITY_STORAGE_MISSING",
      graphId,
      tables: missingTables,
    },
    {
      suggestion:
        "Restore missing assertion-ledger tables from backup. If only the derived closure is missing, recreate that relation with the standard TypeGraph DDL, open the Store, and run rebuildIdentityClosure() before serving traffic.",
    },
  );
}

/**
 * Builds the data preflight a schema commit runs inside its own transaction:
 * take the recorded-write and identity locks, then re-derive the closure so it
 * matches the schema version being committed.
 *
 * Every path that commits a schema version for an identity-enabled graph uses
 * this — `createStoreWithSchema`, `Store.evolve()`, and the explicit
 * `migrateSchema()` — so a profile flip or a first enablement can never commit
 * against a stale or never-built closure.
 *
 * First enablement additionally fences legacy node writers: nodes written
 * through a store that predates the enablement would otherwise land after the
 * fold scan and miss the closure.
 */
export function identitySchemaCommitPreflight<G extends GraphDef>(
  ctx: Omit<IdentityRebuildContext<G>, "backend">,
  options: Readonly<{ enablement: boolean }>,
): (target: TransactionBackend) => Promise<void> {
  return async (target: TransactionBackend) => {
    await lockRecordedGraphWrite(target, ctx.graphId);
    await lockIdentityGraph(target, ctx.graphId);
    if (options.enablement) {
      await lockIdentityEnablementNodes(target, ctx.schema);
    }
    await rebuildIdentityClosureForContext({ ...ctx, backend: target });
  };
}
