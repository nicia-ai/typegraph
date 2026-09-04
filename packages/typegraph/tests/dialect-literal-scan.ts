/**
 * The dialect-literal AST scan, factored out so it has exactly one owner.
 *
 * Two ratchets consume {@link scanForDialectLiterals}:
 *
 * - `tests/dialect-literal-inventory.test.ts` scans the whole of `src/**` and
 *   asserts the set of files it returns equals `DIALECT_LITERAL_EXEMPTIONS`
 *   (`eslint.config.mjs`), both directions — the ESLint ban's release valve.
 * - `tests/lock-fence-plan-inventory.test.ts` scans a narrower file list (the
 *   eight lock sites, plus the two files that branch on dialect for reasons
 *   unrelated to a lock) to prove the pessimistic-lock decision has not
 *   re-acquired a second, inline owner.
 *
 * A second implementation of this scan in either test could disagree with the
 * other about what counts as a dialect-literal comparison — the same
 * decision would then have two spellings, which is the defect class this
 * scanner exists to prevent.
 *
 * This scan is an EXACT mirror of `DIALECT_SEAM_RESTRICTIONS`'s two ESLint
 * selectors (`eslint.config.mjs`), site for site:
 *
 *  - `BinaryExpression[operator=/^(===|!==|==|!=)$/] > Literal[value=/^(sqlite|postgres)$/]`
 *    — any `===`/`!==`/`==`/`!=` comparison with a `"postgres"`/`"sqlite"`
 *    string literal as EITHER operand, regardless of what the other operand
 *    is (an identifier named `dialect`, a `.dialect` property access, another
 *    literal, anything). One site is recorded per matching `BinaryExpression`
 *    even when both operands are such a literal — a shape no real dialect
 *    comparison in this codebase produces.
 *  - `SwitchCase > Literal[value=/^(sqlite|postgres)$/]` — any `case` clause
 *    whose own test expression is such a literal, regardless of the
 *    enclosing switch's discriminant. One site per matching case clause, not
 *    one per `switch` statement: a switch with two matching case labels is
 *    two sites here, exactly as it is two `SwitchCase` matches for ESLint.
 *
 * Neither shape requires the OTHER side of a comparison, or the switch's own
 * discriminant, to be named `dialect` — matching the ESLint selectors, which
 * make no such requirement either. Whether the ban is actually installed for
 * a given module is a question only ESLint's resolved config can answer —
 * see `pnpm exec eslint src` and the `DIALECT_SEAM_RESTRICTIONS` column in
 * `tests/backend-construction-lint.test.ts`.
 */
import ts from "typescript";

/** A site found by scanning source text. */
export type FoundSite = Readonly<{
  /** Path relative to `packages/typegraph/src`, POSIX-separated. */
  file: string;
  lineNumber: number;
  /** The site's own source line, trimmed. */
  line: string;
}>;

export function parseFile(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
}

const DIALECT_LITERALS = new Set(["postgres", "sqlite"]);

const EQUALITY_OPERATOR_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function isDialectStringLiteral(node: ts.Expression): node is ts.StringLiteral {
  // A plain string literal only: ESLint's `Literal` selector never matches a
  // template literal, so neither does this mirror.
  return ts.isStringLiteral(node) && DIALECT_LITERALS.has(node.text);
}

function dialectLiteralComparison(node: ts.Node): boolean {
  return (
    ts.isBinaryExpression(node) &&
    EQUALITY_OPERATOR_KINDS.has(node.operatorToken.kind) &&
    (isDialectStringLiteral(node.left) || isDialectStringLiteral(node.right))
  );
}

/**
 * Every `(===|!==|==|!=)` comparison with a `"postgres"`/`"sqlite"` string
 * literal as either operand, and every `case` clause testing such a literal
 * — the two shapes {@link EQUALITY_OPERATOR_KINDS} and the module docblock
 * describe, walked over a comment-stripped AST so a token named in a comment
 * or a docstring is never mistaken for a real comparison.
 */
export function scanForDialectLiterals(
  file: string,
  source: string,
): readonly FoundSite[] {
  const parsed = parseFile(file, source);
  const lines = source.split("\n");
  const sites: FoundSite[] = [];

  function recordAt(start: number): void {
    const { line } = parsed.getLineAndCharacterOfPosition(start);
    sites.push({
      file,
      lineNumber: line + 1,
      line: (lines[line] ?? "").trim(),
    });
  }

  function visit(node: ts.Node): void {
    if (dialectLiteralComparison(node)) {
      recordAt(node.getStart(parsed));
    }
    if (ts.isCaseClause(node) && isDialectStringLiteral(node.expression)) {
      recordAt(node.getStart(parsed));
    }
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  }

  visit(parsed);
  return sites;
}
