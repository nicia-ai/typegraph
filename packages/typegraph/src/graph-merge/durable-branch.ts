/**
 * Durable working-copy branches: a JSON-serializable descriptor for a
 * PERSISTENT working copy plus reopen / destroy operations over it.
 *
 * `branch()` produces an {@link GraphBranch} whose store/close handle lives
 * only in the process that minted it. A durable branch instead pairs the normal
 * {@link GraphBranch} with a {@link DurableBranchDescriptor} — a plain JSON
 * document the caller can store anywhere — so a LATER process can reconnect to
 * the SAME mutated working copy without cloning the base and without keeping an
 * in-memory map of open handles.
 *
 * The descriptor has two halves:
 *
 *   - TypeGraph-owned fences: `kind`/`version`, the owning `graphId`, the
 *     branch id, the `base@V` token the working copy forked from, the at-fork
 *     schema anchor (explicitly absent for an unmanaged store), the at-fork
 *     engine revision when the working copy resolved `lineage`, and the
 *     source recorded-time cut when history was captured.
 *   - An opaque, strategy-defined `store` locator. TypeGraph never interprets
 *     it and never assumes a database URL, product, or dialect.
 *
 * TAMPER MODEL: the descriptor is a document the caller stores and later hands
 * back, so every TypeGraph-owned fence in it is UNTRUSTED. The durable host is
 * the authority: at seal time it persists the {@link DurableBranchOrigin} that
 * TypeGraph captured at the fork, and at reopen it ATTESTS the complete origin
 * it holds. Reopen refuses unless every descriptor fence equals the attested
 * origin — a tampered `graphId`/`definitionHash`/`base`/`branchId`/
 * `forkRevision`/`schemaAnchor`/`recordedForkPoint`, including DELETING
 * `schemaAnchor` from the
 * envelope, cannot relabel a fork, because the host's own record is the
 * reference. `destroy` is verified the same way before it deletes (see
 * {@link DurableWorkingCopyStrategy.destroy}), so swapping one working copy's
 * locator for another's cannot destroy the wrong allocation.
 *
 * DEFINITION IDENTITY is part of that origin and is INDEPENDENT of the optional
 * committed `schemaAnchor`: the host attests the `graphId` AND a version-blind
 * {@link getGraphDefinitionHash} of the caller's fork-time definition. An
 * unmanaged working copy (one that committed no schema row, so its
 * `schemaAnchor` is absent) therefore still refuses descriptor `graphId`
 * relabeling, reopening with a different `graphId`, and — the case a missing
 * anchor used to let through — a SAME-ID graph whose definition hashes
 * differently. Definition identity is the fork-time caller definition; the
 * branch's CURRENT committed schema may legitimately evolve after forking, so
 * reopen never compares the live schema row to the fork-time identity.
 *
 * The host lifecycle is split deliberately. `GraphBranch.close()` releases the
 * process's CONNECTION to the working copy — it must never delete it. Explicit
 * teardown is a separate strategy operation, {@link DurableWorkingCopyStrategy.destroy},
 * surfaced through {@link destroyDurableBranch}. This keeps the ephemeral
 * {@link ForkHandle.dispose}-deletes-the-fork contract out of the durable path,
 * where "the process closed its connection" and "the working copy is gone" are
 * different events.
 *
 * The at-fork schema anchor is IMMUTABLE FORK METADATA, never a statement about
 * the working copy's CURRENT schema: a branch may legitimately evolve its
 * committed schema after forking, and reopen must still succeed. Reopen therefore
 * never compares the live schema row to the anchor; it compares the descriptor's
 * anchor to the host's, and the caller's graph definition to the attested
 * definition hash. The merge path separately refuses a branch whose LIVE schema
 * moved (see `merge.ts`'s at-fork drift guard); reopen is not that gate.
 *
 * Backend-specific mechanics remain entirely within the strategy.
 */

import { asRecordedInstant } from "../core/temporal";
import { computeBaseVersion, schemaComponentOf } from "./base-version";
import { readBranchForkState } from "./branch";
import type { DurableOperationCapability } from "./durable-operation";
import {
  BranchError,
  describeCause,
  DurableEvidenceUndeliveredError,
} from "./errors";
import type { MergePlanArtifactV1 } from "./plan-schema";
import type { Result } from "./result";
import { err, ok } from "./result";
import { diffAgainstBase } from "./state-diff";
import type {
  EngineRevision,
  GraphDef,
  JsonValue,
  Store,
} from "./typegraph-internal";
import { generateId, getGraphDefinitionHash } from "./typegraph-internal";
import type {
  BaseVersion,
  BranchId,
  BranchOptions,
  GraphBranch,
  MergedCounts,
  RecordedForkPoint,
} from "./types";
import { asBranchId } from "./types";
import { coalescedWorkingCopyClose } from "./working-copy";

/**
 * A strategy-defined, JSON-serializable locator for one PERSISTENT working
 * copy. TypeGraph treats it as opaque data: it is carried inside a
 * {@link DurableBranchDescriptor} and handed back to the strategy on reopen and
 * destroy, never inspected. It must survive `JSON.parse(JSON.stringify(...))`
 * unchanged. It MUST be a non-secret identifier: TypeGraph returns it to the
 * caller. Connection strings, credentials, bearer tokens, and other secrets do
 * not belong here; keep those in strategy-owned configuration and resolve this
 * locator there. TypeGraph deliberately omits it from cleanup error details.
 */
