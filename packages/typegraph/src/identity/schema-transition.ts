import {
  requireWriteFence,
  resolveWriteFencePlan,
} from "../backend/capabilities/write-fence";
import {
  type GraphBackend,
  type IdentityTableNames,
  type SchemaCommitPreflightBackend,
  type TransactionBackend,
} from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { ConfigurationError } from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { asCompiledRowsSql } from "../query/sql-intent";
import { type KindRegistry } from "../registry/kind-registry";
import {
  lockRecordedGraphWrite,
  withRecordedIdentityMutationTarget,
} from "../store/recorded-capture";
import {
  errorChain,
  isPostgresConcurrentDdlRaceError,
} from "../utils/sql-errors";
import { separationRebuildRequired } from "./separation";
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

/** The logical name of the derived relation the upgrade path provisions. */
const IDENTITY_SEPARATION_RELATION = "identitySeparation";

/**
 * Identity relations added AFTER the profile shipped. On an already-enabled
 * graph their absence is an upgrade, not data loss: they are derived, so they
 * can be provisioned empty and recomputed from the ledger, while a missing
 * ledger or closure relation stays a refusal.
 */
const UPGRADEABLE_DERIVED_RELATIONS: ReadonlySet<string> = new Set([
  IDENTITY_SEPARATION_RELATION,
]);

/**
 * Rebuilds the derived identity relations from the assertion ledger, against
 * whichever target the provisioning path can offer — the schema-write
 * transaction when the CREATE has to be published with the fill, the top-level
 * backend when the relation already exists and only its rows are owed.
 *
 * The full backend union rather than {@link IdentityTarget}: the rebuild opens
 * its own write frame on whatever it is handed, so it needs the top-level
 * `transaction` member to tell "open one" from "already inside one" apart.
 */
export type RecomputeDerivedRelations = (
  target: GraphBackend | TransactionBackend,
) => Promise<void>;

/**
 * What a schema-commit caller still owes after this call.
 *
 * `provisionInCommit` is the identity DDL the caller's commit transaction must
 * issue before its rebuild — empty when nothing is owed. It is DATA, not an
 * action, precisely so the CREATE can happen inside the commit transaction
 * that also fills the relation; see {@link ensureIdentitySchemaStorage}.
 */
export type IdentityStorageProvisioning = Readonly<{
  provisionInCommit: readonly string[];
}>;

const NOTHING_OWED: IdentityStorageProvisioning = { provisionInCommit: [] };

/**
 * Ensures the identity relations exist for a schema transition, and decides —
 * per graph — whether the derived separation relation still owes rows.
 *
 * `enablement` (the target schema turns identity on for the first time) is the
 * only case allowed to provision a missing LEDGER or closure relation. On an
 * already-enabled graph those going missing is data loss, not a provisioning
 * gap, so it is refused.
 *
 * THE INVARIANT THIS FUNCTION OWNS: *the separation relation is never readable
 * in a state that under-reports separations — on any path, including a schema
 * commit that is refused and two graphs upgrading the same database.* A derived
 * relation created empty is not inert: it is readable, and `isSeparated` reads
 * it as authority. An empty separation relation answers "not separated" for
 * EVERY pair, which is precisely the answer that lets `assertSame` fuse two
 * classes a live `different` assertion separates, and the relation's
 * CHECK-constraint backstop cannot fire because there are no rows to collapse.
 * The relation's only safe states are therefore ABSENT (every read raises
 * `IDENTITY_STORAGE_MISSING` — loud, never a wrong answer) and PRESENT AND
 * COMPLETE.
 *
 * Three rules hold that invariant up, and each closes a way the previous
 * "the table is missing → create it, fill it later" shape broke it:
 *
 *  1. THE FILL DECISION IS PER GRAPH, never "does the table exist".
 *     {@link separationRebuildRequired} asks whether THIS graph has live
 *     `different` assertions and no rows. Identity DDL is database-global while
 *     the ledger is per-graph, so table existence answered for the wrong scope:
 *     graph B creating the relation silently suppressed graph A's fill.
 *  2. NOTHING IS CREATED OUTSIDE THE TRANSACTION THAT FILLS IT. When the caller
 *     supplies `recomputeDerivedRelations`, the CREATE and the fill are one
 *     schema-write transaction. When it does not — the schema-commit paths —
 *     the DDL is RETURNED as `provisionInCommit` and issued inside the commit
 *     transaction by {@link identitySchemaCommitPreflight}. A commit that is
 *     refused (a breaking `IDENTITY_PROFILE_MIGRATION_PENDING` gate, a stale
 *     CAS, a contradiction) therefore creates nothing at all.
 *  3. WHAT RULE 2 CANNOT UNDO, RULE 1 HEALS. A relation left present-and-empty
 *     by an older library version, or by another graph's provisioning, is
 *     rebuilt by the next open of the graph that owns the assertions —
 *     self-healing, rather than permanently under-reporting because "present"
 *     was what suppressed the rebuild.
 *  4. HEALING HAPPENS AT AN OPEN, SO A HANDLE THAT PREDATES THE RELATION STAYS
 *     LOUD. Every rule above runs while a Store is being opened; a handle
 *     already open never re-runs them, so one that was opened while the
 *     relation was ABSENT — failing loudly on every identity read — would
 *     otherwise start answering "not separated" the moment another graph's
 *     upgrade created the shared relation. {@link separationRebuildRequired} is
 *     therefore consulted on the READ path too ({@link isSeparated}), which
 *     turns that transition into the same loud `IDENTITY_STORAGE_MISSING`
 *     rather than a silent wrong answer. Reopening the Store is what fixes it,
 *     and the error says so.
 *
 * A graph with no live `different` assertion projects to zero separation rows,
 * so creating that graph's relation empty is not a compromise, it is the
 * correct content — that case needs no fill, no fence, and no atomicity.
 */
