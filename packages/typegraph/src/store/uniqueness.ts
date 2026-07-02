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
  // A single constraint's sidecar change, computed once every changed key has
  // been proven free (pass 1) and applied only afterwards (pass 2). `oldKey`
  // (undefined = nothing to release) is deleted; `newKey` (undefined = nothing
  // to reserve) is inserted.
  type PendingUniqueMutation = Readonly<{
    constraintName: string;
    oldKey: string | undefined;
    newKey: string | undefined;
  }>;

  // Pass 1 — preflight EVERY changed constraint before mutating any sidecar. A
  // node can carry several unique constraints; mutating them one at a time would
  // let a later constraint's conflict throw AFTER earlier sidecars were already
  // changed, and a caller that catches UniquenessError and still commits the
  // transaction (e.g. importGraph's onConflict: "update", which reports the
  // conflict per-row) would leave those earlier sidecars mutated while the row
  // stays unchanged. Checking every new key first means the throw happens with
  // zero writes. Checks are independent per `constraintName`, so a constraint's
  // preflight is unaffected by the still-unapplied mutations of the others.
  const pending: PendingUniqueMutation[] = [];
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

    // Check the new key for conflicts with OTHER nodes.
    if (newApplies && newKey !== undefined) {
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
    }

    pending.push({ constraintName: constraint.name, oldKey, newKey });
  }

  // Pass 2 — every changed key is proven free, so releasing the old entries and
  // reserving the new ones can no longer fail on a duplicate mid-way. Release
  // all before reserving all, so a value moving between this node's constraints
  // is never transiently double-held.
  for (const mutation of pending) {
    if (mutation.oldKey !== undefined) {
      await ctx.backend.deleteUnique({
        graphId: ctx.graphId,
        nodeKind: kind,
        constraintName: mutation.constraintName,
        key: mutation.oldKey,
      });
    }
  }
  for (const mutation of pending) {
    if (mutation.newKey !== undefined) {
      await ctx.backend.insertUnique({
        graphId: ctx.graphId,
        nodeKind: kind,
        constraintName: mutation.constraintName,
        key: mutation.newKey,
        nodeId: id,
        concreteKind: kind,
      });
    }
  }
}