export type DurableStoreDescriptor = JsonValue;

/**
 * The write-access guarantee a strategy acquired for one opened working copy.
 *
 * `engine-fenced` means the database provides sound cross-client isolation and
 * change fencing for the full Store planning/apply access pattern, across every
 * connection and process that could mutate the working copy.
 * `exclusive` means the host acquired an allocation-wide writer lease before
 * returning. That lease MUST exclude every other process and backend instance,
 * not merely serialize calls through one in-memory queue. TypeGraph releases it
 * after the Store backend closes; a failed release is retried by the next
 * `GraphBranch.close()` call.
 *
 * A backend that provides only `caller-serialized` access MUST use `exclusive`:
 * each backend instance owns a different in-process queue, so that declaration
 * alone does not serialize two durable reopen handles or two processes.
 */
export type DurableWorkingCopyAccess =
  | Readonly<{ kind: "engine-fenced" }>
  | Readonly<{
      kind: "exclusive";
      leaseId: string;
      release: () => Promise<void>;
    }>;

/** Why an authoritative native merge attempt could not safely run. */
export type NativeDurableMergeUnsupportedDimension =
  | "branchOrigin"
  | "graphScope"
  | "nativeConflicts"
  | "planSemantics"
  | "targetFence";

/**
 * Result of a host-native merge optimization attempt.
 *
 * `unsupported` proves that NO native merge SQL or host mutation ran; TypeGraph
 * then executes the complete portable plan application. `applied` proves the
 * strategy atomically validated every dimension named by
 * {@link DurableWorkingCopyStrategy.merge} and applied exactly the approved
 * plan. A refusal or uncertain/partial execution throws instead of returning
 * `unsupported`, because falling back after a possible native write would
 * double-apply the plan.
 */
export type NativeDurableMergeResult =
  | Readonly<{
      outcome: "applied";
      merged: MergedCounts;
      warnings?: readonly string[] | undefined;
    }>
  | Readonly<{
      outcome: "unsupported";
      dimensions: readonly [
        NativeDurableMergeUnsupportedDimension,
        ...NativeDurableMergeUnsupportedDimension[],
      ];
    }>;

/**
 * The complete immutable TypeGraph origin of one durable working copy — every
 * TypeGraph-owned fork fence, with NO dependence on the descriptor: the graph
 * id and version-blind graph-definition hash identifying the fork-time caller
 * definition, the branch id, the `base@V` token it forked from, the at-fork
 * schema anchor (`undefined` meaning the working copy committed no schema row —
 * an EXPLICIT absent, so a descriptor that simply omits the field still
 * disagrees with a host that persisted one), and the at-fork engine revision
 * (`undefined` when the working copy resolved no lineage), plus the source
 * recorded-time cut when history was captured.
 *
 * `graphId` and `definitionHash` are REQUIRED and carry the definition identity
 * even when `schemaAnchor` is absent: an unmanaged working copy still has to
 * reject relabeling and same-id divergent definitions. The host persists this
 * at seal time and attests it at reopen/destroy; it is the reference every
 * descriptor fence is compared against.
 */
export type DurableBranchOrigin = Readonly<{
  graphId: string;
  definitionHash: string;
  branchId: BranchId;
  base: BaseVersion;
  schemaAnchor: Readonly<{ version: number; hash: string }> | undefined;
  forkRevision: EngineRevision | undefined;
  recordedForkPoint?: RecordedForkPoint;
}>;

/**
 * The durable envelope for a branch: the TypeGraph-owned fences a reopen
 * re-validates plus the strategy's opaque store locator.
 *
 * `kind`/`version` identify the strategy's descriptor FORMAT. `graphId` and
 * `definitionHash` bind the descriptor to one fork-time graph definition, and
 * `branchId` to one working copy. `base`, `schemaAnchor` and `forkRevision` are
 * the same at-fork fences a live {@link GraphBranch} carries, captured when the
 * branch was created.
 *
 * The fences are untrusted on reopen — see the module doc's tamper model.
 * `schemaAnchor` is PRESENT with value `undefined` when the working copy
 * committed no schema row (an unmanaged store), mirroring `branch()`'s own
 * representation; JSON storage drops the key, and the host's own attestation
 * restores the distinction on reopen.
 */
export type DurableBranchDescriptor<
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
> = Readonly<{
  /** Stable strategy type tag; must equal the reopening strategy's `type`. */
  kind: string;
  /** Strategy descriptor format version; must equal the strategy's `version`. */
  version: number;
  /** The graph id the working copy belongs to. */
  graphId: string;
  /**
   * The version-blind graph-definition hash of the caller's fork-time
   * definition. Attested by the host, so it fences a same-id divergent
   * definition even for an unmanaged working copy with no `schemaAnchor`.
   */
  definitionHash: string;
  /** The TypeGraph branch id the working copy is identified by. */
  branchId: BranchId;
  /** The immutable `base@V` token the working copy forked from. */
  base: BaseVersion;
  /** The strategy's opaque, JSON-serializable locator for the working copy. */
  store: TStoreDescriptor;
  /** The at-fork committed schema `(version, hash)`; `undefined` when unmanaged. */
  schemaAnchor?: Readonly<{ version: number; hash: string }> | undefined;
  /** The at-fork engine revision, when the working copy resolves `lineage`. */
  forkRevision?: EngineRevision | undefined;
  /** Source recorded-time cut, when the source captured history at fork time. */
  recordedForkPoint?: RecordedForkPoint;
}>;

