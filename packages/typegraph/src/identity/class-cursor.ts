import { type ReadCoordinate } from "../core/temporal";
import { ValidationError } from "../errors";
import { decodeCursor, encodeCursor } from "../query/cursor";
import { compareCodePoints } from "../utils/compare";
import { type PlainNodeRef } from "./sql-target";

const IDENTITY_CLASS_CURSOR_COLUMNS = [
  "identity.classes.scope",
  "identity.classes.kind",
  "identity.classes.id",
] as const;

/** Scope required to resume an identity class page. */
export type IdentityClassCursorScope = Readonly<{
  graphId: string;
  coordinate: ReadCoordinate | undefined;
  kinds: readonly string[];
}>;

function identityClassCursorScope(scope: IdentityClassCursorScope): string {
  const coordinate = scope.coordinate;
  const canonicalScope = JSON.stringify([
    "identity-classes",
    scope.graphId,
    coordinate?.valid.mode ?? "current",
    coordinate?.valid.asOf,
    coordinate?.recorded?.asOf,
    [...new Set(scope.kinds)].toSorted((left, right) =>
      compareCodePoints(left, right),
    ),
  ]);
  return fnv1a128Hex(canonicalScope);
}

/** Fixed-width FNV-1a digest keeps cursor size independent of kind count. */
function fnv1a128Hex(input: string): string {
  const mask = (1n << 128n) - 1n;
  let hash = 0x6c_62_27_2e_07_bb_01_42_62_b8_21_75_62_95_c5_8dn;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x00_00_00_00_01_00_00_00_00_00_00_00_00_00_01_3bn) & mask;
  }
  return hash.toString(16).padStart(32, "0");
}

/** Encode a class representative together with the query scope that produced it. */
export function encodeIdentityClassCursor(
  scope: IdentityClassCursorScope,
  representative: PlainNodeRef,
): string {
  return encodeCursor({
    v: 1,
    d: "f",
    cols: IDENTITY_CLASS_CURSOR_COLUMNS,
    vals: [
      encodeURIComponent(identityClassCursorScope(scope)),
      encodeURIComponent(representative.kind),
      encodeURIComponent(representative.id),
    ],
  });
}

/** Decode a cursor only when it belongs to the requested graph, coordinate, and kinds. */
export function decodeIdentityClassCursor(
  cursor: string,
  scope: IdentityClassCursorScope,
): PlainNodeRef {
  const decoded = decodeCursor(cursor);
  const [encodedScope, kind, id] = decoded.vals;
  if (
    decoded.v !== 1 ||
    decoded.d !== "f" ||
    decoded.vals.length !== IDENTITY_CLASS_CURSOR_COLUMNS.length ||
    decoded.cols.length !== IDENTITY_CLASS_CURSOR_COLUMNS.length ||
    !decoded.cols.every(
      (column, index) => column === IDENTITY_CLASS_CURSOR_COLUMNS[index],
    ) ||
    typeof encodedScope !== "string" ||
    encodedScope !== encodeURIComponent(identityClassCursorScope(scope)) ||
    typeof kind !== "string" ||
    typeof id !== "string" ||
    kind.length === 0 ||
    id.length === 0
  ) {
    throw new ValidationError(
      "Identity class cursor does not match this graph, coordinate, or kind filter.",
      {
        issues: [
          {
            path: "cursor",
            message: "Use a cursor returned by the same identity class scan.",
          },
        ],
      },
    );
  }
  try {
    return { kind: decodeURIComponent(kind), id: decodeURIComponent(id) };
  } catch (error) {
    throw new ValidationError(
      "Identity class cursor contains an invalid reference.",
      {
        issues: [
          {
            path: "cursor",
            message: "Use a cursor returned by the same identity class scan.",
          },
        ],
      },
      { cause: error },
    );
  }
}
