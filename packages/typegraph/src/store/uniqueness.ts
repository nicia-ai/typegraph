/**
 * Uniqueness Constraint Management
 *
 * Handles checking, inserting, updating, and deleting uniqueness constraint entries.
 */
import { type GraphBackend, type TransactionBackend } from "../backend/types";
import {
  checkWherePredicate,
  computeUniqueKey,
  getKindsForUniquenessCheck,
} from "../constraints";
import { type UniqueConstraint } from "../core/types";
import { UniquenessError } from "../errors";
import { type KindRegistry } from "../registry/kind-registry";

/**
 * Context for uniqueness operations.
 */
export type UniquenessContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
  backend: GraphBackend | TransactionBackend;
}>;

/**
 * Checks uniqueness constraints for a new or existing node.
 *
 * @throws ValidationError if any constraint is violated
 */
export async function checkUniquenessConstraints(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<void> {
  for (const constraint of constraints) {
    if (!checkWherePredicate(constraint, props)) {
      continue;
    }

    const key = computeUniqueKey(
      props,
      constraint.fields,
      constraint.collation,
    );

    const kindsToCheck = getKindsForUniquenessCheck(
      kind,
      constraint.scope,
      ctx.registry,
    );

    for (const kindToCheck of kindsToCheck) {
      const existing = await ctx.backend.checkUnique({
        graphId: ctx.graphId,
        nodeKind: kindToCheck,
        constraintName: constraint.name,
        key,
      });

      if (existing && existing.node_id !== id) {
        throw new UniquenessError({
          constraintName: constraint.name,
          kind: kindToCheck,
          existingId: existing.node_id,
          newId: id,
          fields: constraint.fields,
        });
      }
    }
  }
}

/**
 * Inserts uniqueness entries for a newly created node.
 */
export async function insertUniquenessEntries(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<void> {
  for (const constraint of constraints) {
    if (!checkWherePredicate(constraint, props)) {
      continue;
    }

    const key = computeUniqueKey(
      props,
      constraint.fields,
      constraint.collation,
    );

    await ctx.backend.insertUnique({
      graphId: ctx.graphId,
      nodeKind: kind,
      constraintName: constraint.name,
      key,
      nodeId: id,
      concreteKind: kind,
    });
  }
}

/**
 * Deletes uniqueness entries for a node being deleted.
 */
export async function deleteUniquenessEntries(
  ctx: UniquenessContext,
  kind: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<void> {
  for (const constraint of constraints) {
    if (!checkWherePredicate(constraint, props)) {
      continue;
    }

    const key = computeUniqueKey(
      props,
      constraint.fields,
      constraint.collation,
    );

    await ctx.backend.deleteUnique({
      graphId: ctx.graphId,
      nodeKind: kind,
      constraintName: constraint.name,
      key,
    });
  }
}

/**
 * Updates uniqueness entries when a node's props change.
 * Handles cases where:
 * - Constraint now applies (wasn't before)
 * - Constraint no longer applies (was before)
 * - Key value changed
 *
 * @throws ValidationError if updated value violates a constraint
 */
export async function updateUniquenessEntries(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  oldProps: Record<string, unknown>,
  newProps: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<void> {
  for (const constraint of constraints) {
    const oldApplies = checkWherePredicate(constraint, oldProps);
    const newApplies = checkWherePredicate(constraint, newProps);

    const oldKey =
      oldApplies ?
        computeUniqueKey(oldProps, constraint.fields, constraint.collation)
      : undefined;
    const newKey =
      newApplies ?
        computeUniqueKey(newProps, constraint.fields, constraint.collation)
      : undefined;

    // No change - constraint didn't apply and still doesn't
    if (!oldApplies && !newApplies) {
      continue;
    }

    // Keys are the same and constraint still applies - nothing to do
    if (oldApplies && newApplies && oldKey === newKey) {
      continue;
    }

    // Delete old entry if constraint used to apply
    if (oldApplies && oldKey !== undefined) {
      await ctx.backend.deleteUnique({
        graphId: ctx.graphId,
        nodeKind: kind,
        constraintName: constraint.name,
        key: oldKey,
      });
    }

    // Check and insert new entry if constraint now applies
    if (newApplies && newKey !== undefined) {
      const kindsToCheck = getKindsForUniquenessCheck(
        kind,
        constraint.scope,
        ctx.registry,
      );

      // Check for conflicts with other nodes
      for (const kindToCheck of kindsToCheck) {
        const existing = await ctx.backend.checkUnique({
          graphId: ctx.graphId,
          nodeKind: kindToCheck,
          constraintName: constraint.name,
          key: newKey,
        });

        if (existing && existing.node_id !== id) {
          throw new UniquenessError({
            constraintName: constraint.name,
            kind: kindToCheck,
            existingId: existing.node_id,
            newId: id,
            fields: constraint.fields,
          });
        }
      }

      // Insert new uniqueness entry
      await ctx.backend.insertUnique({
        graphId: ctx.graphId,
        nodeKind: kind,
        constraintName: constraint.name,
        key: newKey,
        nodeId: id,
        concreteKind: kind,
      });
    }
  }
}
