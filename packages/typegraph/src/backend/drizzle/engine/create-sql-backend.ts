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
import { registerSerializationFailureClassifier } from "../../../utils/sql-errors";
import {
  isFirstPartyProfile,
  markFirstPartyFactory,
  resolveWriteFencePlan,
  writeFenceDeclarationLine,
  type WriteFenceTarget,
} from "../../capabilities/write-fence";
import { deriveBackend, type ExactBackendOverlay } from "../../derive-backend";
import { GRAPH_BACKEND_MEMBER_CLASSES } from "../../member-classes";
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
  TransactionBackend,
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
 * `provisioning`-class members excluded from the caller-serialized queue
 * because they derive text synchronously without ever executing SQL:
 * `identityTableDdl` / `recordedTableDdl` return a DDL string array/record
 * built from table names alone, with no `Promise` in their real signature.
 * Queuing either through {@link buildQueuedWriteUnits}'s generic
 * "re-wrap as `(...) => runWithSerializedQueue(...)`" path would silently
 * turn its synchronous return value into a `Promise`, breaking every
 * caller that reads the result without awaiting — a change in kind, not
 * degree, for a member that touches no connection at all.
 */
const PROVISIONING_DERIVATION_MEMBER_KEYS = [
  "identityTableDdl",
  "recordedTableDdl",
] as const;

/**
 * `provisioning`-class members excluded because none is itself a callable
 * write: `catalog` is a bag of read-only introspection probes
 * (`BackendCatalogProbes`), `lineage` is a bag of read-only revision/delta
 * probes (`LineageMembers`), and `recordedTime` is a bag of a read-only
 * source function and a revision-clock read (`EngineRecordedTimeMembers`) —
 * none a function itself. `buildQueuedWriteUnits` already skips any
 * non-function member it reads, so an included `catalog`, `lineage`, or
 * `recordedTime` would be silently dropped regardless — all three are named
 * here so the totality ratchet in `tests/caller-serialized-queue.test.ts`
 * sees a documented exclusion instead of an accidental one.
 */
const PROVISIONING_PROBE_MEMBER_KEYS = [
  "catalog",
  "lineage",
  "recordedTime",
] as const;

/**
 * `rawSql`-class member excluded for the same reason as the two provisioning
 * derivations above: `compileSql` turns a `SqlFragment` into
 * `{ sql, params }` synchronously and never touches a connection. The other
 * four raw-SQL members — `execute`, `executeRaw`, `executeStatement`,
 * `executeTemporaryStatement` — all dispatch through the execution
 * adapter's `execRun`/`execGet` against the live connection and CAN carry a
 * write, so they stay queued even though the member classification does not
 * call any of the five a "write".
 */
const RAW_SQL_DERIVATION_MEMBER_KEYS = ["compileSql"] as const;

/**
 * The `lifecycle`-class member excluded from the generic per-member wrap:
 * `"close"` is handled by {@link buildQueuedWriteUnits}'s own disposal
 * wrapper below (it must run, and dispose the queue, even with queued work
 * outstanding), never by routing through the queue itself. The class's other
 * two members flow through unexcluded: `"transaction"` is queued like any
 * other lifecycle member (it is also, descriptively, one of the two
 * transaction openers this factory relies on — see
 * {@link QUEUED_ROOT_MEMBER_KEYS}'s own doc comment), and `"clearGraph"` —
 * the class's one genuine destructive write — is queued the same way.
 */
const LIFECYCLE_EXCLUDED_MEMBER_KEYS = ["close"] as const;

/**
 * The one `AdapterBackend`-only member that opens a TypeGraph-managed
 * transaction — not part of `keyof GraphBackend`, so `member-classes.ts`'s
 * taxonomy does not (and structurally cannot) name it; `transaction`, the
 * other opener, reaches {@link QUEUED_ROOT_MEMBER_KEYS} through the
 * `lifecycle` class instead, and a schema-write transaction opener
 * (`schemaWriteTransaction`) reaches it through the `schema` class.
 * `adoptTransaction`, the third `AdapterBackend`-only member, is
 * deliberately ABSENT from every list here: it is refused outright under
 * `caller-serialized` rather than queued — see
 * {@link buildQueuedWriteUnits}'s own `adoptTransaction` override.
 */
