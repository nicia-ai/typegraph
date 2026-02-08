/**
 * AST Extractor - Extracts property access patterns from QueryAst.
 *
 * Walks the query AST to identify all property accesses and their
 * usage contexts (filter, sort, select, groupBy).
 */

import {
  type FieldRef,
  type NodePredicate,
  type OrderSpec,
  type PredicateExpression,
  type ProjectedField,
  type QueryAst,
  type SelectiveField,
} from "../query/ast";
import { jsonPointer } from "../query/json-pointer";
import {
  type ProfileEntityType,
  type PropertyTarget,
  type UsageContext,
} from "./types";

// ============================================================
// Extracted Access Type
// ============================================================

/**
 * A property access extracted from the AST.
 */
export type ExtractedAccess = Readonly<{
  /** Whether the access targets nodes or edges */
  entityType: ProfileEntityType;
  /** Expanded kind names for the alias */
  kindNames: readonly string[];
  /** The accessed target (props pointer or system field) */
  target: PropertyTarget;
  /** How the property was used */
  context: UsageContext;
  /** Predicate type if used in a filter (eq, contains, gt, etc.) */
  predicateType?: string;
}>;

// ============================================================
// Main Extraction Function
// ============================================================

/**
 * Extracts all property accesses from a QueryAst.
 *
 * Walks the AST to find all property references and categorizes
 * them by usage context (filter, sort, select, groupBy).
 *
 * @param ast - The query AST to analyze
 * @returns Array of extracted property accesses
 */
export function extractPropertyAccesses(
  ast: QueryAst,
): readonly ExtractedAccess[] {
  const accesses: ExtractedAccess[] = [];

  // Extract from predicates (filters)
  for (const predicate of ast.predicates) {
    const extracted = extractFromNodePredicate(predicate, ast);
    accesses.push(...extracted);
  }

  // Extract from orderBy (sorts)
  if (ast.orderBy) {
    for (const order of ast.orderBy) {
      const extracted = extractFromOrderSpec(order, ast);
      if (extracted) {
        accesses.push(extracted);
      }
    }
  }

  // Extract from projection (selects)
  for (const field of ast.projection.fields) {
    const extracted = extractFromProjectedField(field, ast);
    if (extracted) {
      accesses.push(extracted);
    }
  }

  // Extract from groupBy
  if (ast.groupBy) {
    for (const field of ast.groupBy.fields) {
      const extracted = extractFromFieldRef(field, "groupBy", ast);
      if (extracted) {
        accesses.push(extracted);
      }
    }
  }

  // Extract from having (if it exists)
  if (ast.having) {
    const havingAccesses = extractFromExpression(ast.having, undefined, ast);
    accesses.push(...havingAccesses);
  }

  // Extract from selective fields (smart select optimization)
  if (ast.selectiveFields) {
    for (const field of ast.selectiveFields) {
      const extracted = extractFromSelectiveField(field, ast);
      if (extracted) {
        accesses.push(extracted);
      }
    }
  }

  return accesses;
}

// ============================================================
// Predicate Extraction
// ============================================================

function extractFromNodePredicate(
  predicate: NodePredicate,
  ast: QueryAst,
): ExtractedAccess[] {
  return extractFromExpression(
    predicate.expression,
    predicate.targetAlias,
    ast,
  );
}

