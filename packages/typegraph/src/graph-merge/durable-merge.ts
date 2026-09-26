/**
 * Validates a durable branch handle and applies an approved merge plan through
 * TypeGraph's transaction-scoped portable applier.
 */

import type { MergePlanApplyOptions } from "./apply-callbacks";
import type {
  DurableBranchDescriptor,
  DurableGraphBranch,
  DurableStoreDescriptor,
  DurableWorkingCopyStrategy,
} from "./durable-branch";
import {
  durableDescriptorRefusal,
  durableOriginOfDescriptor,
  durableOriginsEqual,
} from "./durable-branch";
import { describeCause, MergeError } from "./errors";
import { applyMergePlan, validateMergePlanForTarget } from "./merge";
import type { MergePlanArtifact, MergePlanArtifactV1 } from "./plan-schema";
import type { Result } from "./result";
import { err } from "./result";
import type { GraphDef, Store } from "./typegraph-internal";
import { getGraphDefinitionHash } from "./typegraph-internal";
import type { MergeReport } from "./types";

/** Arguments for {@link applyDurableMergePlan}. */
export type ApplyDurableMergePlanArgs<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
> = Readonly<{
  target: Store<G>;
  branch: DurableGraphBranch<G>;
  descriptor: DurableBranchDescriptor<TStoreDescriptor>;
  strategy: DurableWorkingCopyStrategy<G, TStoreDescriptor>;
  plan: MergePlanArtifact;
  options?: MergePlanApplyOptions<NoInfer<G>> | undefined;
}>;

/**
 * Applies an approved durable-branch plan after validating that its live
 * handle matches the sealed descriptor. Native branch allocation remains
 * available, while writes use the portable applier's target transaction fence.
 */
export async function applyDurableMergePlan<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
>(
  args: ApplyDurableMergePlanArgs<G, TStoreDescriptor>,
): Promise<Result<MergeReport<G>, MergeError>> {
  const { branch, descriptor, plan, strategy, target } = args;
  const options = args.options ?? {};
  if ("merge" in strategy && strategy.merge !== undefined) {
    return err(
      new MergeError(
        "DurableWorkingCopyStrategy.merge is retired. Remove it and apply the plan through the target Store transaction.",
      ),
    );
  }
  const refusal = durableDescriptorRefusal(descriptor, strategy);
  if (refusal !== undefined) {
    return err(
      new MergeError("Durable merge descriptor validation failed.", {
        cause: refusal,
      }),
    );
  }

  let artifact: MergePlanArtifactV1;
  const descriptorOrigin = durableOriginOfDescriptor(descriptor);
  try {
    artifact = await validateMergePlanForTarget(target, plan);
    const branchOrigin = {
      allocationId: branch.allocationId,
      graphId: branch.store.graphId,
      definitionHash: await getGraphDefinitionHash(branch.store.graph),
      branchId: branch.id,
      base: branch.base,
      schemaAnchor: branch.schemaAnchor,
      forkRevision: branch.forkRevision,
      recordedForkPoint: branch.recordedForkPoint,
    };
    if (!durableOriginsEqual(branchOrigin, descriptorOrigin)) {
      throw new MergeError(
        "The durable branch handle does not match the descriptor supplied for merge.",
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

  return applyMergePlan(target, artifact, options);
}
