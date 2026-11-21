/**
 * Records in a standard statement's SQL-name registry the columns its outer
 * clauses read by name, in the relation each one is read from.
 *
 * Joins, frontiers, relevance scoping and the late-materialization keys record
 * their own references where they write them (see `standard-builders.ts`).
 * The projection, grouping, ordering, result predicate and HAVING compile
 * field references through the shared predicate compiler, which spells
 * `<relation>.<alias>_<column>` without knowing about the registry; this module
 * records those reads from the same clause enumeration column pruning uses
 * (`visitOuterClauseFields`), so the two cannot disagree about which clauses
 * read a column.
 */
import type { FieldRef, QueryAst } from "../../ast";
import { aliasCteName, selectivePropsColumnName } from "../alias-names";
import {
  referenceAliasColumn,
  type SqlStatementNames,
} from "../sql-name-registry";
import { visitOuterClauseFields } from "../standard-pass-pipeline";
import { findSelectivePropsFieldForFieldRef } from "../utils";
import { buildAliasToCteMap } from "./standard-builders";

type ReferenceOuterClauseColumnsInput = Readonly<{
  ast: QueryAst;
  /** The single CTE the outer FROM reads when a linear traversal collapses. */
  collapsedTraversalCteAlias?: string | undefined;
  /** Whether the outer SELECT list reads the alias columns of its fields. */
  includeProjection: boolean;
  names: SqlStatementNames;
}>;

/** The physical column a compiled field reference names: `<alias>_<column>`. */
function fieldColumn(field: FieldRef): string | undefined {
  if (field.path.length === 0) return undefined;
  return field.path[0] === "props" ? "props" : field.path.join("_");
}

/**
 * Records every alias column the outer clauses of `ast` read by name, and
 * every output alias an aggregate `ORDER BY` names.
 */
export function referenceOuterClauseColumns(
  input: ReferenceOuterClauseColumnsInput,
): void {
  const { ast, collapsedTraversalCteAlias, includeProjection, names } = input;
  const aliasToCte = buildAliasToCteMap(ast);

  /**
   * The relations a field of `alias` is read from: the collapsed CTE or the
   * alias's own, and the alias's own CTE name, which a correlated subquery
   * names directly.
   */
  function relationsFor(alias: string): readonly string[] {
    const own = aliasToCte.get(alias) ?? aliasCteName(alias);
    return [...new Set([collapsedTraversalCteAlias ?? own, own])];
  }

  visitOuterClauseFields(ast, { includeProjection }, (field, use) => {
    const selective =
      use === "order-by-field" ?
        findSelectivePropsFieldForFieldRef(ast.selectiveFields, field)
      : undefined;
    for (const relation of relationsFor(field.alias)) {
      if (selective !== undefined) {
        // Ordering by a field the selective projection extracts reads that
        // extracted column instead of the alias's own columns.
        names
          .relationColumns(relation)
          .reference(
            selectivePropsColumnName(selective.alias, selective.field),
          );
        continue;
      }
      const column = fieldColumn(field);
      if (column !== undefined)
        referenceAliasColumn(names, relation, field.alias, column);
    }
  });

  // `ORDER BY "<output alias>"`: SQLite resolves it without regard to case.
  for (const order of ast.aggregateOrderBy ?? [])
    names.results.reference(order.outputName);
}
