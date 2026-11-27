/**
 * The `dateIndexExpressions` capability gate: refuses a declared index that
 * reads a date-typed property on a backend that cannot build one, before any
 * DDL runs.
 */
import { UnsupportedBackendCapabilityError } from "../../errors";
import { findDateIndexExpression } from "../../indexes/compiler";
import { type IndexDeclaration } from "../../indexes/types";
import { type SqlDialect } from "../../query/dialect/types";
import {
  type BackendCapabilities,
  POSTGRES_CAPABILITIES,
  SQLITE_CAPABILITIES,
} from "../types";

const POSITION_LABELS = {
  key: "key",
  coveringField: "covering column",
  where: "partial-index where clause",
} as const;

/**
 * Throws `UnsupportedBackendCapabilityError` for the first declaration that
 * reads a date-typed property when `capabilities.dateIndexExpressions` is
 * `false`. Absent or `true` accepts every declaration.
 *
 * `operation` names the caller's public entry point, so the refusal says
 * which call was refused. Every path that turns a declaration into index DDL
 * on a capability-bearing target calls this one function; the classification
 * itself is {@link findDateIndexExpression}.
 */
export function assertDateIndexExpressionsSupported(
  capabilities: BackendCapabilities,
  declarations: readonly IndexDeclaration[],
  operation: string,
): void {
  if (capabilities.dateIndexExpressions !== false) return;
  for (const declaration of declarations) {
    if (declaration.entity === "vector") continue;
    const found = findDateIndexExpression(declaration);
    if (found === undefined) continue;
    throw new UnsupportedBackendCapabilityError(
      operation,
      "dateIndexExpressions",
      {
        entity: declaration.entity,
        kind: declaration.kind,
        indexName: declaration.name,
        field: found.field,
        position: found.position,
      },
      "Remove the date-typed field from the index declaration, or index a string-encoded copy of the value instead.",
      ` Index "${declaration.name}" on ${declaration.entity} kind "${declaration.kind}" reads date-typed field "${found.field}" in its ${POSITION_LABELS[found.position]}; this backend cannot build an index over a date property (on PostgreSQL, the text-to-timestamptz cast it needs is not immutable).`,
    );
  }
}

/**
 * The capabilities a bundled backend of each dialect declares, for the entry
 * points that turn a declaration into DDL for a dialect with no backend in
 * hand (`generateIndexDDL`, the PostgreSQL Drizzle schema and its index
 * builders). Those emit DDL for the bundled engine, so its declaration
 * decides; a store-owned path decides on its own backend's capabilities.
 */
const BUNDLED_DIALECT_CAPABILITIES: Readonly<
  Record<SqlDialect, BackendCapabilities>
> = {
  postgres: POSTGRES_CAPABILITIES,
  sqlite: SQLITE_CAPABILITIES,
};

/**
 * {@link assertDateIndexExpressionsSupported} against the bundled backend of
 * `dialect`, for a DDL entry point that has a dialect but no backend.
 */
export function assertBundledDialectDateIndexExpressionsSupported(
  dialect: SqlDialect,
  declarations: readonly IndexDeclaration[],
  operation: string,
): void {
  assertDateIndexExpressionsSupported(
    BUNDLED_DIALECT_CAPABILITIES[dialect],
    declarations,
    operation,
  );
}
