/**
 * The one owner of every SQL name the standard query compiler derives from a
 * caller's alias or output key.
 *
 * Each spelling here is part of the compiled SQL text (and of the column names
 * a custom executor reads), so changing one is a visible change to every
 * emitted statement. The collision decision over these names lives in
 * `sql-name-registry.ts`; this module only spells them.
 */
import { boundPgIdentifier } from "../../utils/identifier";
import { ALIAS_CTE_PREFIX } from "./schema";

/** The WITH-list relation that holds one alias's candidate rows: `cte_<alias>`. */
export function aliasCteName(alias: string): string {
  return `${ALIAS_CTE_PREFIX}${alias}`;
}

/**
 * The column that carries one physical column (or selected field) of an alias:
 * `<alias>_<column>`. Used for CTE columns, for full-projection output names
 * and for selective output names alike.
 */
export function aliasColumnName(alias: string, column: string): string {
  return `${alias}_${column}`;
}

/** The count fast path's per-traversal aggregate relation: `cte_<alias>_counts`. */
export function aliasCountCteName(nodeAlias: string): string {
  return `${aliasCteName(nodeAlias)}_counts`;
}

/** The count fast path's aggregate column for one alias. */
export function aliasCountColumnName(alias: string, distinct: boolean): string {
  return aliasColumnName(alias, distinct ? "count_distinct" : "count");
}

/** The physical node-table alias a late-materialized query re-joins: `lm_<alias>`. */
export function lateMaterializedPhysicalAlias(alias: string): string {
  return `lm_${alias}`;
}

/**
 * Builds a synthetic CTE column name for a selectively-extracted props field.
 *
 * Length-prefixes each component (`<length>:<value>`) rather than joining
 * `alias`/`field` on a bare `_`: alias and field are both attacker/user-controlled
 * strings that may themselves contain `_`, so naive concatenation lets two distinct
 * (alias, field) pairs collide on the same column name (e.g. alias="p_full",
 * field="name" vs. alias="p", field="full_name" would otherwise both produce
 * "__tg_p_full_name"). The length prefix makes the encoding unambiguous regardless
 * of what characters alias/field contain.
 *
 * The encoding is unbounded, but PostgreSQL truncates identifiers at 63 bytes,
 * so `boundPgIdentifier` hash-guards long names: two pairs whose encodings share
 * a >63-byte prefix would otherwise collapse onto the same physical column.
 * Short names are returned verbatim, preserving the readable `__tg_...` form.
 */
export function selectivePropsColumnName(
  alias: string,
  fieldName: string,
): string {
  const encoded = `__tg_${alias.length}:${alias}:${fieldName.length}:${fieldName}`;
  return boundPgIdentifier(encoded, `${alias}\0${fieldName}`);
}
