/**
 * The structural gate over how a statement spells the relations its WITH list
 * declares: every reference to a CTE name must be spelled exactly like the
 * declaration — the same quoting and the same case.
 *
 * PostgreSQL folds an unquoted name to lower case and keeps a quoted one as
 * written, so `cte_Doc AS (…)` declares `cte_doc`, and a later `"cte_Doc"`
 * names a relation that does not exist. SQLite compares names without regard
 * to case and quoting, so it runs the same text; only a mixed-case alias makes
 * the two spellings differ, and only PostgreSQL notices. Comparing spellings
 * in the text catches the divergence on every dialect and for every alias,
 * without a database.
 *
 * A declaration is a name that follows `WITH`, `RECURSIVE` or `,`, optionally
 * carries a parenthesized column list, and is followed by
 * `AS [NOT] [MATERIALIZED] (`. A reference is any other name token equal to a
 * declared name under case-insensitive comparison (SQLite's rule for which
 * tokens name the same relation). String literals are skipped.
 */
import { type Token, tokenize } from "./column-read-gate";

function isName(token: Token | undefined): token is Token {
  return token?.kind === "word" || token?.kind === "quoted";
}

function isWord(token: Token | undefined, word: string): boolean {
  return token?.kind === "word" && token.value.toUpperCase() === word;
}

function isPunctuation(token: Token | undefined, value: string): boolean {
  return token?.kind === "other" && token.value === value;
}

/** The index after the parenthesis that closes the one opened at `open`. */
function afterClosingParenthesis(
  tokens: readonly Token[],
  open: number,
): number | undefined {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (isPunctuation(tokens[index], "(")) depth += 1;
    if (isPunctuation(tokens[index], ")")) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

/** Whether the token at `index` is the name of a WITH-list declaration. */
function isCteDeclaration(tokens: readonly Token[], index: number): boolean {
  const previous = tokens[index - 1];
  if (
    !isWord(previous, "WITH") &&
    !isWord(previous, "RECURSIVE") &&
    !isPunctuation(previous, ",")
  )
    return false;
  let cursor = index + 1;
  if (isPunctuation(tokens[cursor], "(")) {
    const after = afterClosingParenthesis(tokens, cursor);
    if (after === undefined) return false;
    cursor = after;
  }
  if (!isWord(tokens[cursor], "AS")) return false;
  cursor += 1;
  if (isWord(tokens[cursor], "NOT")) cursor += 1;
  if (isWord(tokens[cursor], "MATERIALIZED")) cursor += 1;
  return isPunctuation(tokens[cursor], "(");
}

/** How a name token is written: `cte_Doc` or `"cte_Doc"`. */
function spelling(token: Token): string {
  return token.kind === "quoted" ? `"${token.value}"` : token.value;
}

/** One reference spelled differently from the declaration it names. */
export type CteSpellingMismatch = Readonly<{
  declared: string;
  referenced: string;
}>;

/**
 * Every reference in `text` to a CTE the text declares that is not spelled
 * exactly like its declaration, once per distinct (declared, referenced)
 * pair, in order of appearance.
 */
export function cteSpellingMismatches(
  text: string,
): readonly CteSpellingMismatch[] {
  const tokens = tokenize(text);
  const declarations = new Map<string, string>();
  for (const [index, token] of tokens.entries()) {
    if (isName(token) && isCteDeclaration(tokens, index)) {
      const key = token.value.toLowerCase();
      if (!declarations.has(key)) declarations.set(key, spelling(token));
    }
  }
  const mismatches = new Map<string, CteSpellingMismatch>();
  for (const token of tokens) {
    if (!isName(token)) continue;
    const declared = declarations.get(token.value.toLowerCase());
    const referenced = spelling(token);
    if (declared === undefined || declared === referenced) continue;
    mismatches.set(`${declared}\0${referenced}`, { declared, referenced });
  }
  return [...mismatches.values()];
}

/** The CTE names `text` declares, spelled as declared. */
export function declaredCteNames(text: string): readonly string[] {
  const tokens = tokenize(text);
  return tokens.flatMap((token, index) =>
    isName(token) && isCteDeclaration(tokens, index) ? [spelling(token)] : [],
  );
}
