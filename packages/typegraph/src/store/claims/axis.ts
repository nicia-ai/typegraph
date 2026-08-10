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
import { ConfigurationError } from "../../errors";
import { type KindRegistry } from "../../registry/kind-registry";
import { compareStrings } from "../../utils/compare";

/**
 * The one code point an axis component may not contain, written as an escape
 * so it can never be mistaken for whitespace in a diff.
 *
 * Axes that are not kinds are built by joining with it — the disjointness pair
 * axis below is the first — so a kind or constraint name containing it could
 * spell a reserved axis and take a claim row the fence assigns to something
 * else. {@link assertClaimAxisSafe} is what makes that unspellable, at
 * graph-definition time.
 */
const AXIS_SEPARATOR = "\u001E";

/** The prefix marking an axis as a disjoint PAIR rather than as a kind. */
const DISJOINT_AXIS_PREFIX = `${AXIS_SEPARATOR}disjoint${AXIS_SEPARATOR}`;

/**
 * The `constraint_name` every disjointness claim is written under.
 *
 * Reserved rather than derived: it is what tells the claim seam that a refusal
 * on this row is a `DisjointError` and not a `UniquenessError`, and what tells
 * a reader of the relation that this row's `node_kind` is a pair label rather
 * than a kind. {@link assertClaimAxisSafe} is what guarantees no declared
 * constraint can carry the same name.
 */
export const DISJOINT_CONSTRAINT_NAME = `${AXIS_SEPARATOR}disjointWith`;

/**
 * THE axis a disjointness claim is written at: the registry's own canonical
 * pair label, prefixed so it cannot collide with a kind.
 *
 * A fold of `KindRegistry.disjointPairLabel` rather than a second
 * normalization of the same pair — the two kinds of one disjoint pair must
 * compute ONE string, or their claims sit on two rows that can never collide
 * and the fence refuses nothing.
 *
 * Pairwise, and deliberately not per component: the registry's disjoint pairs
 * are literal unordered pairs and disjointness is not transitive here, so an
 * axis keyed on a connected component would refuse an `A`/`C` pair under
 * `A⊥B, B⊥C` that the graph never declared disjoint.
 */
export function disjointnessClaimAxis(
  kind: string,
  otherKind: string,
  registry: KindRegistry,
): string {
  return `${DISJOINT_AXIS_PREFIX}${registry.disjointPairLabel(kind, otherKind)}`;
}

/**
 * Refuses a kind name or constraint name that could spell a reserved claim
 * axis or the reserved disjointness constraint name.
 *
 * Runs at graph-definition time, the one gate every kind and every declared
 * constraint passes before a claim can be written for it — so the reserved
 * vocabulary is unspellable by construction rather than re-checked at each
 * write, and the claim seam can read "this refusal is a disjointness refusal"
 * off the reserved constraint name without a caller being able to forge it. A
 * new refusal, on an input no real schema carries.
 *
 * `subject` names the ROLE (`Node kind`, `Unique constraint`); the name itself
 * is quoted through `JSON.stringify` so the offending code point reads as an
 * escape instead of as an invisible character.
 */
export function assertClaimAxisSafe(name: string, subject: string): void {
  if (!name.includes(AXIS_SEPARATOR)) return;
  throw new ConfigurationError(
    `${subject} name ${JSON.stringify(name)} contains U+001E, which TypeGraph reserves for claim axes.`,
    { name },
    {
      suggestion: `Rename it without the U+001E (record separator) character.`,
    },
  );
}

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

/** The relation a claim row lives in. */
type ClaimRelation = "uniques";

/** A claim row named in full — the row a statement is about to lock. */
export type ClaimTarget = Readonly<{
  relation: ClaimRelation;
  graphId: string;
  axis: string;
  constraintName: string;
  key: string;
}>;

/**
 * THE canonical order claims are acquired in: code-point compare on
 * `(relation, graphId, axis, constraintName, key)`.
 *
 * Two writers that take the same two claim rows in opposite orders deadlock,
 * and PostgreSQL resolves that by aborting one with `40P01` — which would turn
 * an import's per-row recovery into a whole-batch abort. Sorting every claim
 * statement's entries by one comparator removes the commonest cycle, exactly as
 * multi-graph lock acquisition already does (see `recorded-capture.ts`, whose
 * comment states the same rule: every process must acquire in the same order).
 *
 * The order it establishes is per claim SET and per statement, not per
 * transaction: rows and batches inside one import claim in input order, so two
 * concurrent lock-free imports into one graph can still deadlock. That residual
 * is declared out of contract rather than fenced here.
 */
export function compareClaimTargets(
  left: ClaimTarget,
  right: ClaimTarget,
): number {
  return (
    compareStrings(left.relation, right.relation) ||
    compareStrings(left.graphId, right.graphId) ||
    compareStrings(left.axis, right.axis) ||
    compareStrings(left.constraintName, right.constraintName) ||
    compareStrings(left.key, right.key)
  );
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
