import { GraphAllocationMismatchError } from "../errors";

/** Durable graph allocation identity. A restored backup retains it; a divergent fork rotates it. */
export type GraphAllocationOwner = Readonly<{
  origin: string;
  namespace: string;
}>;

/** Shared comparison for anchors, graph fences, and durable mutation evidence. */
export function sameGraphAllocationOwner(
  expected: GraphAllocationOwner,
  actual: GraphAllocationOwner | undefined,
): boolean {
  return (
    expected.origin === actual?.origin &&
    expected.namespace === actual.namespace
  );
}

export function assertGraphAllocationOwner(
  expected: GraphAllocationOwner,
  actual: GraphAllocationOwner | undefined,
  details: Readonly<Record<string, unknown>> = {},
): void {
  if (!sameGraphAllocationOwner(expected, actual))
    throw new GraphAllocationMismatchError({
      expectedOwner: expected,
      actualOwner: actual,
      ...details,
    });
}
