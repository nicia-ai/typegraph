/**
 * Shared LIKE-escape clause for the query compiler.
 *
 * The compiler builds `contains` / `startsWith` / `endsWith` patterns by
 * escaping the literal `%`, `_`, and `\` in user input with a backslash (see
 * the pattern builders in `compiler/predicates.ts`). For that escaping to take
 * effect the emitted `LIKE` / `ILIKE` must declare backslash as its escape
 * character. PostgreSQL's default LIKE escape is already backslash, so this
 * clause is a no-op there; SQLite has *no* default escape character, so without
 * it an escaped `\%` matches a literal backslash followed by any character —
 * silently diverging from Postgres. Emitting it on every compiled predicate
 * makes the two backends match by construction.
 */
import { sql, type SqlFragment } from "../sql-fragment";

/**
 * The backslash escape character used by the JS pattern builder
 * (`compileStringPattern` in `compiler/predicates.ts`) to prefix the literal
 * `%`, `_`, and `\` in user input. It must match the character declared by
 * {@link likeEscapeClause}: the builder prefixes wildcards with this character,
 * and the clause tells SQL to treat it as the escape. Both are backslash.
 */
export const LIKE_ESCAPE_CHARACTER = "\\";

/**
 * `ESCAPE '\'` clause appended to every compiled `LIKE` / `ILIKE` predicate,
 * declaring {@link LIKE_ESCAPE_CHARACTER} as the escape character. The single
 * backslash inside the quotes is a literal in both PostgreSQL (with
 * `standard_conforming_strings`, the default) and SQLite.
 */
export const likeEscapeClause: SqlFragment = sql`ESCAPE '\\'`;

/**
 * Placeholders for the three escape sequences while the other characters are
 * rewritten. They are Unicode noncharacters (U+FDD0..U+FDD2), which are
 * reserved never to appear in interchanged text, so no user pattern contains
 * them.
 */
const ESCAPED_ESCAPE_PLACEHOLDER = 0xfd_d0;
const ESCAPED_PERCENT_PLACEHOLDER = 0xfd_d1;
const ESCAPED_UNDERSCORE_PLACEHOLDER = 0xfd_d2;

/**
 * Translates a LIKE pattern (escape {@link LIKE_ESCAPE_CHARACTER}) into the
 * equivalent SQLite `GLOB` pattern, as a SQL expression, so a literal and a
 * `param()` pattern take the same path.
 *
 * SQLite's `LIKE` ignores ASCII case, while `GLOB` is case-sensitive, so a
 * case-sensitive LIKE on SQLite is a GLOB over the translated pattern:
 * - `\\`, `\%` and `\_` are literal `\`, `%` and `_`; any other `\c` is a
 *   literal `c` (the escape is dropped);
 * - GLOB's own metacharacters `[`, `*` and `?` are literal in LIKE, so they
 *   become one-character classes `[[]`, `[*]` and `[?]`;
 * - the LIKE wildcards `%` and `_` become `*` and `?`.
 *
 * A backslash is an ordinary character in GLOB, as are `%` and `_`, so the
 * escaped forms are restored as plain characters at the end.
 */
export function sqliteGlobFromLikePattern(pattern: SqlFragment): SqlFragment {
  const escapedEscape = sql`char(${sql.raw(String(ESCAPED_ESCAPE_PLACEHOLDER))})`;
  const escapedPercent = sql`char(${sql.raw(String(ESCAPED_PERCENT_PLACEHOLDER))})`;
  const escapedUnderscore = sql`char(${sql.raw(String(ESCAPED_UNDERSCORE_PLACEHOLDER))})`;
  const replacements: readonly (readonly [SqlFragment, SqlFragment])[] = [
    [sql`${`${LIKE_ESCAPE_CHARACTER}${LIKE_ESCAPE_CHARACTER}`}`, escapedEscape],
    [sql`${`${LIKE_ESCAPE_CHARACTER}%`}`, escapedPercent],
    [sql`${`${LIKE_ESCAPE_CHARACTER}_`}`, escapedUnderscore],
    [sql`${LIKE_ESCAPE_CHARACTER}`, sql`''`],
    [sql`'['`, sql`'[[]'`],
    [sql`'*'`, sql`'[*]'`],
    [sql`'?'`, sql`'[?]'`],
    [sql`'%'`, sql`'*'`],
    [sql`'_'`, sql`'?'`],
    [escapedEscape, sql`${LIKE_ESCAPE_CHARACTER}`],
    [escapedPercent, sql`'%'`],
    [escapedUnderscore, sql`'_'`],
  ];
  let translated = pattern;
  for (const [from, to] of replacements) {
    translated = sql`REPLACE(${translated}, ${from}, ${to})`;
  }
  return translated;
}
