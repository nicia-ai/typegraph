/**
 * The one factory every SQL engine profile is assembled through.
 *
 * `createSqlBackend` owns what is the same for every SQL engine: deriving
 * the final capabilities, building the ONE write-fence target and resolving
 * its plan once, refusing a profile that cannot back the marks it is about
 * to earn, resolving the profile's opaque `assembly` (`./assembly`) into its
 * `buildOperations`/`lateMembers` pair, building the contribution-marker and
 * operation-backend layers from the profile's own deps, assembling every
 * mirrored adapter member group, auditing the backend's resource shape, and
 * applying the trust marks and atomic-program registrations. A profile owns
 * only what genuinely differs between engines.
 */
import { ConfigurationError } from "../../../errors";
import { WRITE_MEMBER_KEYS } from "../../../store/operations/write-members";
import { requireDefined } from "../../../utils/presence";
import {
  isFirstPartyProfile,
  markFirstPartyFactory,
  resolveWriteFencePlan,
  writeFenceDeclarationLine,
  type WriteFenceTarget,
} from "../../capabilities/write-fence";
import { deriveBackend, type ExactBackendOverlay } from "../../derive-backend";
import {
  createSerializedExecutionQueue,
  runWithSerializedQueue,
  type SerializedExecutionQueue,
} from "../../serialized-execution-queue";
import { auditBackendResource } from "../../transaction-resource";
import type {
  AdapterBackend,
  GraphCommandPort,
  SchemaWriteTransactionBackend,
} from "../../types";
import { gateFulltextMethods } from "../contribution-materializations";
import { resolveEngineAssembly } from "./assembly";
import { finalizeEngineCapabilities } from "./capabilities";
import { applyEngineMarks } from "./marks";
import { createBaseSchemaMembers } from "./members/base-schema-members";
import { createContributionMembers } from "./members/contribution-members";
import { createGraphTemplateMembers } from "./members/graph-template-members";
import { createIdentityMembers } from "./members/identity-members";
import { createIndexMaterializationMembers } from "./members/index-materialization-members";
import { createKindRemovalMembers } from "./members/kind-removal-members";
import { createSchemaVersionMembers } from "./members/schema-version-members";
import type { EngineAssemblyContext, SqlEngineProfile } from "./profile";

/**
 * Every root member a `caller-serialized` write-fence declaration must
 * serialize through the in-process queue this factory builds for it: the
 * three WRITE classes of `src/backend/member-classes.ts` — graph-entity
 * writes, their sidecars, and backend-owned bulk ingestion
 * (`WRITE_MEMBER_KEYS`, the same set the write pipeline bans outside its
 * seam) — plus the two transaction openers, `transaction` and
 * `transactionWithNative`. Read from the taxonomy's own exported constant, so
 * a write member the taxonomy adds later is queued here automatically,
 * never from a second, hand-kept list this factory would have to remember to
 * update.
 */
const QUEUED_ROOT_MEMBER_KEYS = [
  ...WRITE_MEMBER_KEYS,
  "transaction",
  "transactionWithNative",
] as const;

/**
 * Runs `port.execute` through `queue`, keeping `session` untouched. `commands`
 * is the one {@link QUEUED_ROOT_MEMBER_KEYS} member that is a port object
 * rather than a bare function, so {@link buildQueuedWriteUnits} special-cases
 * it here instead of trying to wrap it the same way as every other member.
 */
function queueCommandPort(
  port: GraphCommandPort,
  queue: SerializedExecutionQueue,
): GraphCommandPort {
  return {
    session: port.session,
    execute: (command, context) =>
      runWithSerializedQueue(queue, () => port.execute(command, context)),
  };
}