const TRANSACTION_OPENER_MEMBER_KEYS = ["transactionWithNative"] as const;

/**
 * Every root member a `caller-serialized` write-fence declaration must
 * serialize through the in-process queue this factory builds for it: every
 * member `src/backend/member-classes.ts` classifies in a mutation-capable
 * class — graph-entity writes, their sidecars, backend-owned bulk
 * ingestion, derived-data maintenance, schema commits (including the
 * `schema`-class transaction opener, `schemaWriteTransaction`), DDL and
 * table provisioning, the raw-SQL members that actually execute something,
 * and the lifecycle class's one destructive write (`clearGraph`) — plus
 * `transactionWithNative`, the one `AdapterBackend`-only transaction opener.
 *
 * Read from the taxonomy's own exported classes (`GRAPH_BACKEND_MEMBER_CLASSES`),
 * so a write member a class adds later is queued here automatically, never
 * from a second, hand-kept list this factory would have to remember to
 * update; only the five documented exceptions above (two pure derivations,
 * two probe bags, one raw-SQL compiler) are named individually, each with its
 * own reason, and `tests/caller-serialized-queue.test.ts` pins that this list
 * plus those five exceptions is exactly `keyof AdapterBackend` (minus
 * `adoptTransaction`, refused rather than queued or excluded).
 *
 * Why per-member queueing (rather than, say, one lock spanning every call) is
 * enough: every multi-call write workflow either runs entirely inside one
 * already-queued opener call (`transaction`, `transactionWithNative`,
 * `schemaWriteTransaction`) or relies on its own CAS/claim protocol whose
 * claim writes are themselves individually-queued members of this same set —
 * there is no third shape of multi-statement write this queue would need to
 * span.
 */
export const QUEUED_ROOT_MEMBER_KEYS = [
  ...WRITE_MEMBER_KEYS,
  ...GRAPH_BACKEND_MEMBER_CLASSES.maintenance,
  ...GRAPH_BACKEND_MEMBER_CLASSES.schema,
  ...GRAPH_BACKEND_MEMBER_CLASSES.provisioning,
  ...GRAPH_BACKEND_MEMBER_CLASSES.rawSql,
  ...GRAPH_BACKEND_MEMBER_CLASSES.lifecycle,
  ...TRANSACTION_OPENER_MEMBER_KEYS,
].filter(
  (key) =>
    !(
      [
        ...PROVISIONING_DERIVATION_MEMBER_KEYS,
        ...PROVISIONING_PROBE_MEMBER_KEYS,
        ...RAW_SQL_DERIVATION_MEMBER_KEYS,
        ...LIFECYCLE_EXCLUDED_MEMBER_KEYS,
      ] as readonly string[]
    ).includes(key),
);

/**
 * Every `keyof AdapterBackend` member intentionally left OUT of
 * {@link QUEUED_ROOT_MEMBER_KEYS}, each with the one-line reason it stays
 * unqueued: every `read` and `identity` member (never writes / a static
 * description property, not an operation), the two provisioning derivations,
 * the two provisioning probe bags, the one raw-SQL compiler, `close`
 * (this file's own disposal wrapper), and `adoptTransaction` (refused
 * outright rather than queued or silently left alone).
 *
 * `tests/caller-serialized-queue.test.ts`'s totality ratchet partitions the
 * FULL taxonomy plus the two `AdapterBackend`-only members into this
 * record's keys and {@link QUEUED_ROOT_MEMBER_KEYS}, asserting the two sets
 * are disjoint and their union is everything `keyof AdapterBackend` names —
 * so a member a future class reclassifies, or a brand-new member nobody
 * classifies at all, cannot land unqueued silently: it either appears here
 * with a reason, in `QUEUED_ROOT_MEMBER_KEYS`, or fails the ratchet.
 */