export async function ensureIdentitySchemaStorage(
  backend: GraphBackend,
  schema: SqlSchema,
  options: Readonly<{
    graphId: string;
    enablement: boolean;
    /**
     * The kind registry the FILL will derive through. The per-graph predicate
     * scopes the ledger by the same registry, so it never asks for a rebuild
     * that cannot converge.
     */
    registry: KindRegistry;
    recomputeDerivedRelations?: RecomputeDerivedRelations;
  }>,
): Promise<IdentityStorageProvisioning> {
  const ensureIdentityTables = backend.ensureIdentityTables;
  if (ensureIdentityTables === undefined) return NOTHING_OWED;
  const tableNames = identityTableNames(schema);
  const missingTables = await ensureIdentityTables(tableNames, {
    provisionMissing: options.enablement,
  });
  // Enablement provisions every relation up front: the commit preflight it is
  // always paired with reads the ledger before it can fill anything, and a
  // graph whose identity profile is not committed yet has no reader that could
  // observe the derived relation at all.
  if (options.enablement) return NOTHING_OWED;
  assertIdentityStoragePresent(
    options.graphId,
    missingTables.filter((name) => !UPGRADEABLE_DERIVED_RELATIONS.has(name)),
  );
  const separationMissing = missingTables.includes(
    IDENTITY_SEPARATION_RELATION,
  );
  const rebuildRequired = await separationRebuildRequired(
    backend,
    schema,
    options.graphId,
    { relationExists: !separationMissing, registry: options.registry },
  );
  if (!separationMissing && !rebuildRequired) return NOTHING_OWED;
  const recompute = options.recomputeDerivedRelations;
  if (recompute === undefined) {
    return provisioningForCommit(backend, tableNames, options.graphId, {
      ensureIdentityTables,
      separationMissing,
      rebuildRequired,
    });
  }
  await provisionDerivedRelations(backend, tableNames, options.graphId, {
    ensureIdentityTables,
    recompute,
    separationMissing,
    rebuildRequired,
  });
  return NOTHING_OWED;
}

/**
 * The schema-commit path's half of rule 2: hand the CREATE to the commit
 * transaction instead of running it here.
 *
 * Creating it here is what stranded a readable-empty relation whenever the
 * commit was then refused — and left it stranded permanently, because the next
 * open saw the table present and never re-triggered the upgrade.
 *
 * The one case that still provisions eagerly is the safe one: a graph with no
 * live `different` assertion, whose relation is correct while empty. That keeps
 * the derived relation reachable for backends that cannot run DDL inside the
 * commit transaction at all, without ever publishing an under-reporting state.
 */
