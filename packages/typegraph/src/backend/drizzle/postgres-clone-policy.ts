import { BranchError } from "../../graph-merge/errors";
import type { TableContribution } from "../table-contribution";

export type WorkingCopyClonePolicy = NonNullable<
  TableContribution["workingCopyClonePolicy"]
>;

export type PostgresCloneAction = Readonly<{
  source: TableContribution;
  target: TableContribution;
  policy: Extract<
    WorkingCopyClonePolicy,
    { kind: "graphRows" | "graphDocument" }
  >;
}>;

function sameClonePolicy(
  source: WorkingCopyClonePolicy,
  target: WorkingCopyClonePolicy,
): boolean {
  if (source.kind !== target.kind) return false;
  switch (source.kind) {
    case "graphRows": {
      return (
        target.kind === "graphRows" &&
        source.graphIdColumn === target.graphIdColumn
      );
    }
    case "graphDocument": {
      return (
        target.kind === "graphDocument" &&
        source.documentColumn === target.documentColumn &&
        source.graphIdKey === target.graphIdKey
      );
    }
    case "freshSeed":
    case "rebuildAfterClone": {
      return true;
    }
    case "unsupported": {
      return target.kind === "unsupported" && source.reason === target.reason;
    }
  }
}

/** Validate the whole inventory before copying any contributed rows. */
export function resolvePostgresCloneActions(
  source: readonly TableContribution[],
  target: readonly TableContribution[],
): readonly PostgresCloneAction[] {
  if (source.length !== target.length) {
    throw new BranchError("Working-copy contribution inventories differ.");
  }
  const actions: PostgresCloneAction[] = [];
  for (const [index, contribution] of source.entries()) {
    const destination = target[index];
    if (destination === undefined) {
      throw new BranchError("Working-copy inventory changed during clone.");
    }
    if (
      contribution.logicalName !== destination.logicalName ||
      contribution.owner !== destination.owner
    ) {
      throw new BranchError("Working-copy inventory changed during clone.");
    }
    const policy = contribution.workingCopyClonePolicy;
    const destinationPolicy = destination.workingCopyClonePolicy;
    if (policy === undefined || destinationPolicy === undefined) {
      throw new BranchError(
        `Working-copy relation ${contribution.tableName} has no declared clone policy.`,
      );
    }
    if (!sameClonePolicy(policy, destinationPolicy)) {
      throw new BranchError(
        `Working-copy relation ${contribution.tableName} changed clone policy during allocation.`,
      );
    }
    if (policy.kind === "unsupported") {
      throw new BranchError(
        `Working-copy relation ${contribution.tableName} cannot be cloned: ${policy.reason}`,
      );
    }
    if (policy.kind === "graphRows" || policy.kind === "graphDocument") {
      actions.push({ source: contribution, target: destination, policy });
    }
  }
  return actions;
}