export const UNQUEUED_ROOT_MEMBER_REASONS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    GRAPH_BACKEND_MEMBER_CLASSES.read.map(
      (key) => [key, "read: never writes"] as const,
    ),
  ),
  ...Object.fromEntries(
    GRAPH_BACKEND_MEMBER_CLASSES.identity.map(
      (key) =>
        [
          key,
          "identity: a static description property, not a callable operation",
        ] as const,
    ),
  ),
  ...Object.fromEntries(
    PROVISIONING_DERIVATION_MEMBER_KEYS.map(
      (key) =>
        [
          key,
          "provisioning derivation: returns DDL text synchronously without executing it",
        ] as const,
    ),
  ),
  ...Object.fromEntries(
    PROVISIONING_PROBE_MEMBER_KEYS.map(
      (key) =>
        [
          key,
          "provisioning probe: a bag of read-only introspection functions, not itself callable",
        ] as const,
    ),
  ),
  ...Object.fromEntries(
    RAW_SQL_DERIVATION_MEMBER_KEYS.map(
      (key) =>
        [
          key,
          "rawSql derivation: compiles SQL text synchronously without executing it",
        ] as const,
    ),
  ),
  close:
    "lifecycle: handled by this file's own disposal wrapper, which must run (and dispose the queue) even with queued work outstanding",
  adoptTransaction:
    "refused outright under caller-serialized (CALLER_SERIALIZED_REFUSES_ADOPTION) rather than queued or left silently unqueued",
};

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
 * THE refusal `adoptTransaction` becomes on a `caller-serialized` backend:
 * an externally-owned transaction's lifetime is the CALLER's, not something
 * this factory's write-unit queue can hold a slot open for — the caller, not
 * TypeGraph, decides when it commits, so queuing it would either block every
 * other queued write until that external transaction ends (defeating the
 * point of adopting one mid-flight) or — if left unqueued, as it always was
 * before this fence declaration existed — let its writes interleave with the
 * queue's own, silently breaking the very promise `caller-serialized`
 * makes. Refusing outright is the only honest option.
 */
function refuseCallerSerializedAdoption<TTx>(
  // The real signature's one parameter, accepted (and ignored) so this
  // matches `AdapterBackend<TTx>["adoptTransaction"]` exactly rather than a
  // zero-arity stand-in the cast below would otherwise have to paper over.
  _externalTransaction: TTx,
): TransactionBackend {
  throw new ConfigurationError(
    "adoptTransaction is unavailable on a caller-serialized backend: an " +
      "externally owned transaction's lifetime cannot be held by the " +
      "backend's write-unit queue, so store.withTransaction(externalTx) is " +
      "refused rather than silently allowed to interleave with queued " +
      "root writes.",
    {
      code: "CALLER_SERIALIZED_REFUSES_ADOPTION",
      member: "adoptTransaction" satisfies keyof AdapterBackend<TTx>,
    },
    {
      suggestion:
        "Open the transaction through this backend's own transaction()/" +
        "transactionWithNative() instead of adopting an externally opened " +
        "one, or drop the caller-serialized write-fence declaration if " +
        "cross-store adoption is required.",
    },
  );
}

/**
 * Builds the overlay {@link buildCallerSerializedBackend} decorates `backend`
 * with: every member {@link QUEUED_ROOT_MEMBER_KEYS} names, routed through
 * `queue`; `close`, which disposes `queue` after delegating to `backend`'s
 * own; and `adoptTransaction`, replaced outright with
 * {@link refuseCallerSerializedAdoption} rather than queued or left
 * unqueued.
 *
 * Read with `Reflect.get` rather than static property access, so an OPTIONAL
 * write member this particular backend does not implement is simply absent
 * from the overlay instead of wrapping `undefined`. `deriveBackend` then
 * leaves every member this overlay does not name — every read, and the
 * transaction-handle builders — resolving to `backend`'s own, unqueued
 * implementation; a transaction's own body reaches `backend` directly too
 * (`EngineAssemblyContext.self()`, resolved once in `createSqlBackend`
 * before this function ever runs), which is what lets `transaction`'s
 * internal delegation to `transactionWithNative` run without re-entering
 * this same queue.
 */