async function provisioningForCommit(
  backend: GraphBackend,
  tableNames: IdentityTableNames,
  graphId: string,
  input: Readonly<{
    ensureIdentityTables: NonNullable<GraphBackend["ensureIdentityTables"]>;
    separationMissing: boolean;
    rebuildRequired: boolean;
  }>,
): Promise<IdentityStorageProvisioning> {
  if (!input.separationMissing) return NOTHING_OWED;
  const identityTableDdl = backend.identityTableDdl;
  if (identityTableDdl !== undefined) {
    return { provisionInCommit: identityTableDdl(tableNames) };
  }
  if (input.rebuildRequired) {
    throw identityDerivedUpgradeUnsupportedError(graphId, ["identityTableDdl"]);
  }
  await input.ensureIdentityTables(tableNames, { provisionMissing: true });
  return NOTHING_OWED;
}

/**
 * Publishes the derived relations this graph owes, atomically.
 *
 * Three shapes, and which one applies is decided by the per-graph predicate,
 * never by the backend's capabilities — a backend that cannot do what the state
 * requires is refused, not quietly given a weaker guarantee:
 *
 *  - CREATE + FILL — needs both ports, because the two steps must reach other
 *    connections as one commit. `identityTableDdl` is DDL as data rather than a
 *    call back into the top-level backend, which inside the fence would re-enter
 *    the backend's serialized statement queue.
 *  - CREATE alone (no live `different` assertion) — empty IS the projection, so
 *    an ordinary idempotent provision is correct and needs no fence.
 *  - FILL alone (the relation exists, empty, and this graph owes rows) — the
 *    self-heal. The recompute opens its own transaction, validates the schema
 *    version its registry came from, then takes the identity lock. No DDL fence
 *    is needed for an already-published relation; the schema-version fence is
 *    still required to prevent a stale opener overwriting a newer migration.
 */
async function provisionDerivedRelations(
  backend: GraphBackend,
  tableNames: IdentityTableNames,
  graphId: string,
  ports: Readonly<{
    ensureIdentityTables: NonNullable<GraphBackend["ensureIdentityTables"]>;
    recompute: RecomputeDerivedRelations;
    separationMissing: boolean;
    rebuildRequired: boolean;
  }>,
): Promise<void> {
  if (!ports.separationMissing) {
    await ports.recompute(backend);
    return;
  }
  if (!ports.rebuildRequired) {
    await ports.ensureIdentityTables(tableNames, { provisionMissing: true });
    return;
  }
  const fence = backend.schemaWriteTransaction;
  const identityTableDdl = backend.identityTableDdl;
  if (fence === undefined || identityTableDdl === undefined) {
    throw identityDerivedUpgradeUnsupportedError(graphId, [
      ...(fence === undefined ? ["schemaWriteTransaction"] : []),
      ...(identityTableDdl === undefined ? ["identityTableDdl"] : []),
    ]);
  }
  await withIdentityDdlRaceRetry(async () =>
    fence(graphId, async (target) => {
      await lockIdentityDdl(target);
      await executeIdentityDdl(
        (ddl) => target.executeSchemaDdl(ddl),
        identityTableDdl(tableNames),
      );
      await ports.recompute(target);
    }),
  );
}

/**
 * Errors already classified as "the identity DDL specifically lost a catalog
 * race".
 *
 * Marked rather than wrapped, so the error a caller finally sees is the
 * driver's own; looked up through the cause chain because both the schema fence
 * and the schema-commit primitive wrap whatever their callback throws.
 */
const IDENTITY_DDL_RACES = new WeakSet<object>();

function markIdentityDdlRace(error: unknown): unknown {
  if (typeof error === "object" && error !== null) {
    IDENTITY_DDL_RACES.add(error);
  }
  return error;
}

