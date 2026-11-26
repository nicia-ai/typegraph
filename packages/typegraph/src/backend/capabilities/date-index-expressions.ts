/**
 * The `dateIndexExpressions` capability gate: refuses a declared index that
 * reads a date-typed property on a backend that cannot build one, before any
 * DDL runs.
 */
import { UnsupportedBackendCapabilityError } from "../../errors";
import { findDateIndexExpression } from "../../indexes/compiler";
import { type IndexDeclaration } from "../../indexes/types";
import { type BackendCapabilities } from "../types";

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