/**
 * The host-owned half of a durable working copy: how a persistent working copy
 * is allocated, sealed, reconnected to, and explicitly destroyed.
 *
 * The create -> seal/abort protocol has explicit ownership:
 *
 *   1. `create` allocates the persistent working copy and returns a mutable
 *      {@link Store} over it plus the opaque locator. Once `create` resolves,
 *      TypeGraph owns the allocation and the returned store.
 *   2. TypeGraph captures the fork state off the store and calls `seal` with
 *      the complete {@link DurableBranchOrigin}. The host MUST persist that
 *      origin durably before `seal` resolves — it is what later attestations
 *      compare a descriptor against.
 *   3. If capturing OR sealing fails, TypeGraph calls `abort`: the host releases
 *      the just-created allocation (deleting it) so no orphan survives. `abort`
 *      is only ever called on an allocation this same `create` produced, so it
 *      need not verify identity; it MUST tolerate a partially-sealed allocation.
 *      An `abort` failure does NOT mask the original capture/seal failure:
 *      TypeGraph returns a {@link BranchError} preserving that original failure
 *      as its `cause` and reports `details.allocationAborted: false`. The opaque
 *      locator and raw cleanup error are deliberately NOT copied into error
 *      details, where application logging could disclose host credentials or
 *      other strategy-private data. Operator tooling can use the safe TypeGraph
 *      branch id supplied to `create` to identify the orphan.
 *
 * `reopen` reconnects to an EXISTING working copy identified by `descriptor`
 * without cloning, and returns the complete origin the host PERSISTED for that
 * locator. TypeGraph refuses when any descriptor fence disagrees with that
 * attested origin. A reopen failure (missing or deleted store, unreachable
 * host) throws; the strategy must not leave an opened backend behind when it
 * throws.
 *
 * `destroy` is the ONLY operation that may delete or archive the persistent
 * working copy. It receives the locator AND the caller's expected origin and
 * MUST verify, atomically with respect to its own persistence, that the origin
 * stored for that locator equals `expectedOrigin` before deleting — otherwise a
 * descriptor whose locator was swapped for another working copy's would destroy
 * the wrong allocation. A mismatch refuses without deleting. Closing the
 * returned branch's `close()` releases just the connection and must leave the
 * working copy reopenable.
 */
export type DurableWorkingCopyStrategy<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
> = Readonly<{
  type: string;
  version: number;
  create: (
    baseStore: Store<G>,
    base: BaseVersion,
    branchId: BranchId,
  ) => Promise<
    Readonly<{
      store: Store<G>;
      descriptor: TStoreDescriptor;
      access: DurableWorkingCopyAccess;
    }>
  >;
  seal: (
    descriptor: TStoreDescriptor,
    origin: DurableBranchOrigin,
  ) => Promise<void>;
  abort: (descriptor: TStoreDescriptor) => Promise<void>;
  reopen: (
    graph: G,
    descriptor: TStoreDescriptor,
  ) => Promise<
    Readonly<{
      store: Store<G>;
      origin: DurableBranchOrigin;
      access: DurableWorkingCopyAccess;
    }>
  >;
  destroy: (
    descriptor: TStoreDescriptor,
    expectedOrigin: DurableBranchOrigin,
  ) => Promise<void>;
  /**
   * Optional authoritative host-native merge optimization.
   *
   * Before returning `applied`, the strategy MUST, atomically with the native
   * merge operation:
   *
   * 1. attest `expectedOrigin` against the same allocation `branch.store` is
   *    connected to;
   * 2. validate `plan.target` on the exact target branch/session the host will
   *    merge into;
   * 3. prove the host-native diff contains exactly `plan.writes`, including all
   *    TypeGraph sidecars and no rows belonging to another graph or application;
   * 4. prove the plan needs no canonicalization, repointing, identity, callback,
   *    provenance, or other semantic work the native merge would bypass; and
   * 5. report the actual applied counts.
   *
   * A whole-database merge primitive therefore qualifies only for an allocation
   * whose complete physical diff is owned by this graph and is byte-for-byte
   * equivalent to the approved TypeGraph plan. If any dimension cannot be
   * proven, return `unsupported` BEFORE executing host SQL; TypeGraph will apply
   * the plan through its portable transaction path.
   */
  merge?:
    | ((
        args: Readonly<{
          target: Store<G>;
          branch: GraphBranch<G>;
          descriptor: TStoreDescriptor;
          expectedOrigin: DurableBranchOrigin;
          plan: MergePlanArtifactV1;
        }>,
      ) => Promise<NativeDurableMergeResult>)
    | undefined;
  /**
   * Optional atomic operation + evidence capability.
   *
   * When present, {@link import("./durable-operation").operateDurableBranch}
   * commits the host's opaque graph mutation and its immutable evidence in one
   * host transaction, keyed by idempotency. `destroy` MUST additionally refuse
   * to remove the allocation while undelivered evidence remains, throwing
   * {@link DurableEvidenceUndeliveredError}; closing a branch handle still only
   * releases the connection.
   *
   * A strategy that cannot provide the atomic guarantee MUST omit this
   * capability (or return `unsupported` from `operate`) rather than emulating
   * atomicity with callbacks or best effort. See `durable-operation.ts`.
   */
  operations?: DurableOperationCapability<TStoreDescriptor> | undefined;
}>;

