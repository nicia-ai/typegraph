/**
 * SQLite Dialect Adapter
 *
 * Implements dialect-specific SQL generation for SQLite databases.
 * Uses SQLite's JSON1 extension for JSON operations.
 */
import { type JsonPointer, parseJsonPointer } from "../json-pointer";
import { sql, type SqlFragment } from "../sql-fragment";
import { applyAggregateFilter } from "./aggregate-filter";
import { fts5Strategy } from "./fulltext-strategy";
import { likeEscapeClause } from "./like-escape";
import {
  DOUBLE_OVERFLOW_BOUNDARY,
  MAXIMUM_FINITE_DOUBLE_INTEGER,
  MAXIMUM_FINITE_DOUBLE_TEXT,
} from "./numeric-conversion";
import { getSqlDialectProfile, packSqlListValue } from "./profile";
import { type DialectAdapter } from "./types";

/**
 * Escapes a string for use in a SQLite string literal.
 * SQLite uses single quotes and escapes embedded single quotes by doubling them.
 */
function escapeSqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Converts a JSON pointer to SQLite's JSON path syntax.
 *
 * @example
 * "/name" → "$.\"name\""
 * "/items/0" → "$.\"items\"[0]"
 * "/a/b/c" → "$.\"a\".\"b\".\"c\""
 */
function toSqlitePath(pointer: JsonPointer): string {
  if (!pointer || pointer === "" || pointer === "/") {
    return "$";
  }

  const segments = parseJsonPointer(pointer);
  const parts: string[] = ["$"];

  for (const segment of segments) {
    if (isArrayIndex(segment)) {
      parts.push(`[${segment}]`);
    } else {
      // Quote the key to handle special characters
      parts.push(`.${JSON.stringify(segment)}`);
    }
  }

  return parts.join("");
}

/**
 * Returns a JSON path for an object property, even when the property name is a
 * numeric string. `toSqlitePath()` interprets numeric pointer segments as
 * array indexes, which is correct for query pointers but not for the
 * top-level object keys accepted by set-based patches.
 */
function toSqliteObjectPropertyPath(property: string): string {
  return `$.${JSON.stringify(property)}`;
}

// SQLite builds before 3.48 default to 127 function arguments. Each json_set
// replacement consumes a path/value pair in addition to the input document, so
// compose bounded calls instead of making schema breadth an engine-version
// dependency.
const JSON_SET_REPLACEMENTS_PER_CALL = 50;
const JSON_OBJECT_PAIRS_PER_CALL = 40;

function mergeJsonObjects(parts: readonly SqlFragment[]): SqlFragment {
  const [first, ...rest] = parts;
  if (first === undefined) return sql`json('{}')`;
  if (rest.length === 0) return first;
  return sql`json_patch(${first}, ${mergeJsonObjects(rest)})`;
}

/**
 * Checks if a JSON pointer segment is an array index.
 */
function isArrayIndex(segment: string): boolean {
  return /^\d+$/.test(segment);
}

/**
 * SQLite dialect adapter implementation.
 */