function buildQueuedWriteUnits<TTx>(
  backend: AdapterBackend<TTx>,
  queue: SerializedExecutionQueue,
): ExactBackendOverlay<AdapterBackend<TTx>, Partial<AdapterBackend<TTx>>> {
  const queuedEntries = QUEUED_ROOT_MEMBER_KEYS.flatMap(
    (key): readonly (readonly [keyof AdapterBackend<TTx>, unknown])[] => {
      const member: unknown = Reflect.get(backend, key);
      if (key === "commands") {
        return [[key, queueCommandPort(member as GraphCommandPort, queue)]];
      }
      if (typeof member !== "function") return [];
      const original = member as (
        ...args: readonly unknown[]
      ) => Promise<unknown>;
      return [
        [
          key,
          (...args: readonly unknown[]) =>
            runWithSerializedQueue(queue, () => original(...args)),
        ],
      ];
    },
  );
  const close = async (): Promise<void> => {
    try {
      await backend.close();
    } finally {
      queue.dispose();
    }
  };
  const overlay: Partial<Record<keyof AdapterBackend<TTx>, unknown>> =
    Object.fromEntries([
      ...queuedEntries,
      ["close", close],
      [
        "adoptTransaction",
        (externalTransaction: TTx) =>
          refuseCallerSerializedAdoption<TTx>(externalTransaction),
      ],
    ]);
  // `overlay` was built entirely from `QUEUED_ROOT_MEMBER_KEYS` — a subset of
  // `keyof AdapterBackend<TTx>` derived from the member-classification's
  // mutation-capable classes plus the transaction openers — and every value
  // either re-wraps that exact member's own function (same signature, same
  // return type), narrows `commands` to the identical `GraphCommandPort`
  // shape, or (for `close`/`adoptTransaction`) implements the exact member
  // signature `AdapterBackend<TTx>` declares. The cast states a fact the
  // loop above and the two named entries already establish; it is not a
  // widening.
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
  const queue = createSerializedExecutionQueue({
    // "require": a caller-serialized declaration's in-process promise
    // depends on this queue's reentrancy detection actually working — an
    // undetected nested root write would deadlock a transaction rather than
    // refuse loudly, silently breaking the promise instead of degrading it.
    reentrancy: "require",
    subject: "caller-serialized",
  });
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
  if (profile.declaredCapabilities.writeFence === undefined) {
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

  // Engine-native recorded time keeps no recorded relations of its own: a
  // graph-merge diff against such a store has nothing to derive a change
  // delta from except the engine's own `lineage`. Refusing the lopsided
  // declaration here, at construction, is cheaper than letting it surface
  // later as an unexplained full-comparison fallback on every merge.
  if (
    profile.provisioning.recordedTime !== undefined &&
    profile.provisioning.lineage === undefined
  ) {
    throw new ConfigurationError(
      "This engine profile declares `recordedTime` without also declaring " +
        "`lineage`: engine-native recorded time keeps no recorded relations " +
        "of its own, so graph-merge has no other source for this backend's " +
        "change delta. Declare both EngineProvisioning.recordedTime and " +
        "EngineProvisioning.lineage on this profile.",
      {
        code: "ENGINE_PROFILE_RECORDED_TIME_REQUIRES_LINEAGE",
        dialect: profile.dialect,
      },
      {
        suggestion:
          "Declare EngineProvisioning.lineage alongside EngineProvisioning.recordedTime on this profile.",
      },
    );
  }

  // Resolved once and reused for every mark below: whether `profile` is the
  // exact object one of the two bundled builders returned, not merely an
  // object shaped like one. Only that object was ever registered, so this
  // is `false` for any profile assembled elsewhere — including one built
  // by copying a bundled profile's fields into a plain object literal.
  const isFirstParty = isFirstPartyProfile(profile);

  // The write-fence plan is resolved from the profile's DECLARED
  // capabilities, before the capability tail below runs: the tail needs
  // this plan's `conflict` fact (when its mechanism is `row`) to derive
  // `execution.unitOfWork`'s `"optimistic-retry"` arm, and
  // `resolveWriteFencePlan` reads only `capabilities.writeFence`, a field
  // the tail never touches — the declared and the eventual finalized
  // capabilities agree on it byte for byte, checked non-`undefined` above.
  // This is the ONE call to `resolveWriteFencePlan` for the whole backend;
  // `fencePlan` is threaded, never re-resolved, into both the tail below
  // and the fence target every other member group shares.
  const declarationFenceTarget: WriteFenceTarget = {
    dialect: profile.dialect,
    capabilities: profile.declaredCapabilities,
    ...(profile.fenceSql === undefined ? {} : { fenceSql: profile.fenceSql }),
    tableNames: profile.tableNames,
  };
  if (isFirstParty) markFirstPartyFactory(declarationFenceTarget);
  const fencePlan = resolveWriteFencePlan(declarationFenceTarget);

  const capabilities = finalizeEngineCapabilities(
    profile.declaredCapabilities,
    {
      execution: profile.execution,
      vectorStrategy: profile.vector,
      fulltextStrategy: profile.fulltext,
      fulltextTableName: profile.tableNames.fulltext,
      writeFenceConflict:
        fencePlan.kind === "row" ? fencePlan.conflict : undefined,
    },
  );

  // ONE fence target for the whole backend and every transaction-scoped one
  // it builds, marked first-party only under the same gate as the backend
  // itself: a recognized-first-party caller who blanked `writeFence` out of
  // a profile's declaration still resolves the dialect-derived plan, not
  // `unfenced`, for the two bundled dialects — while a profile without a
  // recognized token never reaches that fallback. Carries the FINALIZED
  // `capabilities` (unlike `declarationFenceTarget` above), so a consumer
  // that reads `fenceTarget.capabilities.execution.unitOfWork` — the
  // contribution materializer's optimistic-retry gate, which has no other
  // backend reference to read it from — sees the real, derived tier.
  const fenceTargetBase: WriteFenceTarget = {
    dialect: profile.dialect,
    capabilities,
    ...(profile.fenceSql === undefined ? {} : { fenceSql: profile.fenceSql }),
    // Read only by a resolved `row` mechanism (`resolveFenceStatements`'s
    // fences-relation derivation, off `tableNames.fences`); every profile's
    // `tableNames` resolves `fences` with a default, so this is always the
    // physical name TypeGraph spells its acquire statement against, bundled
    // or custom alike — the SAME `tableNames` the returned backend exposes.
    tableNames: profile.tableNames,
  };
  const fenceTarget: WriteFenceTarget =
    isFirstParty ? markFirstPartyFactory(fenceTargetBase) : fenceTargetBase;

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
      fencePlan,
      fenceTarget,
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
    ...(profile.provisioning.lineage === undefined ?
      {}
    : { lineage: profile.provisioning.lineage }),
    ...(profile.provisioning.recordedTime === undefined ?
      {}
    : { recordedTime: profile.provisioning.recordedTime }),
    close: profile.close,
  } satisfies AdapterBackend<TTx>;

  // INVARIANT: audit before any wrapper can observe this backend — see
  // transaction-resource.ts. Unconditional: an abstention recorded as
  // "independent" is a verdict the guards can tell apart from a backend
  // nobody looked at.
  auditBackendResource(backend, profile.resourceAudit);

  // Registered on the pre-queue `backend`, before `buildCallerSerializedBackend`
  // (and every later transaction-scoped `deriveBackend`/`projectBackend` call)
  // can carry it forward: a profile whose execution adapter declares its own
  // `serializationFailure` classifier — for an engine whose commit-conflict
  // shape is not PostgreSQL's `40001`/`40P01` — gives every derived handle of
  // this backend the SAME classifier `isSerializationFailure` consults, never
  // a copy resolved independently per handle.
  //
  // Also registered on `fenceTarget`: that object is never itself passed
  // through `deriveBackend`/`projectBackend` (it is built once, above, and
  // held by reference for the life of this backend), so it would otherwise
  // never pick up the carried registration. `rebuildContribution`
  // (`contribution-materializations.ts`) has no other backend reference to
  // classify against, and `fenceTarget` is exactly the object it holds.
  if (profile.execution.serializationFailure !== undefined) {
    registerSerializationFailureClassifier(
      backend,
      profile.execution.serializationFailure,
    );
    registerSerializationFailureClassifier(
      fenceTarget,
      profile.execution.serializationFailure,
    );
  }

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