/**
 * A normal {@link GraphBranch} paired with the serializable descriptor that
 * lets a later process reopen the SAME working copy. `branch` behaves exactly
 * like a `branch()` result — plan/merge APIs and `close()` are unchanged.
 */
export type DurableBranch<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
> = Readonly<{
  branch: GraphBranch<G>;
  descriptor: DurableBranchDescriptor<TStoreDescriptor>;
}>;

/**
 * Creates a durable working-copy branch of `baseStore`.
 *
 * Stamps the `base@V` token off the base, mints (or accepts) a {@link BranchId},
 * delegates materialization to `strategy.create`, captures the graph id and
 * version-blind definition hash, the at-fork schema anchor, and the engine
 * revision, then SEALS the complete origin into the host before returning the
 * normal {@link GraphBranch} together with its JSON-serializable
 * {@link DurableBranchDescriptor}.
 *
 * Returns a {@link Result}; any failure is wrapped in a {@link BranchError}.
 * Once `strategy.create` resolves, the working copy's store and persistent
 * allocation belong to this function: a capture or seal failure closes the
 * store and calls `strategy.abort`, so this never returns an unrecoverable
 * success and never leaves an orphan.
 *
 * @param baseStore - The store to fork. Remains untouched.
 * @param strategy - The durable working-copy strategy owning the host mechanics.
 * @param options - Optional `{ id }` to set an explicit branch id.
 */
export async function branchDurable<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
>(
  baseStore: Store<G>,
  strategy: DurableWorkingCopyStrategy<G, TStoreDescriptor>,
  options?: BranchOptions,
): Promise<Result<DurableBranch<G, TStoreDescriptor>, BranchError>> {
  let base: BaseVersion;
  let recordedForkPoint: RecordedForkPoint | undefined;
  let id: BranchId;
  try {
    base = await computeBaseVersion(baseStore);
    if (baseStore.historyEnabled) {
      const recorded = await baseStore.recordedNow();
      if (recorded !== undefined) recordedForkPoint = { recorded, base };
    }
    id = options?.id ?? asBranchId(generateId());
  } catch (error) {
    return err(
      new BranchError(
        "Failed to stamp the durable branch base version for the base store.",
        { cause: error },
      ),
    );
  }

  let created: Readonly<{
    store: Store<G>;
    descriptor: TStoreDescriptor;
    access: DurableWorkingCopyAccess;
  }>;
  try {
    created = await strategy.create(baseStore, base, id);
  } catch (error) {
    return err(
      new BranchError(
        "Failed to create durable working-copy branch of base store",
        { cause: error },
      ),
    );
  }

  // `create` resolved: this function owns the store AND the persistent
  // allocation. A capture or seal failure abandons both.
  let forkState;
  let definitionHash: string;
  try {
    await assertDurableWorkingCopyMatchesBase(baseStore, created.store, base);
    forkState = await readBranchForkState(created.store);
    definitionHash = await getGraphDefinitionHash(created.store.graph);
  } catch (error) {
    return err(await abandonAllocation(strategy, created, id, error));
  }

  const origin: DurableBranchOrigin = {
    graphId: created.store.graphId,
    definitionHash,
    branchId: id,
    base,
    schemaAnchor: forkState.schemaAnchor,
    forkRevision: forkState.forkRevision,
    ...(recordedForkPoint === undefined ? {} : { recordedForkPoint }),
  };
  try {
    await strategy.seal(created.descriptor, origin);
  } catch (error) {
    return err(await abandonAllocation(strategy, created, id, error));
  }

  const branch: GraphBranch<G> = {
    id,
    base,
    store: created.store,
    close: coalescedDurableClose(created.store, created.access),
    ...(forkState.schemaAnchor === undefined ?
      { schemaAnchor: undefined }
    : { schemaAnchor: forkState.schemaAnchor }),
    ...(forkState.forkRevision === undefined ?
      {}
    : { forkRevision: forkState.forkRevision }),
    ...(recordedForkPoint === undefined ? {} : { recordedForkPoint }),
  };
  const descriptor: DurableBranchDescriptor<TStoreDescriptor> = {
    kind: strategy.type,
    version: strategy.version,
    graphId: created.store.graphId,
    definitionHash,
    branchId: id,
    base,
    store: created.descriptor,
    ...(forkState.schemaAnchor === undefined ?
      { schemaAnchor: undefined }
    : { schemaAnchor: forkState.schemaAnchor }),
    ...(forkState.forkRevision === undefined ?
      {}
    : { forkRevision: forkState.forkRevision }),
    ...(recordedForkPoint === undefined ? {} : { recordedForkPoint }),
  };
  return ok({ branch, descriptor });
}

