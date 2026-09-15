import type { SortDirection } from "./ast";

/** Resolves the portable null placement for an ordering specification. */
export function resolveNullOrdering(
  order: Readonly<{
    direction: SortDirection;
    nulls?: "first" | "last" | undefined;
  }>,
): "first" | "last" {
  return order.nulls ?? (order.direction === "asc" ? "last" : "first");
}
