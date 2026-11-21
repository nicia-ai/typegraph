import type { GraphBackend, TransactionBackend } from "../../backend/types";
import {
  ConfigurationError,
  SchemaChangedError,
  ValidationError,
} from "../../errors";
import type { QueryAst } from "../ast";
import { buildStandardOrderBy } from "../compiler/emitter/standard-builders";
import {
  extractFulltextMatchPredicates,
  extractVectorSimilarityPredicates,
} from "../compiler/predicates";
import { getDialect } from "../dialect";
import {
  aliasColumnName,
  bindGeneratedIdentifiers,
  generatedColumnsOf,
  restoreGeneratedColumns,
} from "../generated-identifier";
import { sql, type SqlFragment } from "../sql-fragment";
import { asCompiledSelectSql, type CompiledSelectSql } from "../sql-intent";

export type SchemaCheckedReadInput = Readonly<{
  backend: GraphBackend | TransactionBackend;
  ast: QueryAst;
  graphId: string;
  expectedVersion: number | undefined;
  compile: () => CompiledSelectSql;
  /** Non-null result column used to distinguish a real row from the envelope sentinel. */
  rowIdentityColumn?: string;
  /** Ordering over explicitly projected columns in the checked_rows envelope. */
  resultOrderBy?: SqlFragment;
}>;

/** A version row survives even an empty data result; both reads share one SQL snapshot. */
export async function executeSchemaCheckedRead(
  input: SchemaCheckedReadInput,
): Promise<readonly Record<string, unknown>[]> {
  const { backend, ast, graphId, expectedVersion } = input;
  if (
    expectedVersion !== undefined &&
    (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
  ) {
    throw new ValidationError(
      "Expected schema version must be a non-negative safe integer",
      {
        issues: [
          { path: "expectedSchemaVersion", message: "Invalid schema version" },
        ],
      },
    );
  }
  const table = backend.tableNames?.schemaVersions;
  if (table === undefined) {
    throw new ConfigurationError(
      "Checked reads require backend.tableNames.schemaVersions",
      { capability: "schemaVersions" },
    );
  }
  if (
    ast.traversals.some(
      (traversal) => traversal.variableLength !== undefined,
    ) ||
    extractFulltextMatchPredicates(ast.predicates).length > 0 ||
    extractVectorSimilarityPredicates(ast.predicates).length > 0
  ) {
    throw new ConfigurationError(
      "Checked reads support relational queries; recursive and relevance queries require a separate schema probe",
      { operation: "executeChecked" },
    );
  }
  // Every full-projection column contains the alias/field separator "_".
  // An envelope name without that separator cannot collide with data columns.
  const marker = "typegraphschemaversion";
  const dialect = getDialect(backend.dialect);
  const compiled = input.compile();
  // The envelope orders by the compiled statement's own columns, so it
  // spells them with the physical names that statement allocated.
  const standardOrderBy = buildStandardOrderBy({
    ast,
    dialect,
    collapsedTraversalCteAlias: "checked_rows",
  });
  const orderBy =
    input.resultOrderBy ??
    (standardOrderBy === undefined ? undefined : (
      bindGeneratedIdentifiers(standardOrderBy, compiled)
    ));
  const query = asCompiledSelectSql(sql`
    WITH checked_rows AS (${compiled}),
    checked_version AS (
      SELECT (SELECT version FROM ${sql.identifier(table)}
        WHERE graph_id = ${graphId} AND is_active = ${dialect.booleanLiteral(true)}) AS version
    )
    SELECT checked_rows.*, checked_version.version AS ${sql.identifier(marker)}
    FROM checked_version LEFT JOIN checked_rows ON 1 = 1
    ${orderBy ?? sql.raw("")}
  `);
  const rows = restoreGeneratedColumns(
    await backend.execute<Record<string, unknown>>(query),
    generatedColumnsOf(compiled),
  );
  const rawVersion = rows[0]?.[marker];
  const actual =
    rawVersion === null || rawVersion === undefined ?
      undefined
    : Number(rawVersion);
  if (actual !== expectedVersion)
    throw new SchemaChangedError({
      graphId,
      expected: expectedVersion,
      actual,
    });
  // The start id is non-null for every real row. Only the left-join sentinel lacks it.
  return rows
    .filter(
      (row) =>
        row[
          input.rowIdentityColumn ?? aliasColumnName(ast.start.alias, "id")
        ] !== null &&
        row[
          input.rowIdentityColumn ?? aliasColumnName(ast.start.alias, "id")
        ] !== undefined,
    )
    .map((row) => {
      const { [marker]: _version, ...data } = row;
      return data;
    });
}