/**
 * Proves a durable allocation was created from the stamped source state.
 *
 * A physical database fork preserves the complete `base@V` token, so that
 * common path remains O(1). A strategy may instead build an equivalent
 * persistent copy whose revision namespace is intentionally independent. For
 * that case, compare the complete merge-visible graph state while fencing the
 * source before and after enumeration. The strategy remains responsible for
 * physical fidelity outside TypeGraph's graph semantics.
 */
async function assertDurableWorkingCopyMatchesBase<G extends GraphDef>(
  baseStore: Store<G>,
  workingCopy: Store<G>,
  base: BaseVersion,
): Promise<void> {
  const sourceVersionBeforeDiff = await computeBaseVersion(baseStore);
  if (sourceVersionBeforeDiff !== base) {
    throw new BranchError(
      "Base store changed while the durable working copy was being allocated.",
      {
        details: {
          baseVersion: base,
          liveBaseVersion: sourceVersionBeforeDiff,
        },
      },
    );
  }

  if (workingCopy.graphId !== baseStore.graphId) {
    throw new BranchError(
      "Durable working copy belongs to a different graph than its base store.",
      {
        details: {
          expectedGraphId: baseStore.graphId,
          receivedGraphId: workingCopy.graphId,
        },
      },
    );
  }

  const workingCopyVersion = await computeBaseVersion(workingCopy);
  if (workingCopyVersion === base) return;
  if (schemaComponentOf(workingCopyVersion) !== schemaComponentOf(base)) {
    throw new BranchError(
      "Durable working copy schema does not match its stamped base schema.",
      {
        details: {
          baseSchema: schemaComponentOf(base),
          workingCopySchema: schemaComponentOf(workingCopyVersion),
        },
      },
    );
  }

  const diff = await diffAgainstBase(baseStore, workingCopy, {
    captureForkState: false,
  });
  const sourceVersionAfterDiff = await computeBaseVersion(baseStore);
  if (sourceVersionAfterDiff !== base) {
    throw new BranchError(
      "Base store changed while the durable working copy was being verified.",
      {
        details: {
          baseVersion: base,
          liveBaseVersion: sourceVersionAfterDiff,
        },
      },
    );
  }

  const changed =
    diff.nodes.new.length > 0 ||
    diff.nodes.modified.length > 0 ||
    diff.nodes.deleted.length > 0 ||
    diff.nodes.windowed.length > 0 ||
    diff.edges.new.length > 0 ||
    diff.edges.modified.length > 0 ||
    diff.edges.deleted.length > 0 ||
    diff.edges.windowed.length > 0 ||
    diff.identity.new.length > 0 ||
    diff.identity.retracted.length > 0;
  if (!changed) return;

  throw new BranchError(
    "Durable working copy does not match its base: the stamped graph state differs.",
    {
      details: {
        baseVersion: base,
        workingCopyVersion,
        changedNodes:
          diff.nodes.new.length +
          diff.nodes.modified.length +
          diff.nodes.deleted.length +
          diff.nodes.windowed.length,
        changedEdges:
          diff.edges.new.length +
          diff.edges.modified.length +
          diff.edges.deleted.length +
          diff.edges.windowed.length,
        changedIdentityAssertions:
          diff.identity.new.length + diff.identity.retracted.length,
      },
    },
  );
}

/**
 * Reconnects to an existing durable working copy and reconstructs the normal
 * {@link GraphBranch} for it.
 *
 * Validates, in order: descriptor shape/type/version, graph id agreement,
 * strategy reconnect, store graph id, and — the load-bearing step — every
 * descriptor fence against the complete origin the host attests. A tampered
 * `graphId`/`definitionHash`/`branchId`/`base`/`schemaAnchor`/`forkRevision`,
 * including a DELETED `schemaAnchor`, is refused here; the host's persisted
 * record is the reference, never the descriptor. Finally the caller's graph
 * definition must hash to the attested fork-time definition AND agree on graph
 * id (a different graph definition, even one reusing the graph id, is not the
 * branch that was forked). Because the definition identity is attested
 * independently of `schemaAnchor`, this holds for an unmanaged working copy
 * with no committed schema row.
 *
 * The working copy's CURRENT committed schema is deliberately NOT compared to
 * the anchor: a branch may evolve its schema after forking and must remain
 * reopenable — the anchor is immutable fork metadata, not current schema.
 *
 * Every refusal is a typed {@link BranchError}, and any backend the strategy
 * opened is closed before the refusal is returned. The persistent working copy
 * is NEVER deleted here.
 *
 * @param graph - The graph definition the working copy was built with.
 * @param descriptor - The serialized descriptor returned by {@link branchDurable}.
 * @param strategy - The SAME strategy that produced `descriptor`.
 */
