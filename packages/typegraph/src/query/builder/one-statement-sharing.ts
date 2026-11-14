import { requireDefined } from "../../utils/presence";
import type { OneStatementBatchableQuery } from "./types";

export type OneStatementBatchItem<Result = unknown> = ReturnType<
  NonNullable<
    OneStatementBatchableQuery<Result>["compileOneStatementBatchItem"]
  >
>;

export type OneStatementCombinedItem = OneStatementBatchItem<
  readonly unknown[]
> &
  Readonly<{ payloadPartitionColumn?: string }>;

export type OneStatementSharing = Readonly<{
  kind: "subgraph";
  owner: object;
  key: string;
  combine: (
    items: readonly OneStatementBatchItem[],
    sharePayloads: boolean,
  ) => OneStatementCombinedItem;
}>;

export type OneStatementBatchGroup = Readonly<{
  indices: readonly number[];
  kind: "subgraph" | undefined;
  item: OneStatementCombinedItem;
}>;

// Evidence belongs to the exact compiled item, not a mutable read wrapper.
const sharing = new WeakMap<OneStatementBatchItem, OneStatementSharing>();

export function registerOneStatementSharing(
  item: OneStatementBatchItem,
  plan: OneStatementSharing,
): void {
  sharing.set(item, plan);
}

export function groupOneStatementBatchItems(
  items: readonly OneStatementBatchItem[],
  sharePayloads: boolean,
): readonly OneStatementBatchGroup[] {
  const groups: {
    indices: number[];
    sharing: OneStatementSharing | undefined;
  }[] = [];
  const owners = new Map<object, Map<string, number>>();
  for (const [index, item] of items.entries()) {
    const plan = sharing.get(item);
    if (plan === undefined) {
      groups.push({ indices: [index], sharing: undefined });
      continue;
    }
    const keys = owners.get(plan.owner) ?? new Map<string, number>();
    owners.set(plan.owner, keys);
    const existing = keys.get(plan.key);
    if (existing === undefined) {
      keys.set(plan.key, groups.length);
      groups.push({ indices: [index], sharing: plan });
    } else {
      requireDefined(groups[existing]).indices.push(index);
    }
  }
  return groups.map((group) => {
    const inputs = group.indices.map((index) => requireDefined(items[index]));
    const first = requireDefined(inputs[0]);
    return {
      indices: group.indices,
      kind: group.sharing?.kind,
      item:
        group.sharing !== undefined && inputs.length > 1 ?
          group.sharing.combine(inputs, sharePayloads)
        : { ...first, mapRows: (rows) => [first.mapRows(rows)] },
    };
  });
}
