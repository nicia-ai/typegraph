import {
  type GraphBackend,
  type IdentityTableNames,
  type TransactionBackend,
} from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { ConfigurationError } from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import {
  lockRecordedGraphWrite,
  withRecordedIdentityMutationTarget,
} from "../store/recorded-capture";
import {
  deleteAssertionsTouchingKinds,
  hasAssertionsTouchingKinds,
  type IdentityRebuildContext,
  lockIdentityEnablementNodes,
  lockIdentityGraph,
  purgeAssertionsWithUnregisteredKinds,
  rebuildIdentityClosureForContext,
} from "./service";
import { type IdentityTarget } from "./sql-target";

/** The identity relations a schema transition reads, writes, and locks. */
function identityTableNames(schema: SqlSchema): IdentityTableNames {
  return {
    identityAssertions: schema.tables.identityAssertions,
    recordedIdentityAssertions: schema.tables.recordedIdentityAssertions,
    identityClosure: schema.tables.identityClosure,
    identitySeparation: schema.tables.identitySeparation,
  };
}

/**
 * Identity relations added AFTER the profile shipped. On an already-enabled
 * graph their absence is an upgrade, not data loss: they are derived, so they
 * can be provisioned empty and recomputed from the ledger, while a missing
 * ledger or closure relation stays a refusal.
 */
const UPGRADEABLE_DERIVED_RELATIONS: ReadonlySet<string> = new Set([
  "identitySeparation",
]);

/**
 * Rebuilds the derived identity relations from the assertion ledger, against
 * whichever target the provisioning path can offer — the schema-write
 * transaction when the backend has one, the top-level backend otherwise.
 */
export type RecomputeDerivedRelations = (
  target: IdentityTarget,
) => Promise<void>;

/**
 * Ensures the identity relations exist before a schema-commit transaction
 * opens. The preflight runs *inside* that transaction and reads/writes these
 * tables, so issuing their DDL there would re-enter the per-graph write lock
 * the commit already holds.
 *
 * `enablement` (the target schema turns identity on for the first time) is the
 * only case allowed to provision a missing LEDGER or closure relation. On an
 * already-enabled graph those going missing is data loss, not a provisioning
 * gap, so it is refused.
 *
 * THE INVARIANT THIS FUNCTION OWNS: *the separation relation is never readable
 * in a state that under-reports separations.* A derived relation created empty
 * is not inert — it is readable, and `isSeparated` reads it as authority. An
 * empty separation relation answers "not separated" for EVERY pair, which is
 * precisely the answer that lets `assertSame` fuse two classes a live
 * `different` assertion separates, and the relation's CHECK-constraint
 * backstop cannot fire because there are no rows to collapse. The relation's
 * only safe states are therefore ABSENT (every read raises
 * `IDENTITY_STORAGE_MISSING` — loud, never a wrong answer) and PRESENT AND
 * FILLED. So when `recomputeDerivedRelations` is supplied, the CREATE and the
 * fill are issued inside ONE schema-write transaction: concurrent readers see
 * the pre-upgrade absence until the commit publishes both together, and
 * concurrent schema writers queue behind the fence.
 *
 * Callers that do NOT supply a recompute get the old contract back — the
 * relation is created and `recomputeDerivedRelations: true` says the caller
 * owes the fill. The only such callers are the schema-commit paths, whose fill
 * runs inside the commit transaction ({@link identitySchemaCommitPreflight}),
 * bounding the window to that commit instead of a whole boot sequence.
 */
export async function ensureIdentitySchemaStorage(
  backend: GraphBackend,
  schema: SqlSchema,
  options: Readonly<{
    graphId: string;
    enablement: boolean;
    recomputeDerivedRelations?: RecomputeDerivedRelations;
  }>,
): Promise<Readonly<{ recomputeDerivedRelations: boolean }>> {
  const ensureIdentityTables = backend.ensureIdentityTables;
  if (ensureIdentityTables === undefined) {
    return { recomputeDerivedRelations: false };
  }
  const tableNames = identityTableNames(schema);
  const missingTables = await ensureIdentityTables(tableNames, {
    provisionMissing: options.enablement,
  });
  if (options.enablement || missingTables.length === 0) {
    return { recomputeDerivedRelations: false };
  }
  assertIdentityStoragePresent(
    options.graphId,
    missingTables.filter((name) => !UPGRADEABLE_DERIVED_RELATIONS.has(name)),
  );
  // Every missing relation is an upgradeable derived one: the first call
  // withheld its DDL (that withholding is what protects a lost ledger), so
  // provision it now that the refusal above has cleared it.
  const recompute = options.recomputeDerivedRelations;
  if (recompute === undefined) {
    await ensureIdentityTables(tableNames, { provisionMissing: true });
    return { recomputeDerivedRelations: true };
  }
  await provisionDerivedRelations(backend, tableNames, options.graphId, {
    ensureIdentityTables,
    recompute,
  });
  return { recomputeDerivedRelations: false };
}

/**
 * Creates the missing derived relations and fills them, atomically where the
 * backend can.
 *
 * The DDL comes from `backend.identityTableDdl` — deliberately data rather
 * than a call into the top-level backend, because inside the fence a top-level
 * backend method would re-enter the backend's serialized statement queue.
 */
