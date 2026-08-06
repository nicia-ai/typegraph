import { EDGE_IDENTITY_MISMATCH_CODE, ValidationError } from "../../errors";

/** The immutable identity a collection-scoped edge write expects to own. */
export type EdgeIdentityExpectation = Readonly<{
  kind: string;
  fromKind?: string;
  fromId?: string;
  toKind?: string;
  toId?: string;
}>;

export type EdgeIdentity = Readonly<{
  kind: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
}>;

export function edgeIdentityFromRow(row: {
  kind: string;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
}): EdgeIdentity {
  return {
    kind: row.kind,
    fromKind: row.from_kind,
    fromId: row.from_id,
    toKind: row.to_kind,
    toId: row.to_id,
  };
}

/**
 * The single owner of edge-id ownership validation.
 *
 * Edge ids are graph-global, while public collections are kind-scoped and an
 * edge's endpoints are immutable. Every collection write calls this predicate
 * before it consumes a row, and write operations repeat it against their
 * transactional re-read so a concurrent change cannot bypass the contract.
 */
export function assertEdgeIdentityMatches(
  id: string,
  expected: EdgeIdentityExpectation,
  actual: EdgeIdentity,
  operation: "update" | "delete" | "hardDelete",
): void {
  const mismatches = [
    expected.kind === actual.kind ? undefined : "kind",
    expected.fromKind === undefined || expected.fromKind === actual.fromKind ?
      undefined
    : "from.kind",
    expected.fromId === undefined || expected.fromId === actual.fromId ?
      undefined
    : "from.id",
    expected.toKind === undefined || expected.toKind === actual.toKind ?
      undefined
    : "to.kind",
    expected.toId === undefined || expected.toId === actual.toId ?
      undefined
    : "to.id",
  ].filter((path): path is string => path !== undefined);
  if (mismatches.length === 0) return;

  throw new ValidationError(
    `Edge "${id}" belongs to ${actual.kind} ` +
      `(${actual.fromKind}/${actual.fromId} -> ${actual.toKind}/${actual.toId}), ` +
      `not ${expected.kind}` +
      (expected.fromKind === undefined ?
        "."
      : ` (${expected.fromKind}/${expected.fromId} -> ${expected.toKind}/${expected.toId}).`),
    {
      entityType: "edge",
      kind: expected.kind,
      operation,
      id,
      issues: mismatches.map((path) => ({
        path,
        message: "The edge id resolves to a different immutable identity",
        code: EDGE_IDENTITY_MISMATCH_CODE,
      })),
    },
    {
      suggestion:
        "Use the edge collection and endpoints that created this id, or choose a new id.",
    },
  );
}