export async function reopenDurableBranch<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
>(
  graph: G,
  descriptor: DurableBranchDescriptor<TStoreDescriptor>,
  strategy: DurableWorkingCopyStrategy<G, TStoreDescriptor>,
): Promise<Result<GraphBranch<G>, BranchError>> {
  const refusal = durableDescriptorRefusal(descriptor, strategy);
  if (refusal !== undefined) return err(refusal);
  if (descriptor.graphId !== graph.id) {
    return err(
      new BranchError(
        `Durable branch descriptor belongs to graph "${descriptor.graphId}", not "${graph.id}".`,
        {
          details: { descriptorGraphId: descriptor.graphId, graphId: graph.id },
        },
      ),
    );
  }
  let reopened: Readonly<{
    store: Store<G>;
    origin: DurableBranchOrigin;
    access: DurableWorkingCopyAccess;
  }>;
  try {
    reopened = await strategy.reopen(graph, descriptor.store);
  } catch (error) {
    return err(
      new BranchError(
        `Failed to reopen durable working copy for branch "${descriptor.branchId}": ${describeCause(error)}`,
        {
          cause: error,
          details: { branchId: descriptor.branchId, graphId: graph.id },
          suggestion:
            "Confirm the persistent working copy still exists and is reachable by the strategy, then retry.",
        },
      ),
    );
  }
  const { access, store, origin } = reopened;
  try {
    if (store.graphId !== graph.id) {
      throw new BranchError(
        `Reopened working copy belongs to graph "${store.graphId}", not "${graph.id}".`,
        {
          details: {
            branchId: descriptor.branchId,
            reopenedGraphId: store.graphId,
            graphId: graph.id,
          },
        },
      );
    }
    const descriptorOrigin = durableOriginOfDescriptor(descriptor);
    if (!durableOriginsEqual(descriptorOrigin, origin)) {
      throw new BranchError(
        `Durable branch descriptor does not match the working copy the host attested for its store locator: the descriptor's TypeGraph fences disagree with the origin recorded at fork. This is a tampered, relabeled, or wrong-branch descriptor.`,
        {
          details: {
            branchId: descriptor.branchId,
            descriptorOrigin,
            attestedOrigin: origin,
          },
        },
      );
    }
    await assertGraphMatchesAttestedOrigin(graph, origin);
    return ok(rebuildBranch(store, access, descriptor));
  } catch (error) {
    await closeDurableQuietly(store, access);
    return err(
      error instanceof BranchError ? error : (
        new BranchError(
          `Failed to reattach durable working copy for branch "${descriptor.branchId}": ${describeCause(error)}`,
          { cause: error, details: { branchId: descriptor.branchId } },
        )
      ),
    );
  }
}

/**
 * Explicitly destroys (deletes or archives) the persistent working copy the
 * descriptor names. This is the ONLY operation that may do so; closing a
 * reopened branch's `close()` never reaches here.
 *
 * The complete descriptor origin is passed to the strategy alongside the
 * locator and MUST be verified against the host's persisted origin before
 * deletion, so a descriptor whose locator was swapped for another working
 * copy's cannot destroy the wrong allocation.
 *
 * Returns a {@link Result}: a malformed/wrong-strategy descriptor or a strategy
 * failure (including an identity mismatch) is a typed {@link BranchError}. After
 * a successful destroy, reopening the same descriptor fails.
 */
export async function destroyDurableBranch<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
>(
  descriptor: DurableBranchDescriptor<TStoreDescriptor>,
  strategy: DurableWorkingCopyStrategy<G, TStoreDescriptor>,
): Promise<Result<void, BranchError>> {
  const refusal = durableDescriptorRefusal(descriptor, strategy);
  if (refusal !== undefined) return err(refusal);
  try {
    await strategy.destroy(
      descriptor.store,
      durableOriginOfDescriptor(descriptor),
    );
    return ok(undefined);
  } catch (error) {
    // The undelivered-evidence fence is a deliberate, typed refusal: preserve
    // it instead of flattening it into a generic branch failure, so the caller
    // can still recover the evidence.
    if (error instanceof DurableEvidenceUndeliveredError) return err(error);
    return err(
      new BranchError(
        `Failed to destroy durable working copy for branch "${descriptor.branchId}": ${describeCause(error)}`,
        { cause: error, details: { branchId: descriptor.branchId } },
      ),
    );
  }
}

/**
 * Releases an allocation whose capture or seal failed: closes the store's
 * connection, then asks the strategy to abort (delete) the persistent working
 * copy.
 *
 * The returned {@link BranchError} is truthful about what happened without
 * copying strategy-private values into commonly logged error details:
 *
 *   - The original capture/seal failure is preserved as `cause`.
 *   - `details.allocationAborted` records whether `strategy.abort` actually
 *     succeeded, and the message never claims a failed abort removed the
 *     allocation.
 *   - The opaque locator and raw cleanup error are deliberately omitted from
 *     `details`, because framework errors are commonly logged. Strategy
 *     operator tooling uses the safe `branchId` and `strategyType` instead.
 */
async function abandonAllocation<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor,
>(
  strategy: DurableWorkingCopyStrategy<G, TStoreDescriptor>,
  created: Readonly<{
    store: Store<G>;
    descriptor: TStoreDescriptor;
    access: DurableWorkingCopyAccess;
  }>,
  branchId: BranchId,
  cause: unknown,
): Promise<BranchError> {
  await closeDurableQuietly(created.store, created.access);
  let aborted = false;
  try {
    await strategy.abort(created.descriptor);
    aborted = true;
  } catch {
    // The raw strategy error may contain connection details. Report the safe
    // cleanup status below without copying that value into a framework error.
  }
  return new BranchError(
    aborted ?
      `Failed to finish durable working-copy branch "${branchId}" after the host allocated it; the opened store was closed and the persistent allocation was aborted.`
    : `Failed to finish durable working-copy branch "${branchId}" after the host allocated it; the opened store was closed, but the host could NOT abort the persistent allocation, which may survive as an orphan.`,
    {
      cause,
      details: {
        branchId,
        strategyType: strategy.type,
        allocationAborted: aborted,
      },
      ...(aborted ?
        {}
      : {
          suggestion:
            "The strategy's abort failed, so the persistent allocation for `details.branchId` may still exist. Inspect or remove it through the strategy's operator tooling.",
        }),
    },
  );
}

