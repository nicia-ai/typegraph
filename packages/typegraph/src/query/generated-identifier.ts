/**
 * The one owner of every SQL identifier the query layer derives from caller
 * text.
 *
 * Query aliases are validated to at most 63 characters, but the compiler
 * builds further identifiers from them — `<alias>_<column>` output columns,
 * `cte_<alias>` common table expressions, `<alias>_<field>` projections,
 * default `<alias>_depth` / `<alias>_path` columns — and PostgreSQL clips
 * every identifier to 63 bytes. Two generated names that differed only past
 * byte 63 used to become one identifier there (an "ambiguous column" error,
 * or a read of the wrong column), while SQLite kept them apart.
 *
 * Every generated name therefore passes through {@link generatedIdentifier}:
 * a name that fits is returned verbatim, so compiled SQL for ordinary aliases
 * is byte-for-byte what it always was; a longer name is shortened by bytes and
 * suffixed with a hash of the FULL name, so distinct names stay distinct and
 * the same query always compiles to the same SQL. The bound is applied on
 * every backend — SQLite has no identifier limit of its own, but compiling the
 * same text everywhere keeps a query valid on one backend valid on the other.
 *
 * Emitters and result decoders both call these functions: a decoder that
 * re-spelled `${alias}_id` would look up a column the shortened SQL never
 * returned.
 */
import { boundPgIdentifier } from "../utils/identifier";
import { sql, type SqlFragment } from "./sql-fragment";

/** Prefix of the per-alias common table expression (`cte_<alias>`). */
const ALIAS_CTE_PREFIX = "cte_";

/**
 * Bounds a generated identifier to the strictest backend limit (PostgreSQL's
 * 63 bytes). Identity for names that already fit.
 */
export function generatedIdentifier(name: string): string {
  return boundPgIdentifier(name, name);
}

/** The column an alias's `column` is projected as: `<alias>_<column>`. */
export function aliasColumnName(alias: string, column: string): string {
  return generatedIdentifier(`${alias}_${column}`);
}

/** The name of an alias's common table expression: `cte_<alias>`. */
export function aliasCteName(alias: string): string {
  return generatedIdentifier(`${ALIAS_CTE_PREFIX}${alias}`);
}

/** {@link aliasColumnName} as an unquoted SQL fragment. */
export function rawAliasColumn(alias: string, column: string): SqlFragment {
  return sql.raw(aliasColumnName(alias, column));
}

/** {@link aliasCteName} as an unquoted SQL fragment. */
export function rawAliasCte(alias: string): SqlFragment {
  return sql.raw(aliasCteName(alias));
}
