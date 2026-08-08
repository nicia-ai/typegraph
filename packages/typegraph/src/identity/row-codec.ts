import { ConfigurationError } from "../errors";
import { canonicalizeDatabaseTimestamp } from "../utils/date";
import { type IdentityTransferAssertion } from "./service-types";
import { type IdentityAssertionStorageRow } from "./storage-types";

export type RawIdentityAssertionRow = Readonly<{
  graph_id: string;
  id: string;
  rel: "same" | "different";
  a_kind: string;
  a_id: string;
  b_kind: string;
  b_id: string;
  valid_from: unknown;
  valid_to: unknown;
  created_at: unknown;
  updated_at: unknown;
  deleted_at: unknown;
  ended_by_kind: string | null | undefined;
  ended_by_id: string | null | undefined;
}>;

export function toCanonicalIdentityTimestamp(value: unknown): string {
  const canonical = canonicalizeDatabaseTimestamp(value);
  if (canonical === undefined) {
    throw new ConfigurationError(
      "Identity relation returned a timestamp that is not a representable instant.",
      { value },
      {
        suggestion:
          "Inspect the identity assertion rows for a corrupt timestamp column.",
      },
    );
  }
  return canonical;
}

export function optionalIdentityTimestamp(value: unknown): string | undefined {
  return value === undefined || value === null ?
      undefined
    : toCanonicalIdentityTimestamp(value);
}

export function normalizeIdentityAssertionRow(
  row: RawIdentityAssertionRow,
): IdentityAssertionStorageRow {
  return {
    graph_id: row.graph_id,
    id: row.id,
    rel: row.rel,
    a_kind: row.a_kind,
    a_id: row.a_id,
    b_kind: row.b_kind,
    b_id: row.b_id,
    valid_from: toCanonicalIdentityTimestamp(row.valid_from),
    valid_to: optionalIdentityTimestamp(row.valid_to),
    created_at: toCanonicalIdentityTimestamp(row.created_at),
    updated_at: toCanonicalIdentityTimestamp(row.updated_at),
    deleted_at: optionalIdentityTimestamp(row.deleted_at),
    ended_by_kind: row.ended_by_kind ?? undefined,
    ended_by_id: row.ended_by_id ?? undefined,
  };
}

export function toTransferAssertion(
  row: IdentityAssertionStorageRow,
): IdentityTransferAssertion {
  return {
    id: row.id,
    relation: row.rel,
    a: { kind: row.a_kind, id: row.a_id },
    b: { kind: row.b_kind, id: row.b_id },
    validFrom: row.valid_from,
    ...(row.valid_to === undefined ? {} : { validTo: row.valid_to }),
    ...(row.ended_by_kind === undefined || row.ended_by_id === undefined ?
      {}
    : { endedBy: { kind: row.ended_by_kind, id: row.ended_by_id } }),
  };
}