/**
 * Builds the overlay {@link buildCallerSerializedBackend} decorates `backend`
 * with: every member {@link QUEUED_ROOT_MEMBER_KEYS} names, routed through
 * `queue`, plus `close`, which disposes `queue` after delegating to
 * `backend`'s own.
 *
 * Read with `Reflect.get` rather than static property access, so an OPTIONAL
 * write member this particular backend does not implement is simply absent
 * from the overlay instead of wrapping `undefined`. `deriveBackend` then
 * leaves every member this overlay does not name — every read, the
 * transaction-handle builders, `adoptTransaction` — resolving to `backend`'s
 * own, unqueued implementation; a transaction's own body reaches `backend`
 * directly too (`EngineAssemblyContext.self()`, resolved once in
 * `createSqlBackend` before this function ever runs), which is what lets
 * `transaction`'s internal delegation to `transactionWithNative` run without
 * re-entering this same queue.
 */
function buildQueuedWriteUnits<TTx>(
  backend: AdapterBackend<TTx>,
  queue: SerializedExecutionQueue,
): ExactBackendOverlay<AdapterBackend<TTx>, Partial<AdapterBackend<TTx>>> {
  const overlay: Partial<Record<keyof AdapterBackend<TTx>, unknown>> = {};
  for (const key of QUEUED_ROOT_MEMBER_KEYS) {
    const member: unknown = Reflect.get(backend, key);
    if (key === "commands") {
      overlay[key] = queueCommandPort(member as GraphCommandPort, queue);
      continue;
    }
    if (typeof member !== "function") continue;
    const original = member as (
      ...args: readonly unknown[]
    ) => Promise<unknown>;
    overlay[key] = (...args: readonly unknown[]) =>
      runWithSerializedQueue(queue, () => original(...args));
  }
  overlay.close = async () => {
    try {
      await backend.close();
    } finally {
      queue.dispose();
    }
  };
  // `overlay` was built entirely from `QUEUED_ROOT_MEMBER_KEYS` — a subset of
  // `keyof AdapterBackend<TTx>` derived from the write-member taxonomy plus
  // the two transaction openers — and every value either re-wraps that exact
  // member's own function (same signature, same return type) or narrows
  // `commands` to the identical `GraphCommandPort` shape. The cast states a
  // fact the loop above already establishes; it is not a widening.
  return overlay as unknown as ExactBackendOverlay<
    AdapterBackend<TTx>,
    Partial<AdapterBackend<TTx>>
  >;
}

/**
 * The in-process half of a `caller-serialized` write-fence promise: one
 * queue for the whole backend, and a decorated object whose root write units
 * — {@link QUEUED_ROOT_MEMBER_KEYS} — run through it one at a time. Called
 * only when `resolveWriteFencePlan` resolved `kind: "caller-serialized"` for
 * this backend.
 *
 * Exported (like `finalizeEngineCapabilities`, `resolveFenceStatements`, and
 * this module's other internals tests reach directly) so
 * `tests/caller-serialized-queue.test.ts` can apply the wrapping to a plain
 * backend by itself and compare the result against the exact pre-wrap
 * object, isolated from the closures `createSqlBackend` builds fresh on
 * every call — the proof `insertNode`, `commands`, etc. is the wrapped
 * function rather than "a function from a different construction" has no
 * other way to be meaningful.
 */
export function buildCallerSerializedBackend<TTx>(
  backend: AdapterBackend<TTx>,
): AdapterBackend<TTx> {
  const queue = createSerializedExecutionQueue();
  return deriveBackend(backend, buildQueuedWriteUnits(backend, queue));
}

/**
 * Assembles one `AdapterBackend` from a {@link SqlEngineProfile}.
 *
 * The write-fence-declaration refusal below is what makes the marking
 * `applyEngineMarks` (`./marks`) performs sound for a profile this factory
 * did not write itself, not only for the two bundled ones: a profile whose
 * resolved capabilities name no `writeFence` is refused outright, because
 * every mark and registration `applyEngineMarks` applies assumes a
 * resolvable write-fence decision, and `resolveWriteFencePlan`'s
 * dialect-derivation fallback is sound only for the two bundled dialects.
 * `applyEngineMarks`'s own doc comment covers its two further gates —
 * `markBundledRootAutocommitEligible` on the profile's `autocommit`
 * declaration, `markSchemaFencedInsertEligible` on the resolved fence plan.
 * A fourth gate, resolved once as `isFirstParty` below and threaded to both
 * `applyEngineMarks` and the fence target this factory builds, decides
 * `markFirstPartyFactory` itself: only the exact profile object
 * `isFirstPartyProfile` (`../../capabilities/write-fence`) recognizes earns
 * that mark, so the dialect-derivation fallback above and the lazy
 * schema-fence lease it feeds stay closed to a profile that merely resembles
 * a bundled one — a copy, spread, or otherwise derived profile is a
 * different object and is never recognized.
 */
