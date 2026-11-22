/**
 * The one owner of a column reference in a standard statement.
 *
 * Every by-name column reference the standard emitter writes is built by one
 * of the functions below, and the fragment each returns carries the read it
 * spells (see `SqlColumnRead` in `sql-intent.ts`). The read travels with the
 * fragment through every composition, so the read set of a finished
 * statement is the set of references its SQL contains: a reference is
 * recorded exactly when it is written, and a reference that is built but not
 * written records nothing. The SQL-name registry takes its read set from the
 * finished statement (`sealStatementColumnReads`); nothing derives it a
 * second way.
 */
import { CompilerInvariantError } from "../../errors";
import { sql, type SqlFragment } from "../sql-fragment";
import {
  setSqlColumnReads,
  type SqlColumnRead,
  sqlColumnReads,
} from "../sql-intent";
import { aliasColumnName } from "./alias-names";


/**
 * How a qualified reference is spelled:
 *
 * - `"plain"`: `relation.name`
 * - `"quoted"`: `"relation"."name"`
 * - `"quoted-name"`: `relation."name"`
 */
export type ColumnReferenceSpelling = "plain" | "quoted" | "quoted-name";

function withReads(
  fragment: SqlFragment,
  reads: readonly SqlColumnRead[],
): SqlFragment {
  setSqlColumnReads(fragment, reads);
  return fragment;
}

/** Writes `relation.name` and records that the statement reads `name` from `relation`. */
export function readColumn(
  relation: string,
  name: string,
  spelling: ColumnReferenceSpelling = "plain",
): SqlFragment {
  const text = (() => {
    switch (spelling) {
      case "plain": {
        return sql.raw(`${relation}.${name}`);
      }
      case "quoted": {
        return sql`${sql.identifier(relation)}.${sql.identifier(name)}`;
      }
      case "quoted-name": {
        return sql`${sql.raw(relation)}.${sql.identifier(name)}`;
      }
    }
  })();
  return withReads(text, [
    { name, relations: [relation], qualified: true, scope: undefined },
  ]);
}

/** Writes `relation.<alias>_<column>` for one physical column of an alias. */
export function readAliasColumn(
  relation: string,
  alias: string,
  column: string,
  spelling: ColumnReferenceSpelling = "plain",
): SqlFragment {
  return readColumn(relation, aliasColumnName(alias, column), spelling);
}

/**
 * Writes an unqualified `name` in a SELECT whose FROM is exactly `relations`,
 * and records that SQL resolves it in each of them.
 */
export function readUnqualifiedColumn(
  relations: readonly string[],
  name: string,
): SqlFragment {
  return withReads(sql.raw(name), [
    { name, relations: [...relations], qualified: false, scope: undefined },
  ]);
}

/**
 * Writes an unqualified `name` whose FROM is not known where it is written
 * (the shared predicate and expression compilers). The SELECT that places it
 * binds it to its FROM with {@link bindUnresolvedColumnReads}; a standard
 * statement that still carries an unbound read is a compiler defect.
 */
export function readUnresolvedColumn(name: string): SqlFragment {
  return withReads(sql.raw(name), [
    { name, relations: undefined, qualified: false, scope: undefined },
  ]);
}

/** Writes `*` and records that the statement reads every column of `relations`. */
export function readEveryColumn(relations: readonly string[]): SqlFragment {
  return withReads(
    sql.raw("*"),
    relations.map((relation) => ({
      name: undefined,
      relations: [relation],
      qualified: false,
      scope: undefined,
    })),
  );
}

/**
 * Writes `relation.*` inside a CTE that carries every column of `relation`
 * forward, and records that read. The CTE declares the copied columns as its
 * own (see `SqlNameScope.inherit`), so a name is checked where SQL reads it
 * from the CTE that carries it.
 */
export function readEveryColumnOf(relation: string): SqlFragment {
  return withReads(sql.raw(`${relation}.*`), [
    {
      name: undefined,
      relations: [relation],
      qualified: true,
      scope: undefined,
    },
  ]);
}

/** A copy of `fragment` with the same SQL, carrying `reads` instead of its own. */
function withReplacedReads(
  fragment: SqlFragment,
  reads: readonly SqlColumnRead[],
): SqlFragment {
  return withReads(sql.join([fragment]), reads);
}

/**
 * Binds every unqualified read of `fragment` whose FROM was not known where
 * it was written to `relations`, the FROM of the SELECT that places it.
 */
export function bindUnresolvedColumnReads(
  fragment: SqlFragment,
  relations: readonly string[],
): SqlFragment {
  const reads = sqlColumnReads(fragment);
  if (reads.every((read) => read.relations !== undefined)) return fragment;
  return withReplacedReads(
    fragment,
    reads.map((read) =>
      read.relations === undefined ?
        { ...read, relations: [...relations] }
      : read,
    ),
  );
}

/**
 * Marks every read of `fragment` as a correlated reference to the enclosing
 * statement whose expression scope is `scope`: the nested statement that
 * writes it passes it up instead of counting it as its own.
 */
export function readInEnclosingScope(
  fragment: SqlFragment,
  scope: symbol,
): SqlFragment {
  return withReplacedReads(
    fragment,
    sqlColumnReads(fragment).map((read) => ({ ...read, scope })),
  );
}

export type SealedStatement = Readonly<{
  /** The statement's SQL, carrying only the reads that belong to an enclosing statement. */
  statement: SqlFragment;
  /** The reads that belong to this statement. */
  reads: readonly SqlColumnRead[];
}>;

/**
 * Separates a finished statement's own reads from the correlated reads it
 * passes up, and returns the statement carrying only the latter, so an
 * enclosing statement never counts a nested statement's reads as its own.
 *
 * @param ownScope - The statement's expression scope, if it has one: a
 *   correlated read of that scope written by a nested statement is its own.
 * @param requireBound - Whether every unqualified read must already be bound
 *   to a FROM (true for a standard statement).
 */
export function sealStatementColumnReads(
  fragment: SqlFragment,
  ownScope: symbol | undefined,
  requireBound: boolean,
): SealedStatement {
  const reads = sqlColumnReads(fragment);
  const own: SqlColumnRead[] = [];
  const enclosing: SqlColumnRead[] = [];
  for (const read of reads) {
    if (read.scope === undefined || read.scope === ownScope)
      own.push({ ...read, scope: undefined });
    else enclosing.push(read);
  }
  if (requireBound) {
    const unbound = own.find((read) => read.relations === undefined);
    if (unbound !== undefined)
      throw new CompilerInvariantError(
        "Standard statement writes an unqualified column reference that no SELECT bound to its FROM",
        { column: unbound.name },
      );
  }
  return { statement: withReplacedReads(fragment, enclosing), reads: own };
}
