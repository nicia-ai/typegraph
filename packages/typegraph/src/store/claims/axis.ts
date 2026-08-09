/**
 * Claim axis vocabulary.
 *
 * A declared constraint is a CLAIM on an AXIS: the value bound to a claim row's
 * `node_kind` column, which is what the relation's primary key fences on. The
 * axis is not always a kind — it is whatever set of kinds the constraint spans —
 * and deciding it is this module's only job, so no write path spells its own.
 *
 * The other half of a claim row is its OWNER, `(concrete_kind, node_id)`. Ids
 * are unique only per kind, so an id alone cannot answer "is this row mine?":
 * `Employee "X"` and `Contractor "X"` are two rows under the nodes primary key
 * and would read as one owner. The predicate lives here once, in the two
 * renderings the code needs (TypeScript and SQL), so a claim's accept/refuse
 * verdict cannot differ between the layer that probes it and the layer that
 * writes it.
 */
import { type Column, type SQL, sql } from "drizzle-orm";

import {
  getKindsForUniquenessCheck,
  subClassComponent,
} from "../../constraints";
import { type UniquenessScope } from "../../core/types";
import { type KindRegistry } from "../../registry/kind-registry";
import { compareStrings } from "../../utils/compare";

/**
 * WHERE a uniqueness claim for this kind and scope is written, and whether that
 * target spans kinds beyond the writer's own.
 *
 * Both facts come out of one computation on purpose. The axis is the code-point
 * minimum of the set the scope covers, and "does this site also need the
 * per-graph write lock?" is that same set having more than one member — so a
 * caller cannot pick up one without the other, and the lock trigger cannot
 * drift away from the claim target. Asking the covered SET rather than the
 * scope token is what keeps a `kindWithSubClasses` constraint on a kind with no
 * hierarchy classified like the `kind` scope it is equivalent to.
 */
export type UniquenessClaimTarget = Readonly<{
  axis: string;
  crossKind: boolean;
}>;

/** THE decision above — the one owner of both readings. */
export function uniquenessClaimTarget(
  kind: string,
  scope: UniquenessScope,
  registry: KindRegistry,
): UniquenessClaimTarget {
  const kinds = scope === "kind" ? [kind] : subClassComponent(kind, registry);
  return { axis: kinds[0] ?? kind, crossKind: kinds.length > 1 };
}

/**
 * THE axis a uniqueness claim is written at: the kind itself for
 * `scope: "kind"`, and the code-point minimum of the subclass component for
 * `scope: "kindWithSubClasses"`.
 *
 * The minimum is a fold of a kind-independent set, so every kind in one
 * hierarchy folds to the same axis and their claims collide on the uniques
 * primary key — which is the whole fence. Reserving under each writer's own
 * kind (what this replaces) put sibling kinds in rows that can never collide.
 */
export function uniquenessClaimAxis(
  kind: string,
  scope: UniquenessScope,
  registry: KindRegistry,
): string {
  return uniquenessClaimTarget(kind, scope, registry).axis;
}

/**
 * THE order a uniqueness probe reads claim rows in: the axis first, then every
 * remaining kind the scope covers, in code-point order.
 *
 * Two things make this list wider than the axis alone and narrower than
 * arbitrary:
 *
 * - The axis is where this version writes, so it is read first; it is included
 *   even when it is not a member of {@link getKindsForUniquenessCheck}'s set,
 *   which happens on a multi-root hierarchy where that set walks one root.
 * - Rows written before the axis move sit under their own concrete kind, so the
 *   probe keeps visiting every kind in scope. That is what makes the axis move
 *   need no data migration.
 *
 * The remainder is sorted rather than left in registry-iteration order so two
 * processes reading the same scope read it in the same order.
 */
export function uniquenessProbeKinds(
  kind: string,
  scope: UniquenessScope,
  registry: KindRegistry,
): readonly string[] {
  const axis = uniquenessClaimAxis(kind, scope, registry);
  const rest = getKindsForUniquenessCheck(kind, scope, registry)
    .filter((candidate) => candidate !== axis)
    .toSorted((left, right) => compareStrings(left, right));
  return [axis, ...rest];
}

/**
 * WHO holds a claim. A node, not an id: ids are unique only per kind, so
 * `(concrete_kind, node_id)` is the smallest thing that identifies a claimant.
 */
export type ClaimOwner = Readonly<{ concreteKind: string; nodeId: string }>;

/**
 * THE ownership predicate. Every reader of "is this claim row mine?" calls it —
 * the probe, the single-row upsert's verdict, the batch upsert's verdict, and
 * the batch-validation cache's pending answer.
 *
 * Comparing ids alone accepts a claim held by a namesake under another kind,
 * which is precisely the collision `disjointWith` forbids and precisely the one
 * a shared uniqueness scope exists to catch.
 */
export function isSameClaimOwner(left: ClaimOwner, right: ClaimOwner): boolean {
  return (
    left.nodeId === right.nodeId && left.concreteKind === right.concreteKind
  );
}

/** The owner columns of the uniques relation, as the SQL renderer needs them. */
export type ClaimOwnerColumns = Readonly<{
  nodeId: Column;
  concreteKind: Column;
}>;

/**
 * THE SQL rendering of {@link isSameClaimOwner}, for the two upsert builders.
 *
 * `existing` qualifies a column of the conflicting row the way the dialect
 * requires (PostgreSQL needs the table name, SQLite takes the bare quoted
 * column); `proposed` renders the value being claimed — a bound parameter for
 * the single-row builder, an `excluded.` reference for the batch one. Two
 * renderings, one definition: the arms both builders decide ownership with are
 * this fragment, so a builder cannot quietly compare fewer columns than the
 * TypeScript predicate does.
 */
export function claimOwnerMatchesSql(
  existing: (column: Column) => SQL,
  proposed: (column: Column) => SQL,
  columns: ClaimOwnerColumns,
): SQL {
  return sql`${existing(columns.nodeId)} = ${proposed(columns.nodeId)} AND ${existing(columns.concreteKind)} = ${proposed(columns.concreteKind)}`;
}