function extractFromExpression(
  expr: PredicateExpression,
  alias: string | undefined,
  ast: QueryAst,
): ExtractedAccess[] {
  const accesses: ExtractedAccess[] = [];

  switch (expr.__type) {
    case "comparison": {
      const extracted = extractFromFieldRef(expr.left, "filter", ast);
      if (extracted) {
        accesses.push({ ...extracted, predicateType: expr.op });
      }
      break;
    }

    case "string_op": {
      const extracted = extractFromFieldRef(expr.field, "filter", ast);
      if (extracted) {
        accesses.push({ ...extracted, predicateType: expr.op });
      }
      break;
    }

    case "null_check": {
      const extracted = extractFromFieldRef(expr.field, "filter", ast);
      if (extracted) {
        accesses.push({ ...extracted, predicateType: expr.op });
      }
      break;
    }

    case "between": {
      const extracted = extractFromFieldRef(expr.field, "filter", ast);
      if (extracted) {
        accesses.push({ ...extracted, predicateType: "between" });
      }
      break;
    }

    case "array_op": {
      const extracted = extractFromFieldRef(expr.field, "filter", ast);
      if (extracted) {
        accesses.push({ ...extracted, predicateType: expr.op });
      }
      break;
    }

    case "object_op": {
      const extracted = extractFromFieldRef(expr.field, "filter", ast);
      if (extracted) {
        accesses.push({ ...extracted, predicateType: expr.op });
      }
      break;
    }

    case "and":
    case "or": {
      for (const sub of expr.predicates) {
        accesses.push(...extractFromExpression(sub, alias, ast));
      }
      break;
    }

    case "not": {
      accesses.push(...extractFromExpression(expr.predicate, alias, ast));
      break;
    }

    case "aggregate_comparison": {
      // For aggregate comparisons, extract the field being aggregated
      const extracted = extractFromFieldRef(
        expr.aggregate.field,
        "filter",
        ast,
      );
      if (extracted) {
        accesses.push({
          ...extracted,
          predicateType: `${expr.aggregate.function}_${expr.op}`,
        });
      }
      break;
    }

    case "exists": {
      // Recursively extract from subquery
      const subAccesses = extractPropertyAccesses(expr.subquery);
      accesses.push(...subAccesses);
      break;
    }

    case "in_subquery": {
      // Extract from the field being checked
      const extracted = extractFromFieldRef(expr.field, "filter", ast);
      if (extracted) {
        accesses.push({ ...extracted, predicateType: "in_subquery" });
      }
      // Recursively extract from subquery
      const subAccesses = extractPropertyAccesses(expr.subquery);
      accesses.push(...subAccesses);
      break;
    }

    case "vector_similarity": {
      // Vector similarity is a special case - the field is an embedding
      // We track it but with a special predicate type
      const extracted = extractFromFieldRef(expr.field, "filter", ast);
      if (extracted) {
        accesses.push({ ...extracted, predicateType: "vector_similarity" });
      }
      break;
    }
  }

  return accesses;
}

// ============================================================
// Order/Projection Extraction
// ============================================================

function extractFromOrderSpec(
  order: OrderSpec,
  ast: QueryAst,
): ExtractedAccess | undefined {
  return extractFromFieldRef(order.field, "sort", ast);
}

function extractFromProjectedField(
  field: ProjectedField,
  ast: QueryAst,
): ExtractedAccess | undefined {
  if (field.source.__type === "aggregate") {
    // For aggregates, extract the field being aggregated
    return extractFromFieldRef(field.source.field, "select", ast);
  }
  return extractFromFieldRef(field.source, "select", ast);
}

/**
 * Extracts property access from a SelectiveField.
 *
 * SelectiveFields are used by the smart select optimization to track
 * which specific fields were accessed in the select callback.
 */
function extractFromSelectiveField(
  field: SelectiveField,
  ast: QueryAst,
): ExtractedAccess | undefined {
  // Skip system fields (id, kind, etc.) - they're always indexed
  if (field.isSystemField) {
    return undefined;
  }

  const resolved = resolveAliasToKinds(field.alias, ast);
  if (!resolved) {
    return undefined;
  }

  return {
    entityType: resolved.entityType,
    kindNames: resolved.kindNames,
    target: {
      __type: "prop",
      pointer: jsonPointer(field.field.split(".")),
    },
    context: "select",
  };
}

// ============================================================
// Field Reference Extraction
// ============================================================

function extractFromFieldRef(
  ref: FieldRef,
  context: UsageContext,
  ast: QueryAst,
): ExtractedAccess | undefined {
  const resolved = resolveAliasToKinds(ref.alias, ast);
  if (!resolved) {
    return undefined;
  }

  const target = extractTargetFromFieldRef(ref);
  if (!target) {
    return undefined;
  }

  return {
    entityType: resolved.entityType,
    kindNames: resolved.kindNames,
    target,
    context,
  };
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Resolves an alias to its expanded kind names.
 */
type ResolvedAliasKinds = Readonly<{
  entityType: ProfileEntityType;
  kindNames: readonly string[];
}>;

function resolveAliasToKinds(
  alias: string,
  ast: QueryAst,
): ResolvedAliasKinds | undefined {
  if (ast.start.alias === alias) {
    return { entityType: "node", kindNames: ast.start.kinds };
  }

  // Check traversals
  for (const traversal of ast.traversals) {
    if (traversal.nodeAlias === alias) {
      return { entityType: "node", kindNames: traversal.nodeKinds };
    }
    // Also check edge alias
    if (traversal.edgeAlias === alias) {
      return { entityType: "edge", kindNames: traversal.edgeKinds };
    }
  }

  return undefined;
}

/**
 * Extracts the accessed target from a FieldRef.
 */
function extractTargetFromFieldRef(ref: FieldRef): PropertyTarget | undefined {
  if (ref.jsonPointer) {
    return { __type: "prop", pointer: ref.jsonPointer };
  }

  // For props access without jsonPointer (shouldn't happen normally)
  if (ref.path.length > 1 && ref.path[0] === "props") {
    return { __type: "prop", pointer: jsonPointer(ref.path.slice(1)) };
  }

  if (ref.path.length === 1) {
    return { __type: "system", field: ref.path[0]! };
  }

  return undefined;
}