export const sqliteDialect: DialectAdapter = {
  safeNumericConversion(expression) {
    const trimmed = sql`trim(${expression})`;
    const wrapped = sql`'[' || ${trimmed} || ']'`;
    const exponentPosition = sql`instr(lower(${trimmed}), 'e')`;
    const exponent = sql`substr(${trimmed}, ${exponentPosition} + 1)`;
    const exponentDigits = sql`CASE WHEN substr(${exponent}, 1, 1) IN ('+', '-') THEN substr(${exponent}, 2) ELSE ${exponent} END`;
    const converted = sql`CAST(${trimmed} AS REAL)`;
    // Linux libSQL can parse decimal text between the exact maximum and the
    // binary64 overflow boundary as Infinity even though round-to-nearest must
    // produce Number.MAX_VALUE. Classify that narrow interval from the decimal
    // text so the fallback does not depend on another floating-point parse.
    const unsigned = sql`CASE WHEN substr(${trimmed}, 1, 1) = '-' THEN substr(${trimmed}, 2) ELSE ${trimmed} END`;
    const unsignedExponentPosition = sql`instr(lower(${unsigned}), 'e')`;
    const mantissa = sql`CASE WHEN ${unsignedExponentPosition} = 0 THEN ${unsigned} ELSE substr(${unsigned}, 1, ${unsignedExponentPosition} - 1) END`;
    const explicitExponent = sql`CASE WHEN ${unsignedExponentPosition} = 0 THEN 0 ELSE CAST(substr(${unsigned}, ${unsignedExponentPosition} + 1) AS INTEGER) END`;
    const decimalPosition = sql`instr(${mantissa}, '.')`;
    const integerDigits = sql`CASE WHEN ${decimalPosition} = 0 THEN length(${mantissa}) ELSE ${decimalPosition} - 1 END`;
    const digits = sql`replace(${mantissa}, '.', '')`;
    const significantDigits = sql`ltrim(${digits}, '0')`;
    const magnitudeExponent = sql`${explicitExponent} + ${integerDigits} - 1 - (length(${digits}) - length(${significantDigits}))`;
    const boundaryDigits = sql`substr(${significantDigits} || printf('%0309d', 0), 1, 309)`;
    const belowOverflowBoundary = sql`${significantDigits} = '' OR ${magnitudeExponent} < 308 OR (${magnitudeExponent} = 308 AND ${boundaryDigits} < ${DOUBLE_OVERFLOW_BOUNDARY})`;
    const roundsToMaximum = sql`${magnitudeExponent} = 308 AND ${boundaryDigits} >= ${MAXIMUM_FINITE_DOUBLE_INTEGER} AND ${boundaryDigits} < ${DOUBLE_OVERFLOW_BOUNDARY}`;
    const maximumFinite = sql`CAST(${MAXIMUM_FINITE_DOUBLE_TEXT} AS REAL)`;
    const signedMaximum = sql`CASE WHEN substr(${trimmed}, 1, 1) = '-' THEN -${maximumFinite} ELSE ${maximumFinite} END`;
    const finiteConversion = sql`CASE WHEN NOT (${belowOverflowBoundary}) THEN NULL WHEN abs(${converted}) <= ${maximumFinite} THEN ${converted} WHEN ${roundsToMaximum} THEN ${signedMaximum} ELSE NULL END`;
    return sql`CASE WHEN length(${trimmed}) <= 400 AND json_valid(${wrapped}) THEN CASE WHEN json_array_length(${wrapped}) = 1 AND json_type(${wrapped}, '$[0]') IN ('integer', 'real') AND (${exponentPosition} = 0 OR length(${exponentDigits}) BETWEEN 1 AND 3) THEN ${finiteConversion} ELSE NULL END ELSE NULL END`;
  },
  name: "sqlite",
  capabilities: {
    standardQueryStrategy: "cte_project",
    recursiveQueryStrategy: "recursive_cte",
    materializeIntermediateTraversalCtes: true,
    emitNotMaterializedHint: false,
    forceRecursiveWorktableOuterJoinOrder: true,
    vectorPredicateStrategy: "native",
    vectorMetrics: ["cosine", "l2"] as const,
    supportsFulltext: true,
    subgraphMembershipStrategy: "inline-cte",
  },

  binaryText(expression) {
    return expression;
  },

  analyzeTemporaryTable(): undefined {
    return;
  },

  setTransactionWorkingMemory(): undefined {
    // SQLite has no per-transaction working-memory budget to raise.
    return;
  },

  orderedRowsJsonArray(rowAlias, columns, orderColumn) {
    const row = sql.identifier(rowAlias);
    const objectParts = Array.from(
      { length: Math.ceil(columns.length / JSON_OBJECT_PAIRS_PER_CALL) },
      (_, index) => {
        const slice = columns.slice(
          index * JSON_OBJECT_PAIRS_PER_CALL,
          (index + 1) * JSON_OBJECT_PAIRS_PER_CALL,
        );
        const pairs = slice.flatMap((column) => [
          sql`${column}`,
          sql`${row}.${sql.identifier(column)}`,
        ]);
        return sql`json_object(${sql.join(pairs, sql`, `)})`;
      },
    );
    const object = mergeJsonObjects(objectParts);
    return sql`COALESCE((SELECT json_group_array(json(batch_json)) FROM (SELECT ${object} AS batch_json FROM ${row} ORDER BY ${row}.${sql.identifier(orderColumn)})), json('[]'))`;
  },

  orderedScalarJsonArray({ filter, orderBy, value, valueType }) {
    void valueType;
    const aggregate = sql`json_group_array(${value} ORDER BY ${sql.join(orderBy, sql`, `)})`;
    const filteredAggregate = applyAggregateFilter(aggregate, filter);
    return sql`COALESCE(${filteredAggregate}, json('[]'))`;
  },

  // ============================================================
  // JSON Path Operations
  // ============================================================

  compilePath(pointer) {
    // Use raw SQL to ensure the path is a literal, which allows expression
    // indexes on json_extract(...) to be used by the query planner.
    return sql.raw(escapeSqliteLiteral(toSqlitePath(pointer)));
  },

  jsonExtract(column, pointer) {
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  jsonExtractText(column, pointer) {
    // SQLite's json_extract returns the native JSON type, which works
    // for text comparisons. For explicit text, we use the same function.
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  jsonExtractNumber(column, pointer) {
    // SQLite json_extract returns numbers natively when the value is numeric
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  jsonExtractDouble(column, pointer) {
    // json_extract already yields INTEGER/REAL affinity for JSON numbers,
    // and SQLite arithmetic on those values is IEEE 754 double.
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  jsonExtractBoolean(column, pointer) {
    // SQLite json_extract returns 0/1 for boolean values
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  jsonExtractDate(column, pointer) {
    // SQLite stores dates as ISO strings, json_extract returns them as text
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  // ============================================================
  // JSON Array Operations
  // ============================================================

  jsonArrayLength(column) {
    return sql`json_array_length(${column})`;
  },

  jsonArrayContains(column, value) {
    return sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${value})`;
  },

  jsonArrayContainsAll(column, values) {
    if (values.length === 0) {
      return sql.raw("1=1");
    }
    const packedValues = JSON.stringify(values);
    return sql`
      NOT EXISTS (
            SELECT 1 FROM json_each(${packedValues}) AS tg_required
            WHERE NOT EXISTS (
              SELECT 1 FROM json_each(${column}) AS tg_actual
              WHERE tg_actual.value = tg_required.value
            )
          )
    `;
  },

  jsonArrayContainsAny(column, values) {
    if (values.length === 0) {
      return sql.raw("1=0");
    }
    const packedValues = JSON.stringify(values);
    return sql`
      EXISTS (
            SELECT 1
            FROM json_each(${column}) AS tg_actual
            JOIN json_each(${packedValues}) AS tg_wanted
              ON tg_actual.value = tg_wanted.value
          )
    `;
  },

  // ============================================================
  // JSON Object Operations
  // ============================================================

  jsonHasPath(column, pointer) {
    const path = toSqlitePath(pointer);
    return sql`json_type(${column}, ${sql.raw(escapeSqliteLiteral(path))}) IS NOT NULL`;
  },

  jsonPathIsNull(column, pointer) {
    const path = toSqlitePath(pointer);
    const pathSql = sql.raw(escapeSqliteLiteral(path));
    return sql`COALESCE(json_type(${column}, ${pathSql}) = 'null', 1)`;
  },

  jsonPathIsNumber(column, pointer) {
    const path = toSqlitePath(pointer);
    const pathSql = sql.raw(escapeSqliteLiteral(path));
    // json_type returns NULL for a missing path; COALESCE keeps the
    // predicate two-valued so negations don't silently drop rows.
    return sql`COALESCE(json_type(${column}, ${pathSql}) IN ('integer', 'real'), 0)`;
  },

  jsonPathIsNotNull(column, pointer) {
    const path = toSqlitePath(pointer);
    const pathSql = sql.raw(escapeSqliteLiteral(path));
    return sql`COALESCE(json_type(${column}, ${pathSql}) <> 'null', 0)`;
  },

  jsonScalarPathEquals(column, pointer, value) {
    const path = toSqlitePath(pointer);
    const pathSql = sql.raw(escapeSqliteLiteral(path));
    if (value === null) {
      return sql`json_type(${column}, ${pathSql}) = 'null'`;
    }
    if (typeof value === "boolean") {
      return sql`json_type(${column}, ${pathSql}) IN ('true', 'false') AND json_extract(${column}, ${pathSql}) = ${value ? 1 : 0}`;
    }
    if (typeof value === "number") {
      return sql`json_type(${column}, ${pathSql}) IN ('integer', 'real') AND json_extract(${column}, ${pathSql}) = ${value}`;
    }
    return sql`json_type(${column}, ${pathSql}) = 'text' AND json_extract(${column}, ${pathSql}) = ${value}`;
  },

  jsonSetProperties(column, patch, unsetProperties = []) {
    const entries = Object.entries(patch);
    let patchedColumn = column;
    for (
      let offset = 0;
      offset < entries.length;
      offset += JSON_SET_REPLACEMENTS_PER_CALL
    ) {
      const replacements = entries
        .slice(offset, offset + JSON_SET_REPLACEMENTS_PER_CALL)
        .flatMap(([property, value]) => [
          sql.raw(escapeSqliteLiteral(toSqliteObjectPropertyPath(property))),
          sql`json(${JSON.stringify(value)})`,
        ]);
      patchedColumn = sql`json_set(${patchedColumn}, ${sql.join(replacements, sql`, `)})`;
    }
    if (unsetProperties.length === 0) return patchedColumn;
    const removalPaths = unsetProperties.map((property) =>
      sql.raw(escapeSqliteLiteral(toSqliteObjectPropertyPath(property))),
    );
    return sql`json_remove(${patchedColumn}, ${sql.join(removalPaths, sql`, `)})`;
  },

  // ============================================================
  // Comparison Operations
  // ============================================================

  nullSafeEquals(left, right) {
    // SQLite's IS operator is null-safe equality (equivalent to = for
    // non-null operands, TRUE when both sides are NULL).
    return sql`${left} IS ${right}`;
  },

  inList(left, values, negated) {
    const operator = negated ? sql.raw("NOT IN") : sql.raw("IN");
    const packedValues = JSON.stringify(values);
    return sql`${left} ${operator} (SELECT value FROM json_each(${packedValues}))`;
  },

  inListParameter(left, packedValues, { negated }) {
    const operator = negated ? sql.raw("NOT IN") : sql.raw("IN");
    // Same packed shape as the literal `inList` above, with the JSON text
    // supplied by the caller's binding instead of baked in. SQLite's dynamic
    // typing makes `json_each.value` compare correctly against every extracted
    // column type, so the element type needs no cast here.
    return sql`${left} ${operator} (SELECT value FROM json_each(${packedValues}))`;
  },

  packListValue(values) {
    return packSqlListValue(values, "sqlite");
  },

  // ============================================================
  // String Operations
  // ============================================================

  ilike(column, pattern) {
    // SQLite LIKE is case-insensitive for ASCII by default, but we use
    // LOWER() for consistency with non-ASCII characters. SQLite has no default
    // LIKE escape character, so declare backslash explicitly to honor the
    // escaping the compiler applies to the pattern (parity with Postgres).
    return sql`LOWER(${column}) LIKE LOWER(${pattern}) ${likeEscapeClause}`;
  },

  // ============================================================
  // Set Operations
  // ============================================================

  wrapSetOperationOperand(inner) {
    // SQLite forbids parenthesized compound operands, but a FROM-subquery may
    // carry its own WITH clause, so wrap each operand as a subquery.
    return sql`SELECT * FROM (${inner})`;
  },

  // ============================================================
  // Recursive CTE Path Operations
  // ============================================================

  textJsonArray(values) {
    return sql`json_array(${sql.join(values, sql`, `)})`;
  },

  appendTextJsonArray(array, values) {
    const arguments_ = values.flatMap((value) => [sql`'$[#]'`, value]);
    return sql`json_insert(${array}, ${sql.join(arguments_, sql`, `)})`;
  },

  initializePath(nodeId) {
    // SQLite uses string-based paths with delimiters: '|id|'
    return sql`'|' || ${nodeId} || '|'`;
  },

  extendPath(currentPath, nodeId) {
    // Append: path || id || '|'
    return sql`${currentPath} || ${nodeId} || '|'`;
  },

  cycleCheck(nodeId, path) {
    // Check that id is NOT in path using INSTR
    // Returns TRUE if no cycle (id not found in path)
    return sql`INSTR(${path}, '|' || ${nodeId} || '|') = 0`;
  },

  // ============================================================
  // Value Binding & Literals
  // ============================================================

  bindValue(value) {
    return getSqlDialectProfile("sqlite").bindValue(value);
  },

  unboundedLimit() {
    return sql.raw("-1");
  },

  booleanLiteral(value) {
    return sql.raw(getSqlDialectProfile("sqlite").booleanLiteralString(value));
  },

  booleanLiteralString(value) {
    return getSqlDialectProfile("sqlite").booleanLiteralString(value);
  },

  quoteIdentifier(name) {
    // SQLite uses double quotes (or backticks), escape embedded quotes by doubling
    return `"${name.replaceAll('"', '""')}"`;
  },

  // ============================================================
  // Vector Operations
  // ============================================================

  // Compile-time gate for `field.similarTo(...)`; the active
  // `VectorStrategy` (sqlite-vec / libSQL-native) owns the distance SQL.
  supportsVectors: true,

  // ============================================================
  // Fulltext Operations
  // ============================================================

  fulltext: fts5Strategy,
};