function isIdentityDdlRace(error: unknown): boolean {
  for (const link of errorChain(error)) {
    if (
      typeof link === "object" &&
      link !== null &&
      IDENTITY_DDL_RACES.has(link)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Issues identity DDL, tagging the one failure that is worth re-running.
 *
 * The single place identity DDL meets {@link isPostgresConcurrentDdlRaceError},
 * and the reason the retry below can be DDL-scoped while still re-running a
 * whole transaction. That classifier's contract is "idempotent DDL only" — on
 * any other statement a 23505 is a real duplicate write — so the surrounding
 * attempt, which also performs the closure/separation FILL, must not be
 * classified by it directly: a uniqueness failure from the fill would be read
 * as a catalog race and silently retried. Tagging at the DDL statement itself
 * keeps the classifier on exactly the statements it is contracted for.
 */
async function executeIdentityDdl(
  execute: (ddl: string) => Promise<void>,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    try {
      await execute(statement);
    } catch (error) {
      if (isPostgresConcurrentDdlRaceError(error)) {
        throw markIdentityDdlRace(error);
      }
      throw error;
    }
  }
}

/**
 * Runs an identity upgrade attempt, retrying the WHOLE attempt once when its
 * DDL — and only its DDL — lost a catalog race.
 *
 * PostgreSQL's `IF NOT EXISTS` cannot see another session's uncommitted
 * pg_class row, so a CREATE issued while an unfenced creator
 * (`bootstrapTables`, first-enablement `ensureIdentityTables`) is mid-flight
 * can come back 23505 (or 42701 for an additive column) — and inside a
 * transaction that aborts everything, so the in-place retry
 * `executeConcurrentCreateDdl` uses is not available, and neither is any
 * in-transaction recovery: after the error the transaction can accept nothing
 * but a rollback. Re-running the attempt from the outside is the only shape
 * left. The second attempt runs against a database where the winner's relation
 * is committed, so the CREATE is a no-op.
 *
 * Retry-worthiness is decided by {@link executeIdentityDdl}'s tag, not by
 * inspecting the failure here: everything else in an attempt (the fill, the
 * locks, the CAS) must stay loud on the first failure.
 *
 * Bounded at one: a second such failure is no longer a race, and staying loud
 * is the point.
 *
 * The DDL advisory lock is what makes this rare rather than routine — it
 * serializes fenced identity DDL across graphs, which is the collision two
 * graphs upgrading the same database would otherwise hit every time.
 */
export async function withIdentityDdlRaceRetry<T>(
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isIdentityDdlRace(error)) throw error;
    return attempt();
  }
}

/**
 * The DATABASE-scoped critical section for identity DDL.
 *
 * The schema-write fence is per GRAPH, but the identity relations are shared by
 * every graph in the database, so two graphs upgrading at once are not
 * serialized by it at all — they race the CREATE, and on PostgreSQL the loser
 * gets 23505 inside a transaction it cannot retry in place. One constant-keyed
 * transaction-scoped advisory lock removes the race instead of recovering from
 * it.
 *
 * ORDER: outermost among the IDENTITY locks, innermost to the SCHEMA FENCE.
 * Every path that reaches here is already inside the backend's per-graph
 * schema-write transaction (`schemaWriteTransaction` or
 * `commitSchemaVersionWithPreflight`), which took that graph's fence first;
 * this lock is then taken before the per-graph identity and recorded-write
 * locks, on every path that takes both. Two openers of the SAME graph — one on
 * the boot fence, one in a schema commit — would otherwise be able to hold one
 * lock each and wait for the other.
 *
 * The safety condition for the nesting is that nobody acquires a DIFFERENT
 * graph's schema fence while holding this lock: fence(A) → ddl → fence(B) is
 * the one shape that could close a cycle with fence(B) → ddl → fence(A). No
 * caller does — a schema fence is taken once, at the outside, for the graph
 * being transitioned — and the DDL issued under this lock is graph-agnostic
 * (`CREATE TABLE IF NOT EXISTS` on shared relations), so there is nothing here
 * that would want a second graph's fence.
 *
 * SQLite needs nothing: its writer slot already serializes the whole database —
 * with the adopted-DEFERRED-frame caveat `lockIdentityGraph` documents, which
 * `executeIdentityStatement` turns into a typed refusal (#447). Schema
 * transitions run inside the backend's own schema-write transaction, so this
 * path is not reachable from an adopted frame today.
 *
 * Resolves a {@link resolveWriteFencePlan}: the `lock` arm takes the advisory
 * lock below, and the `engine-serialized` arm is the SQLite writer-slot case
 * this doc already describes.
 */
async function lockIdentityDdl(target: IdentityTarget): Promise<void> {
  const plan = resolveWriteFencePlan(target);
  const fence = requireWriteFence(plan, "identity DDL", "advisory-lock");
  switch (fence.kind) {
    case "lock": {
      await target.execute(
        asCompiledRowsSql(fence.sql.advisoryLock(IDENTITY_DDL_LOCK_KEY, 0)),
      );
      return;
    }
    case "engine-serialized": {
      return;
    }
    default: {
      fence satisfies never;
    }
  }
}

const IDENTITY_DDL_LOCK_KEY = "typegraph:identity-ddl";

