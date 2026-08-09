/**
 * What claims a node of a given kind owes, before its props are known.
 *
 * This is the DECLARATION-level half of the claim set, and it is deliberately
 * separate from the props-level half: the same list answers "which claim rows
 * does this kind write?" (the entries, once a row's props select the applying
 * constraints and supply their keys) and "does a write of this kind need the
 * per-graph lock?" (the projection in `../constraints.ts`). Two consumers, one
 * classification — a second spelling at either of them is what this module
 * exists to prevent.
 *
 * It imports registry, core types and the axis vocabulary only, so the
 * constraint probes can project it without importing the claim seam.
 */
import { type UniqueConstraint } from "../../core/types";
import { type KindRegistry } from "../../registry/kind-registry";
import { uniquenessClaimTarget } from "./axis";

/** One claim a node of this kind owes, before its props are known. */
export type NodeClaimSite = Readonly<{
  /** The value the claim row's `node_kind` carries — what the PK fences on. */
  axis: string;
  /** The claim row's `constraint_name`. */
  constraintName: string;
  /**
   * Whether this site is ALSO a reason to take the per-graph write lock — i.e.
   * whether its probe reads state the uniques primary key does not already
   * fence. True for a scope spanning more than the node's own kind; false for a
   * single-kind scope, whose own key IS the fence.
   */
  needsLockFence: boolean;
  /** The constraint this site came from. */
  constraint: UniqueConstraint;
}>;

/**
 * THE owner of "what claims does a node of this kind owe?".
 *
 * `needsLockFence` and `axis` are the two halves of one
 * {@link uniquenessClaimTarget}, so the lock trigger and the claim target are
 * two readings of one fact rather than two predicates that agree until one is
 * edited.
 */
export function nodeClaimSites(
  registry: KindRegistry,
  kind: string,
  uniqueConstraints: readonly UniqueConstraint[],
): readonly NodeClaimSite[] {
  return uniqueConstraints.map((constraint) => {
    const target = uniquenessClaimTarget(kind, constraint.scope, registry);
    return {
      axis: target.axis,
      constraintName: constraint.name,
      needsLockFence: target.crossKind,
      constraint,
    };
  });
}
