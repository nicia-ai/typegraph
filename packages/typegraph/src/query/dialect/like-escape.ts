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
 * Whether `pattern` ends with an escape character that escapes nothing: an
 * odd-length run of {@link LIKE_ESCAPE_CHARACTER} at its end. Such a pattern
 * is malformed, and the engines disagree on it: PostgreSQL raises "LIKE
 * pattern must not end with escape character" when its matcher reaches the
 * dangling escape (so whether a query fails depends on the rows), while
 * SQLite matches nothing. A literal pattern is refused when the predicate is
 * built; {@link nullIfTrailingLikeEscape} is the same decision in SQL, for a
 * bound pattern.
 */
export function likePatternHasTrailingEscape(pattern: string): boolean {
  let trailingEscapes = 0;
  for (let index = pattern.length - 1; index >= 0; index--) {
    if (pattern[index] !== LIKE_ESCAPE_CHARACTER) break;
    trailingEscapes++;
  }
  return trailingEscapes % 2 === 1;
}

/**
 * A bound LIKE pattern, or NULL when it ends with an unpaired escape (see
 * {@link likePatternHasTrailingEscape}), so the predicate matches nothing on
 * every backend instead of raising on PostgreSQL for some rows only.
 * `length`, `rtrim` and `%` mean the same on SQLite and PostgreSQL.
 */
export function nullIfTrailingLikeEscape(pattern: SqlFragment): SqlFragment {
  return sql`CASE WHEN (length(${pattern}) - length(rtrim(${pattern}, ${LIKE_ESCAPE_CHARACTER}))) % 2 = 1 THEN NULL ELSE ${pattern} END`;
}

/**
 * `ESCAPE '\'` clause appended to every compiled `LIKE` / `ILIKE` predicate,
 * declaring {@link LIKE_ESCAPE_CHARACTER} as the escape character. The single
 * backslash inside the quotes is a literal in both PostgreSQL (with
 * `standard_conforming_strings`, the default) and SQLite.
 */
export const likeEscapeClause: SqlFragment = sql`ESCAPE '\\'`;

/**
 * Placeholders for the three escape sequences while the other characters are
 * rewritten. They are Unicode noncharacters (U+FDD0..U+FDD2), which are not
 * expected in text; a pattern that does contain one is mistranslated.
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
