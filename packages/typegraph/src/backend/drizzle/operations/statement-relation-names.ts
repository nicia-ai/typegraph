import { configuredRelationNames, type Tables } from "./shared";

/**
 * Identifier equality as the stricter engine decides it: SQLite folds ASCII
 * case in identifiers even when they are quoted, so `TG_SET_KEYS` and
 * `tg_set_keys` name one relation there. Folding on PostgreSQL too can only
 * pick an alternative name where none was needed, never let two names meet.
 */
function identifierKey(name: string): string {
  return name.toLowerCase();
}

/**
 * Chooses the names of the relations (CTEs and aliases) one statement
 * introduces, so that none equals a configured table name or another of the
 * statement's own names. A statement that names a CTE after a table its own
 * subqueries read makes those reads resolve to the CTE (a circular reference
 * on SQLite, a wrong relation on PostgreSQL); an alias equal to a table read
 * in an enclosing scope shadows it the same way.
 *
 * Each preferred name is kept when it is free, so the statement's SQL is
 * unchanged for the default table names. A clashing name takes the first free
 * `<name>_<n>` for n = 1, 2, …, checked in the order the names are given, so
 * the choice is deterministic for a given schema.
 */
export function statementRelationNames<const Name extends string>(
  tables: Tables,
  preferred: readonly Name[],
): Readonly<Record<Name, string>> {
  const taken = new Set(
    configuredRelationNames(tables).map((name) => identifierKey(name)),
  );
  const chosen = {} as Record<Name, string>;
  for (const name of preferred) {
    let candidate: string = name;
    for (let suffix = 1; taken.has(identifierKey(candidate)); suffix += 1) {
      candidate = `${name}_${suffix}`;
    }
    taken.add(identifierKey(candidate));
    chosen[name] = candidate;
  }
  return chosen;
}
