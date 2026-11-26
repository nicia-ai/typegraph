import type { FieldRef, OrderSpec, Traversal } from "../ast";

/** The parts of a query that decide what identifies one of its match rows. */
export type RowIdentityScope = Readonly<{
  startAlias: string;
  startKinds: readonly string[];
  traversals: readonly Pick<Traversal, "edgeAlias" | "optional">[];
}>;

/** An ordering term that reads a field, not a database expression. */
export type FieldOrderSpec = Omit<OrderSpec, "field"> &
  Readonly<{ field: FieldRef }>;

/**
 * The ordering terms that identify a match row, minus those `orderBy` already
 * names, in the order they follow it. Appended after a non-unique sort they
 * make it a total order, so a keyset position never skips or repeats a row
 * that ties on every other term.
 *
 * A row is one start node together with one match per traversal, so its
 * identity is the start node's plus, per traversal, the matched edge's id: an
 * edge id is unique in the graph and determines the node it leads to, and two
 * parallel edges between one pair of nodes are two rows. The start node's
 * identity is `(kind, id)` when the start alias spans more than one kind and
 * `id` alone otherwise. A query with no traversal keeps the start node's
 * identity alone.
 *
 * The one owner of that identity: cursor pagination's keyset and the
 * selection order of a full-text, vector or hybrid statement
 * (`describeSelectionOrder`) both read it.
 */
export function missingRowIdentityOrder(
  orderBy: readonly OrderSpec[],
  scope: RowIdentityScope,
): readonly FieldOrderSpec[] {
  function missingIdentityKey(
    alias: string,
    fieldName: "kind" | "id",
    nullable: boolean,
  ): readonly FieldOrderSpec[] {
    const named = orderBy.some(
      (spec) =>
        spec.field.__type === "field_ref" &&
        spec.field.alias === alias &&
        spec.field.path.length === 1 &&
        spec.field.path[0] === fieldName &&
        spec.field.jsonPointer === undefined,
    );
    if (named) return [];
    return [
      {
        field: {
          __type: "field_ref",
          alias,
          nullable,
          path: [fieldName],
          valueType: "string",
        },
        direction: "asc",
      },
    ];
  }
  return [
    ...(scope.startKinds.length > 1 ?
      missingIdentityKey(scope.startAlias, "kind", false)
    : []),
    ...missingIdentityKey(scope.startAlias, "id", false),
    ...scope.traversals.flatMap((traversal) =>
      missingIdentityKey(traversal.edgeAlias, "id", traversal.optional),
    ),
  ];
}