/**
 * The strategy fields descriptor validation reads; nothing host-specific.
 */
type DescriptorOwner = Readonly<{ type: string; version: number }>;

/**
 * Structural and format validation of a (possibly JSON-parsed, hence untyped)
 * descriptor against the strategy that must own it. Returns the typed refusal
 * or `undefined` when the envelope is well-formed.
 *
 * Runtime shape checks are load-bearing: a descriptor that round-tripped
 * through JSON has no TypeScript guarantees, so a wrong-strategy, wrong-version,
 * or malformed envelope must be caught before any host is touched. These checks
 * are about FORMAT only; fence soundness is decided against host attestation.
 */
export function durableDescriptorRefusal(
  descriptor: unknown,
  strategy: DescriptorOwner,
): BranchError | undefined {
  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    Array.isArray(descriptor)
  ) {
    return new BranchError("Durable branch descriptor must be a JSON object.", {
      details: { strategyType: strategy.type },
    });
  }
  const record = descriptor as Readonly<Record<string, unknown>>;
  if (record["kind"] !== strategy.type) {
    return new BranchError(
      `Durable branch descriptor belongs to strategy "${String(record["kind"])}", not "${strategy.type}".`,
      {
        details: {
          descriptorKind: record["kind"],
          strategyType: strategy.type,
        },
      },
    );
  }
  if (record["version"] !== strategy.version) {
    return new BranchError(
      `Durable branch descriptor version ${String(record["version"])} is not supported by strategy "${strategy.type}" (expected ${strategy.version}).`,
      {
        details: {
          descriptorVersion: record["version"],
          strategyVersion: strategy.version,
        },
      },
    );
  }
  for (const key of [
    "graphId",
    "definitionHash",
    "branchId",
    "base",
  ] as const) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
      return new BranchError(
        `Durable branch descriptor is malformed: "${key}" must be a non-empty string.`,
        { details: { key, strategyType: strategy.type } },
      );
    }
  }
  if (!("store" in record)) {
    return new BranchError(
      "Durable branch descriptor is malformed: no strategy store locator.",
      { details: { strategyType: strategy.type } },
    );
  }
  if (record["schemaAnchor"] !== undefined) {
    const anchor = record["schemaAnchor"];
    if (
      typeof anchor !== "object" ||
      anchor === null ||
      typeof (anchor as Readonly<Record<string, unknown>>)["version"] !==
        "number" ||
      typeof (anchor as Readonly<Record<string, unknown>>)["hash"] !== "string"
    ) {
      return new BranchError(
        "Durable branch descriptor is malformed: schemaAnchor must be { version: number; hash: string }.",
        { details: { strategyType: strategy.type } },
      );
    }
  }
  if (
    record["forkRevision"] !== undefined &&
    typeof record["forkRevision"] !== "string"
  ) {
    return new BranchError(
      "Durable branch descriptor is malformed: forkRevision must be a string.",
      { details: { strategyType: strategy.type } },
    );
  }
  if (record["recordedForkPoint"] !== undefined) {
    const point = record["recordedForkPoint"];
    if (
      typeof point !== "object" ||
      point === null ||
      typeof (point as Readonly<Record<string, unknown>>)["recorded"] !==
        "string" ||
      typeof (point as Readonly<Record<string, unknown>>)["base"] !== "string"
    ) {
      return new BranchError(
        "Durable branch descriptor is malformed: recordedForkPoint must be { recorded: string, base: string }.",
        { details: { strategyType: strategy.type } },
      );
    }
    try {
      asRecordedInstant((point as Readonly<{ recorded: string }>).recorded);
    } catch (error) {
      return new BranchError(
        "Durable branch descriptor has an invalid recorded fork instant.",
        { cause: error, details: { strategyType: strategy.type } },
      );
    }
  }
  return undefined;
}

/** Extracts the TypeGraph-owned origin from a descriptor envelope. */
export function durableOriginOfDescriptor<
  TStoreDescriptor extends DurableStoreDescriptor,
>(descriptor: DurableBranchDescriptor<TStoreDescriptor>): DurableBranchOrigin {
  return {
    graphId: descriptor.graphId,
    definitionHash: descriptor.definitionHash,
    branchId: descriptor.branchId,
    base: descriptor.base,
    schemaAnchor: descriptor.schemaAnchor,
    forkRevision: descriptor.forkRevision,
    ...(descriptor.recordedForkPoint === undefined ?
      {}
    : { recordedForkPoint: descriptor.recordedForkPoint }),
  };
}

/**
 * THE one equality for a descriptor origin against a host-attested one. Every
 * fence participates — including the graph id and version-blind definition hash
 * that carry definition identity independently of `schemaAnchor` — and an
 * absent schema anchor matches only an absent one (explicit-absent semantics),
 * so a descriptor that dropped the key disagrees with a host that persisted the
 * anchor.
 */