export function createSqlBackend<TTx>(
  profile: SqlEngineProfile<TTx>,
): AdapterBackend<TTx> {
  const capabilities = finalizeEngineCapabilities(
    profile.declaredCapabilities,
    {
      execution: profile.execution,
      vectorStrategy: profile.vector,
      fulltextStrategy: profile.fulltext,
      fulltextTableName: profile.tableNames.fulltext,
    },
  );

  if (capabilities.writeFence === undefined) {
    throw new ConfigurationError(
      "This engine profile declares no usable write fence: " +
        "capabilities.writeFence is absent, so createSqlBackend cannot " +
        "resolve a write-fence decision for it and refuses to mark it as " +
        "fenced. Declare it on the capabilities the profile declares:\n\n" +
        `${writeFenceDeclarationLine(profile.dialect, "  ")}\n\n` +
        "(that is the correct declaration for this profile's dialect).",
      {
        code: "ENGINE_PROFILE_REQUIRES_WRITE_FENCE_DECLARATION",
        dialect: profile.dialect,
      },
      {
        suggestion:
          "Declare capabilities.writeFence on this profile's declaredCapabilities.",
      },
    );
  }

  // Resolved once and reused for both marks below: whether `profile` is the
  // exact object one of the two bundled builders returned, not merely an
  // object shaped like one. Only that object was ever registered, so this
  // is `false` for any profile assembled elsewhere — including one built
  // by copying a bundled profile's fields into a plain object literal.
  const isFirstParty = isFirstPartyProfile(profile);

  // ONE fence target for the whole backend and every transaction-scoped one
  // it builds, marked first-party only under the same gate as the backend
  // itself: `capabilities` here is the object this factory just finalized,
  // so a recognized-first-party caller who blanked `writeFence` out of a
  // profile's declaration still resolves the dialect-derived plan, not
  // `unfenced`, for the two bundled dialects — while a profile without a
  // recognized token never reaches that fallback.
  const fenceTargetBase: WriteFenceTarget = {
    dialect: profile.dialect,
    capabilities,
    ...(profile.fenceSql === undefined ? {} : { fenceSql: profile.fenceSql }),
  };
  const fenceTarget: WriteFenceTarget =
    isFirstParty ? markFirstPartyFactory(fenceTargetBase) : fenceTargetBase;

  const fencePlan = resolveWriteFencePlan(fenceTarget);

  // Resolved once and reused below for both the operation-backend build and
  // the late-member build — see `./assembly` for what this hides and why a
  // hand-built profile whose `assembly` is not one of the two bundled
  // builders' own values throws here instead of silently producing a
  // half-assembled backend.
  const { buildOperations, lateMembers } = resolveEngineAssembly(
    profile.assembly,
  );

  // The contribution materializer's destructive rebuild runs under the SAME
  // per-graph fence a schema commit does — `late.fence.runSchemaWriteTransaction`
  // — but `late` does not exist until `lateMembers(ctx)` runs, which in turn
  // needs the materializer this call is building (through
  // `ctx.contributionMaterializer`). This forward reference is how that
  // circularity resolves: the wrapper below only READS `late` once a caller
  // actually invokes a rebuild, long after `late` is assigned below: nothing
  // during construction calls it.
  const {
    contributionMaterializer,
    contributionTableExists,
    members: contributionMembers,
  } = createContributionMembers({
    ...profile.contributionRuntime,
    dialect: profile.dialect,
    fulltextStrategy: profile.fulltext,
    vectorStrategy: profile.vector,
    fenceTarget,
    ensureTable: profile.provisioning.ensureTable,
    execute: profile.execution.execute,
    operationStrategy: profile.strategy,
    // Withheld rather than wired-and-throwing when the driver cannot hold a
    // session: the rebuild must refuse with its own typed error naming the
    // absent fence, matching `capabilities.contributions.rebuild`.
    ...(capabilities.execution.interactiveTransactions ?
      {
        schemaWriteTransaction: <T>(
          graphId: string,
          fn: (tx: SchemaWriteTransactionBackend) => Promise<T>,
        ) =>
          late.fence.runSchemaWriteTransaction(graphId, (target) => fn(target)),
      }
    : {}),
  });

  const identityMembers = createIdentityMembers({
    ...profile.identityRuntime,
    ensureTable: profile.provisioning.ensureTable,
    contributionTableExists,
  });

  const operations = buildOperations({
    capabilities,
    fencePlan,
    fenceTarget,
    contributionMaterializer,
    isFirstParty,
  });

  const { ensureGraphTemplatesTable, members: graphTemplateMembers } =
    createGraphTemplateMembers({
      ...profile.graphTemplateRuntime,
      ensureTable: profile.provisioning.ensureTable,
      execute: operations.execute,
    });

  const baseSchemaMembers = createBaseSchemaMembers({
    ...profile.baseSchemaRuntime,
    ensureTable: profile.provisioning.ensureTable,
    executeDdl: profile.provisioning.executeDdl,
    generateDdl: profile.provisioning.generateDdl,
    ensureGraphTemplatesTable,
  });

  const indexMaterializationMembers = createIndexMaterializationMembers({
    ...profile.indexMaterializationRuntime,
    ensureTable: profile.provisioning.ensureTable,
    ...(profile.provisioning.ensureIndexMaterializationColumns === undefined ?
      {}
    : {
        ensureIndexMaterializationColumns:
          profile.provisioning.ensureIndexMaterializationColumns,
      }),
  });

  const kindRemovalMembers = createKindRemovalMembers({
    ...profile.kindRemovalRuntime,
    ensureTable: profile.provisioning.ensureTable,
  });

  const ctx: EngineAssemblyContext<TTx> = {
    capabilities,
    fencePlan,
    fenceTarget,
    operations,
    contributionMaterializer,
    // The same resolved flag `applyEngineMarks` gates the root's own
    // `markFirstPartyFactory` call on below — handed to `lateMembers` so a
    // dialect's transaction-opening surface gates its OWN mark on a
    // TypeGraph-opened handle the identical way, instead of marking every
    // handle unconditionally regardless of whether this profile earned it.
    isFirstParty,
    self: () => backend,
  };

  const late = lateMembers(ctx);

  // Annotated against the real `AdapterBackend<TTx>` declarations (`this:
  // void` included, and `commitSchemaVersionWithPreflight`'s
  // `SchemaCommitPreflightBackend` preflight parameter) rather than left to
  // infer `SchemaVersionMembers`. Once this group is spread into the
  // `backend` literal below, that inference can no longer catch a
  // divergence between `SchemaVersionMembers` and the four keys it fills —
  // this annotation is what still does. Every other group assembled here
  // gets the same treatment implicitly, through the literal's own
  // `satisfies AdapterBackend<TTx>` check below.
  const schemaVersionMembers: Required<
    Pick<
      AdapterBackend<TTx>,
      | "commitSchemaVersion"
      | "commitSchemaVersionIfKindsEmpty"
      | "commitSchemaVersionWithPreflight"
      | "setActiveVersion"
    >
  > = createSchemaVersionMembers({
    runSchemaWriteTransaction: late.fence.runSchemaWriteTransaction,
  });

  const backend = {
    ...operations,
    // Set explicitly rather than left to whatever `...operations` carried:
    // this is the ONE finalized value every mark and every late member
    // above resolved its decision from, and it must be what the returned
    // backend advertises even if a dialect's operation-backend layer closed
    // over a capabilities object of its own.
    capabilities,
    ...late.transactions,
    ...late.rawSql,
    lockSchemaVersionForWrite: requireDefined(
      operations.lockSchemaVersionForWrite,
    ),
    ...schemaVersionMembers,
    ...late.maintenance,
    ...(late.trustedImport === undefined ?
      {}
    : { trustedImport: late.trustedImport }),
    ...late.extensions,
    ...baseSchemaMembers,
    ...graphTemplateMembers,
    ...identityMembers,
    // Every fulltext-touching method asserts the durable marker instead of
    // lazily emitting DDL. Steady state performs zero ensure; an
    // uninitialized database throws `StoreNotInitializedError` rather
    // than self-healing (#135). Shared verbatim with the tx-scoped gate
    // via `gateFulltextMethods`.
    ...gateFulltextMethods(
      operations,
      contributionMaterializer.assertInitialized,
      contributionMaterializer.refuseUnavailableFulltext,
    ),
    ...indexMaterializationMembers,
    ...contributionMembers,
    ...kindRemovalMembers,
    ...(profile.provisioning.catalog === undefined ?
      {}
    : { catalog: profile.provisioning.catalog }),
    close: profile.close,
  } satisfies AdapterBackend<TTx>;

  // INVARIANT: audit before any wrapper can observe this backend — see
  // transaction-resource.ts. Unconditional: an abstention recorded as
  // "independent" is a verdict the guards can tell apart from a backend
  // nobody looked at.
  auditBackendResource(backend, profile.resourceAudit);

  // A `caller-serialized` write-fence declaration promises that this
  // backend's own process serializes every write unit it issues;
  // `buildCallerSerializedBackend` is the in-process half of that promise.
  // Built AFTER the audit above (so `deriveBackend`'s own carry, not a
  // second write, is what gives the decorated object `backend`'s
  // resource-audit verdict) and BEFORE `applyEngineMarks` below: two of that
  // call's marks — `markBundledRootAutocommitEligible` and the atomic-program
  // registrations — key a `WeakSet`/`WeakMap` by the exact object passed to
  // it and are NOT among the marks `deriveBackend` carries forward on its
  // own (only the first-party-factory mark, the schema-fenced-insert mark,
  // and the resource audit are). Applying the marks to whichever object this
  // function actually returns, instead of always to the pre-queue `backend`
  // nothing outside this function can still reach, is what keeps every mark
  // and registration attached to the backend a caller actually holds.
  const queuedBackend: AdapterBackend<TTx> =
    fencePlan.kind === "caller-serialized" ?
      buildCallerSerializedBackend(backend)
    : backend;

  // Read off `queuedBackend`, not the `capabilities` local above: a root
  // atomic SQL/mutation program dispatches its whole multi-statement batch
  // directly against the connection, bypassing every member
  // `QUEUED_ROOT_MEMBER_KEYS` wraps — registering root atomic authority on
  // the queued object would let that raw dispatch run outside the very
  // queue a `caller-serialized` declaration promises every write goes
  // through. `deriveBackend` already refuses to carry root (or un-preserved
  // session) atomic-batch authority across ANY decoration — by construction,
  // never selectively — so `queuedBackend.capabilities.execution.atomicBatch`
  // already reads the correct, downgraded value for the object this factory
  // is about to return; the plain pass-through case (`queuedBackend ===
  // backend`) reads the identical object `capabilities` names, so this
  // changes nothing for either bundled backend.
  const queuedCapabilities = queuedBackend.capabilities;

  applyEngineMarks(queuedBackend, {
    isFirstParty,
    capabilities: queuedCapabilities,
    fencePlan,
    autocommit: profile.autocommit,
    execution: profile.execution,
    atomicMutationPrograms: {
      createNodes: operations.executeAtomicNodeBatch,
      replaceNodes: operations.executeAtomicNodeReplacementBatch,
      createEdges: operations.executeAtomicEdgeBatch,
      deleteNodes: operations.executeAtomicNodeDeleteBatch,
      deleteEdges: operations.executeAtomicEdgeDeleteBatch,
      updateNodes: operations.executeAtomicNodeResolvedUpdateBatch,
      updateEdges: operations.executeAtomicEdgeResolvedUpdateBatch,
      mutateNodes: operations.executeAtomicNodeResolvedMutationSet,
      mutateEdges: operations.executeAtomicEdgeMutationProgram,
    },
  });

  return queuedBackend;
}