/**
 * A backend that cannot publish the derived-relation upgrade atomically, on a
 * graph whose state requires atomicity.
 *
 * Refused rather than degraded. The degraded shape — create the relation, fill
 * it in a second statement — is readable and empty in between, and "empty"
 * means "nothing is separated", the one wrong answer that lets a contradictory
 * merge commit. An engine gap is declared, never worked around unsafely.
 *
 * Not reachable for the bundled backends: both Drizzle backends implement both
 * ports whenever transactions are enabled, and identity already refuses a
 * non-transactional backend earlier with `IDENTITY_REQUIRES_ATOMIC_BACKEND`.
 * This is the custom-backend path.
 */
function identityDerivedUpgradeUnsupportedError(
  graphId: string,
  missingPorts: readonly string[],
): ConfigurationError {
  return new ConfigurationError(
    "This backend cannot publish an Operational Identity derived-relation upgrade atomically.",
    {
      code: "IDENTITY_UPGRADE_REQUIRES_ATOMIC_DDL",
      graphId,
      missingPorts,
      tables: [IDENTITY_SEPARATION_RELATION],
    },
    {
      suggestion:
        "Use a backend that implements schemaWriteTransaction and identityTableDdl (both bundled Drizzle backends do when transactions are enabled). Creating the separation relation and filling it as two steps would leave it readable and empty in between, where every pair reads as not separated. To upgrade out of band, create the relation with the standard TypeGraph DDL and run rebuildIdentityClosure(store) before serving traffic.",
    },
  );
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
 * provision any derived relation the transition owes, take the recorded-write
 * and identity locks, then re-derive the closure so it matches the schema
 * version being committed.
 *
 * Every path that commits a schema version for an identity-enabled graph uses
 * this — `createStoreWithSchema`, `Store.evolve()`, and the explicit
 * `migrateSchema()` — so a profile flip or a first enablement can never commit
 * against a stale or never-built closure.
 *
 * `provisionDerivedRelations` is the DDL {@link ensureIdentitySchemaStorage}
 * declined to run outside this transaction (its `provisionInCommit`). Issuing
 * it here is what makes the whole upgrade one commit: a refused or failed
 * transition leaves NO relation behind, rather than an empty one that reads as
 * "nothing is separated". The DDL runs before the per-graph locks because the
 * database-scoped DDL lock it takes must always be the outer one.
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
    provisionDerivedRelations?: readonly string[];
  }>,
): (target: SchemaCommitPreflightBackend) => Promise<void> {
  return async (target: SchemaCommitPreflightBackend) => {
    await provisionDerivedRelationsInCommit(
      target,
      ctx.graphId,
      options.provisionDerivedRelations ?? [],
    );
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
 * Issues the transition's derived-relation DDL inside the commit transaction.
 *
 * The port is optional on the preflight target because a custom backend's
 * `commitSchemaVersionWithPreflight` may hand back a transaction that cannot
 * run DDL. That is refused with the same typed capability error as the fenced
 * path, at the moment the DDL is actually needed — never silently skipped,
 * which would let the commit's rebuild write into a relation that does not
 * exist, or (worse, if it were created afterwards) publish it empty.
 *
 * This is the SAME idempotent DDL the fenced path issues, so it can lose the
 * same catalog race — two replicas booting against one database — and it is
 * issued inside the CALLER's schema-commit transaction, where neither an
 * in-place retry nor an in-transaction catch is available (PostgreSQL will
 * accept nothing but a rollback after the error). Hoisting it outside the
 * transaction is refused for the reason the docblock above gives: a relation
 * created but not filled reads as "nothing is separated". So it tags the race
 * through {@link executeIdentityDdl} and the whole commit is re-run once by
 * {@link withIdentityDdlRaceRetry} at the call sites in `schema/manager.ts`
 * (#445).
 */
async function provisionDerivedRelationsInCommit(
  target: SchemaCommitPreflightBackend,
  graphId: string,
  ddl: readonly string[],
): Promise<void> {
  if (ddl.length === 0) return;
  const executeSchemaDdl = target.executeSchemaDdl;
  if (executeSchemaDdl === undefined) {
    throw identityDerivedUpgradeUnsupportedError(graphId, ["executeSchemaDdl"]);
  }
  await lockIdentityDdl(target);
  await executeIdentityDdl((statement) => executeSchemaDdl(statement), ddl);
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
