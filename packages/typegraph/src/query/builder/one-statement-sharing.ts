import { requireDefined } from "../../utils/presence";
import type { OneStatementBatchableQuery } from "./types";

export type OneStatementBatchItem<Result = unknown> = ReturnType<
  NonNullable<
    OneStatementBatchableQuery<Result>["compileOneStatementBatchItem"]
  >
>;

export type OneStatementSharing = Readonly<{
  owner: object;
  key: string;
  combine: (
    items: readonly OneStatementBatchItem[],
  ) => OneStatementBatchItem<readonly unknown[]>;
}>;

export type OneStatementBatchGroup = Readonly<{
  indices: readonly number[];
  item: OneStatementBatchItem<readonly unknown[]>;
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
  enabled: boolean,
): readonly OneStatementBatchGroup[] {
  const groups: {
    indices: number[];
    sharing: OneStatementSharing | undefined;
  }[] = [];
  const owners = new Map<object, Map<string, number>>();
  for (const [index, item] of items.entries()) {
    const plan = enabled ? sharing.get(item) : undefined;
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
      item:
        group.sharing !== undefined && inputs.length > 1 ?
          group.sharing.combine(inputs)
        : { ...first, mapRows: (rows) => [first.mapRows(rows)] },
    };
  });
}