async function provisionDerivedRelations(
  backend: GraphBackend,
  tableNames: IdentityTableNames,
  graphId: string,
  ports: Readonly<{
    ensureIdentityTables: NonNullable<GraphBackend["ensureIdentityTables"]>;
    recompute: RecomputeDerivedRelations;
  }>,
): Promise<void> {
  const fence = backend.schemaWriteTransaction;
  const identityTableDdl = backend.identityTableDdl;
  if (fence === undefined || identityTableDdl === undefined) {
    // A backend that offers neither port cannot make the two steps atomic, so
    // they are at least adjacent — no boot work runs between them. Both bundled
    // Drizzle backends implement both ports whenever transactions are enabled,
    // and identity already refuses a backend without transactions
    // (`IDENTITY_REQUIRES_ATOMIC_BACKEND`), so this is the custom-backend path.
    // Residual, stated plainly: on such a backend the relation is briefly
    // readable while empty.
    await ports.ensureIdentityTables(tableNames, { provisionMissing: true });
    await ports.recompute(backend);
    return;
  }
  await fence(graphId, async (target) => {
    for (const ddl of identityTableDdl(tableNames)) {
      await target.executeSchemaDdl(ddl);
    }
    await ports.recompute(target);
  });
}

/**
 * Whether dropping `droppedNodeKinds` from a graph whose schema carries NO
 * identity profile still leaves assertion rows behind. Disabling identity
 * retains the ledger, so "no profile" does not mean "no assertions" — a drop
 * committed afterwards strands every assertion naming the kind.
 *
 * Answering `false` keeps the commit on its ordinary path, which matters: that
 * path carries the emptiness fence and its capability requirements. Only a
 * database that genuinely holds affected rows is worth moving to the
 * preflight-carrying primitive, and with no profile nothing can be writing new
 * assertions for this graph while the answer is in flight.
 *
 * Partial storage answers `false` too: an enabled graph treats a missing
 * relation as data loss ({@link assertIdentityStoragePresent}), but a disabled
 * graph must not have its migration refused over a relation nothing reads.
 */
export async function identityKindCascadeNeeded(
  backend: GraphBackend,
  schema: SqlSchema,
  graphId: string,
  droppedNodeKinds: readonly string[],
): Promise<boolean> {
  if (droppedNodeKinds.length === 0) return false;
  const ensureIdentityTables = backend.ensureIdentityTables;
  if (ensureIdentityTables === undefined) return false;
  const missingTables = await ensureIdentityTables(identityTableNames(schema), {
    provisionMissing: false,
  });
  if (missingTables.length > 0) return false;
  return hasAssertionsTouchingKinds(backend, schema, graphId, droppedNodeKinds);
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
        "Restore missing assertion-ledger tables from backup. If only the derived relations (closure, separation) are missing, recreate them with the standard TypeGraph DDL, open the Store, and run rebuildIdentityClosure() before serving traffic.",
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
  options: Readonly<{
    enablement: boolean;
    droppedNodeKinds?: readonly string[];
  }>,
): (target: TransactionBackend) => Promise<void> {
  return async (target: TransactionBackend) => {
    await lockRecordedGraphWrite(target, ctx.graphId);
    await lockIdentityGraph(target, ctx.graphId);
    if (options.enablement) {
      await lockIdentityEnablementNodes(target, ctx.schema);
      // Enablement must not ADOPT rows the rebuild below cannot see. A database
      // that was identity-enabled before, disabled, and then evolved can hold
      // assertions for kinds this schema never registers; they would stay
      // current and invisible for exactly the reasons the drop cascade exists.
      // On a true first enablement the ledger is empty and this is one scan.
      await withRecordedIdentityMutationTarget(target, (rawTarget, touch) =>
        purgeAssertionsWithUnregisteredKinds(
          rawTarget,
          ctx.schema,
          ctx.graphId,
          new Set(ctx.registry.nodeKinds.keys()),
          touch,
        ),
      );
    }
    // A commit that DROPS node kinds cascades the assertion ledger exactly as
    // Store.removeKinds() does. The rebuild below silently FILTERS rows
    // touching unregistered kinds, so skipping this would leave a dropped
    // kind's assertions current as orphans — invisible to the closure and to
    // live-endpoint interchange reads, yet still visible to raw ledger reads
    // and merge staging, where a later "no-op" merge would end them.
    const droppedNodeKinds = options.droppedNodeKinds ?? [];
    if (droppedNodeKinds.length > 0) {
      await withRecordedIdentityMutationTarget(target, (rawTarget, touch) =>
        deleteAssertionsTouchingKinds(
          rawTarget,
          ctx.schema,
          ctx.graphId,
          droppedNodeKinds,
          touch,
        ),
      );
    }
    await rebuildIdentityClosureForContext({ ...ctx, backend: target });
  };
}

/**
 * The kind-drop cascade alone, for a schema commit whose target graph has NO
 * identity profile while the assertion ledger still exists. Disabling identity
 * retains the ledger deliberately, so the rows survive the profile going away —
 * and a later drop that skipped this would strand them exactly as it would on
 * an enabled graph, until a re-enablement or a "no-op" merge tripped over them.
 *
 * No closure rebuild: without a profile there is no closure contract to
 * restore, and the enablement preflight rebuilds it from scratch anyway.
 */
export function identityKindCascadePreflight(
  ctx: Readonly<{ graphId: string; schema: SqlSchema }>,
  droppedNodeKinds: readonly string[],
): (target: TransactionBackend) => Promise<void> {
  return async (target: TransactionBackend) => {
    await lockRecordedGraphWrite(target, ctx.graphId);
    await lockIdentityGraph(target, ctx.graphId);
    await withRecordedIdentityMutationTarget(target, (rawTarget, touch) =>
      deleteAssertionsTouchingKinds(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        droppedNodeKinds,
        touch,
      ),
    );
  };
}