export function durableOriginsEqual(
  descriptor: DurableBranchOrigin,
  attested: DurableBranchOrigin,
): boolean {
  return (
    descriptor.graphId === attested.graphId &&
    descriptor.definitionHash === attested.definitionHash &&
    descriptor.branchId === attested.branchId &&
    descriptor.base === attested.base &&
    schemaAnchorsEqual(descriptor.schemaAnchor, attested.schemaAnchor) &&
    descriptor.forkRevision === attested.forkRevision &&
    recordedForkPointsEqual(
      descriptor.recordedForkPoint,
      attested.recordedForkPoint,
    )
  );
}

function recordedForkPointsEqual(
  left: DurableBranchOrigin["recordedForkPoint"],
  right: DurableBranchOrigin["recordedForkPoint"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.recorded === right.recorded && left.base === right.base;
}

function schemaAnchorsEqual(
  left: Readonly<{ version: number; hash: string }> | undefined,
  right: Readonly<{ version: number; hash: string }> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.version === right.version && left.hash === right.hash;
}

/**
 * The graph-identity half of reopen's fences, against the COMPLETE
 * host-attested {@link DurableBranchOrigin}.
 *
 * The caller's graph must name the attested graph id AND hash to the attested
 * version-blind definition hash: a graph definition that hashes differently is
 * a DIFFERENT definition — even one reusing the graph id — and attaching it
 * would misread the working copy. This is the fence that protects an UNMANAGED
 * working copy, whose `schemaAnchor` is absent; it never consults the anchor and
 * is deliberately NOT a comparison against the working copy's live schema row
 * (a branch may evolve its committed schema after forking and must still
 * reopen). Throws a {@link BranchError}; the caller closes the store.
 */
async function assertGraphMatchesAttestedOrigin<G extends GraphDef>(
  graph: G,
  origin: DurableBranchOrigin,
): Promise<void> {
  if (graph.id !== origin.graphId) {
    throw new BranchError(
      `The supplied graph "${graph.id}" is not the graph the durable working copy was forked from ("${origin.graphId}").`,
      {
        details: {
          graphId: graph.id,
          attestedGraphId: origin.graphId,
        },
      },
    );
  }
  const graphHash = await getGraphDefinitionHash(graph);
  if (graphHash !== origin.definitionHash) {
    throw new BranchError(
      `The supplied graph definition is incompatible with the durable working copy's host-attested fork-time definition: it hashes differently, so it is a different graph definition even though it reuses graph id "${graph.id}". This identity check is attested independently of any committed schema anchor, so it also protects an unmanaged working copy.`,
      {
        details: {
          graphId: graph.id,
          attestedDefinitionHash: origin.definitionHash,
          graphHash,
        },
      },
    );
  }
}

/**
 * Reconstructs the ordinary {@link GraphBranch} view of a reattached store: the
 * descriptor's TypeGraph-owned fences plus a fresh coalesced close over the
 * store. `schemaAnchor` is always present, matching `branch()`.
 */
function rebuildBranch<G extends GraphDef>(
  store: Store<G>,
  access: DurableWorkingCopyAccess,
  descriptor: DurableBranchDescriptor<DurableStoreDescriptor>,
): GraphBranch<G> {
  return {
    id: descriptor.branchId,
    base: descriptor.base,
    store,
    close: coalescedDurableClose(store, access),
    schemaAnchor: descriptor.schemaAnchor,
    ...(descriptor.forkRevision === undefined ?
      {}
    : { forkRevision: descriptor.forkRevision }),
    ...(descriptor.recordedForkPoint === undefined ?
      {}
    : { recordedForkPoint: descriptor.recordedForkPoint }),
  };
}

/**
 * Releases the opened backend and then its host-wide writer lease, once.
 *
 * The backend closes first so no live connection survives after the exclusive
 * lease becomes available to another process. Each completed phase is retained
 * across retries: if lease release fails, the next `close()` retries only that
 * release and never calls a non-idempotent backend `close()` twice.
 */
function coalescedDurableClose<G extends GraphDef>(
  store: Store<G>,
  access: DurableWorkingCopyAccess,
): () => Promise<void> {
  const closeBackend = coalescedWorkingCopyClose(store);
  let complete = false;
  let accessReleased = false;
  let inFlight: Promise<void> | undefined;
  return async () => {
    if (complete) return;
    inFlight ??= (async () => {
      await closeBackend();
      if (access.kind === "exclusive" && !accessReleased) {
        await access.release();
        accessReleased = true;
      }
      complete = true;
    })().finally(() => {
      inFlight = undefined;
    });
    await inFlight;
  };
}

/**
 * Releases a store's backend, swallowing a close failure so it cannot mask the
 * refusal being returned. The store belongs to this function on every failure
 * path inside `reopenDurableBranch` and `abandonAllocation`.
 */
async function closeDurableQuietly<G extends GraphDef>(
  store: Store<G>,
  access: DurableWorkingCopyAccess,
): Promise<void> {
  try {
    await coalescedDurableClose(store, access)();
  } catch {
    // Intentionally ignored — surface the original refusal.
  }
}
