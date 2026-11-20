/**
 * Whether a unique-constraint declaration changes what existing rows owe.
 *
 * A uniqueness constraint is enforced by claim rows written alongside each
 * node write. A constraint that is new, or whose shape differs from the one
 * its name carried before, is a constraint no existing row has a claim for —
 * so it can only be declared on a kind that holds no rows. Both the
 * graph-extension classifier (`Store.evolve` / `planEvolution`) and the
 * schema-commit preflight ask this question, about two different serialized
 * shapes of the same declaration; this is the one place it is answered.
 */
import { type Collation, type UniquenessScope } from "../core/types";
import {
  type UniqueConstraintDefaults,
  withUniqueConstraintDefaults,
} from "../core/unique-constraint-options";
import { canonicalEqual } from "./canonical";

/** How a declaration differs from the one its name carried before. */
export type UniqueConstraintEnforcementChange = "added" | "reshaped";

type UniqueConstraintDeclaration = Readonly<{
  name: string;
  scope?: UniquenessScope | undefined;
  collation?: Collation | undefined;
}>;

function enforcedShape(
  constraint: UniqueConstraintDeclaration,
  defaults: UniqueConstraintDefaults,
): Readonly<Record<string, unknown>> {
  const { name: _name, ...shape } = withUniqueConstraintDefaults(
    constraint,
    defaults,
  );
  return shape;
}

/**
 * `"added"` when `existing` declares no constraint named like `next`,
 * `"reshaped"` when it declares one whose remaining members differ, and
 * `undefined` when the declaration is unchanged.
 *
 * Shapes are compared with `canonicalEqual` in their enforced form — an
 * omitted `scope` or `collation` read as `defaults`, the ones of the document
 * shape both sides come from — so key order, an absent member versus one
 * explicitly `undefined`, and an implied default versus the same value
 * written out never read as a reshape.
 */
export function uniqueConstraintEnforcementChange<
  C extends UniqueConstraintDeclaration,
>(
  existing: readonly C[],
  next: C,
  defaults: UniqueConstraintDefaults,
): UniqueConstraintEnforcementChange | undefined {
  const previous = existing.find((constraint) => constraint.name === next.name);
  if (previous === undefined) return "added";
  return (
      canonicalEqual(
        enforcedShape(previous, defaults),
        enforcedShape(next, defaults),
      )
    ) ?
      undefined
    : "reshaped";
}
