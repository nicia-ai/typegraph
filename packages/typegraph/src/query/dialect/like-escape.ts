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
import { type SQL, sql } from "drizzle-orm";

/**
 * The backslash escape character shared by the pattern builders and the
 * {@link likeEscapeClause}. They must stay in sync: the builders prefix
 * wildcards with this character, and the clause tells SQL to treat it as an
 * escape.
 */
export const LIKE_ESCAPE_CHARACTER = "\\";

/**
 * `ESCAPE '\'` clause appended to every compiled `LIKE` / `ILIKE` predicate.
 * The single backslash inside the quotes is a literal in both PostgreSQL
 * (with `standard_conforming_strings`, the default) and SQLite.
 */
export const likeEscapeClause: SQL = sql`ESCAPE '\\'`;
