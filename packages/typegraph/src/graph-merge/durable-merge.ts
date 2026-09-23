/**
 * Applies an approved merge plan through an optional host-native merge command,
 * with the ordinary portable applier as the complete fallback.
 *
 * The native command is an optimization attempt, never a second source of merge
 * semantics. TypeGraph validates the serialized plan and durable envelope first.
 * The strategy may return `applied` only after atomically proving and honoring
 * every dimension in `DurableWorkingCopyStrategy.merge`; `unsupported` means it
 * executed no host mutation, so the full portable plan is safe to run.
 */

import type { MergePlanApplyOptions } from "./apply-callbacks";
import type {
  DurableBranchDescriptor,
  DurableStoreDescriptor,
  DurableWorkingCopyStrategy,
  NativeDurableMergeResult,
} from "./durable-branch";
import {
  durableDescriptorRefusal,
  durableOriginOfDescriptor,
  durableOriginsEqual,
} from "./durable-branch";
import { describeCause, MergeError } from "./errors";
import {
  applyMergePlan,
  reportFromArtifact,
  validateMergePlanForTarget,
} from "./merge";
import type { MergePlanArtifact, MergePlanArtifactV2 } from "./plan-schema";
import type { Result } from "./result";
import { err, ok } from "./result";
import type { GraphDef, Store } from "./typegraph-internal";
import { getGraphDefinitionHash } from "./typegraph-internal";
import type { GraphBranch, MergeReport } from "./types";

/** Arguments for {@link applyDurableMergePlan}. */
export type ApplyDurableMergePlanArgs<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
> = Readonly<{
  target: Store<G>;
  branch: GraphBranch<G>;
  descriptor: DurableBranchDescriptor<TStoreDescriptor>;
  strategy: DurableWorkingCopyStrategy<G, TStoreDescriptor>;
  plan: MergePlanArtifact;
  options?: MergePlanApplyOptions<NoInfer<G>> | undefined;
}>;

/**
 * Applies an approved durable-branch plan, preferring a proven-equivalent
 * host-native merge and otherwise using {@link applyMergePlan} unchanged.
 *
 * Native merge is deliberately skipped when callbacks or persisted provenance
 * are requested, and when the plan carries identity or composition work (see
 * {@link planOwesPortableSemantics}). Those dimensions belong to TypeGraph's
 * transaction, sidecar, and write-path owners; a raw database branch merge
 * cannot silently drop them.
 */
export async function applyDurableMergePlan<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
>(
  args: ApplyDurableMergePlanArgs<G, TStoreDescriptor>,
): Promise<Result<MergeReport<G>, MergeError>> {
  const { branch, descriptor, plan, strategy, target } = args;
  const options = args.options ?? {};
  const refusal = durableDescriptorRefusal(descriptor, strategy);
  if (refusal !== undefined) {
    return err(
      new MergeError("Durable merge descriptor validation failed.", {
        cause: refusal,
      }),
    );
  }

  let artifact: MergePlanArtifactV2;
  const descriptorOrigin = durableOriginOfDescriptor(descriptor);
  try {
    artifact = await validateMergePlanForTarget(target, plan);
    const branchOrigin = {
      graphId: branch.store.graphId,
      definitionHash: await getGraphDefinitionHash(branch.store.graph),
      branchId: branch.id,
      base: branch.base,
      schemaAnchor: branch.schemaAnchor,
      forkRevision: branch.forkRevision,
    };
    if (!durableOriginsEqual(branchOrigin, descriptorOrigin)) {
      throw new MergeError(
        "The durable branch handle does not match the descriptor supplied for native merge.",
        {
          details: {
            branchOrigin,
            descriptorOrigin,
          },
        },
      );
    }
  } catch (error) {
    return err(
      error instanceof MergeError ? error : (
        new MergeError(
          `Durable merge validation failed: ${describeCause(error)}`,
          { cause: error },
        )
      ),
    );
  }

  const usePortableApply = (): Promise<Result<MergeReport<G>, MergeError>> =>
    applyMergePlan(target, artifact, options);
  const hasCallbacks =
    options.beforeApply !== undefined || options.afterApply !== undefined;
  if (
    strategy.merge === undefined ||
    hasCallbacks ||
    artifact.provenance.persist ||
    planOwesPortableSemantics(target, artifact)
  ) {
    return usePortableApply();
  }

  let nativeResult: NativeDurableMergeResult;
  try {
    nativeResult = await strategy.merge({
      target,
      branch,
      descriptor: descriptor.store,
      expectedOrigin: descriptorOrigin,
      plan: artifact,
    });
  } catch (error) {
    return err(
      new MergeError(
        `Host-native durable merge failed: ${describeCause(error)}`,
        {
          cause: error,
          suggestion:
            "Inspect the host-native merge state before retrying. TypeGraph does not run the portable fallback after an uncertain or failed native attempt because the host may have applied a partial change.",
        },
      ),
    );
  }
  if (nativeResult.outcome === "unsupported") return usePortableApply();
  return ok(
    reportFromArtifact(artifact, nativeResult.merged, [
      ...artifact.review.warnings,
      ...(nativeResult.warnings ?? []),
    ]),
  );
}

/**
 * Whether `artifact` carries semantic work only the portable applier performs,
 * which a host-native row merge cannot prove it ran: identity ledger writes and
 * their reconciliation (the transition log, closure maintenance, and the
 * recorded decision), or composition work (a whole's cascade to its parts, the
 * single-whole claim, and the required-existence check on every part, edge, or
 * whole the plan writes). Such a plan never reaches `strategy.merge`.
 */
function planOwesPortableSemantics<G extends GraphDef>(
  target: Store<G>,
  artifact: MergePlanArtifactV2,
): boolean {
  const { review, writes } = artifact;
  if (
    writes.identityAssertions.length > 0 ||
    writes.identityRetractions.length > 0 ||
    (review.identityReconciliations ?? []).length > 0 ||
    (review.identityConflicts ?? []).length > 0 ||
    review.compositionOrphans.length > 0
  ) {
    return true;
  }
  const registry = target.registry;
  return (
    [...writes.nodeDeletes, ...writes.nodeUpserts].some(
      (node) =>
        registry.isCompositionWhole(node.kind) ||
        registry.isCompositionPart(node.kind),
    ) ||
    [...writes.edgeDeletes, ...writes.edgeUpserts].some((edge) =>
      registry.isCompositionEdge(edge.kind),
    )
  );
}
