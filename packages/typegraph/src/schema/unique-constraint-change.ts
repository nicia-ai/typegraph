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
import { canonicalEqual } from "./canonical";

/** How a declaration differs from the one its name carried before. */
export type UniqueConstraintEnforcementChange = "added" | "reshaped";

/**
 * `"added"` when `existing` declares no constraint named like `next`,
 * `"reshaped"` when it declares one whose remaining members differ, and
 * `undefined` when the declaration is unchanged.
 *
 * Shapes are compared with `canonicalEqual` so key order — and an absent
 * member versus one explicitly `undefined` — never reads as a reshape.
 */
export function uniqueConstraintEnforcementChange<
  C extends Readonly<{ name: string }>,
>(
  existing: readonly C[],
  next: C,
): UniqueConstraintEnforcementChange | undefined {
  const previous = existing.find((constraint) => constraint.name === next.name);
  if (previous === undefined) return "added";
  const { name: _previousName, ...previousShape } = previous;
  const { name: _nextName, ...nextShape } = next;
  return canonicalEqual(previousShape, nextShape) ? undefined : "reshaped";
}
