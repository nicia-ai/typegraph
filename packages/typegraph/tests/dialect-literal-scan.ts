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
 * `dialect (!==|===) "postgres"/"sqlite"` decision would then have two
 * spellings, which is the defect class this scanner exists to prevent.
 *
 * This scan is deliberately NARROWER than the ESLint selectors it models: it
 * only matches a comparison where one side is literally the identifier
 * `dialect` or a `.dialect` property access, and only the `===`/`!==`
 * operators, whereas the ESLint selectors match `==`/`!=` too and do not
 * require either side of the comparison to be named `dialect` at all — nor
 * does the `SwitchCase` selector require the switch's own discriminant to be
 * `dialect`. That is deliberate: this scan exists to answer "does this file
 * make the `dialect`-keyed decision," which is what an exemption reason
 * explains, not "will ESLint flag this file." Whether the ban is actually
 * installed for a given module is a question only ESLint's resolved config
 * can answer — see `pnpm exec eslint src` and the `DIALECT_SEAM_RESTRICTIONS`
 * column in `tests/backend-construction-lint.test.ts`.
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

function isDialectExpression(node: ts.Expression): boolean {
  if (ts.isIdentifier(node) && node.text === "dialect") return true;
  return ts.isPropertyAccessExpression(node) && node.name.text === "dialect";
}

function dialectLiteralComparison(node: ts.Node): boolean {
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    const [dialectSide, literalSide] =
      isDialectExpression(node.left) ? [node.left, node.right]
      : isDialectExpression(node.right) ? [node.right, node.left]
      : [undefined, undefined];
    if (
      dialectSide !== undefined &&
      ts.isStringLiteralLike(literalSide) &&
      DIALECT_LITERALS.has(literalSide.text)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Every `dialect (!==|===) "postgres"/"sqlite"` comparison, and every
 * `switch (dialect)`/`switch (x.dialect)` statement with a `"postgres"`/
 * `"sqlite"` case — the two shapes a comment-stripped AST walk must cover (a
 * plain-text grep would also flag a token named in a comment or a docstring,
 * which neither ratchet wants).
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
    if (
      ts.isSwitchStatement(node) &&
      isDialectExpression(node.expression) &&
      node.caseBlock.clauses.some(
        (clause) =>
          ts.isCaseClause(clause) &&
          ts.isStringLiteralLike(clause.expression) &&
          DIALECT_LITERALS.has(clause.expression.text),
      )
    ) {
      recordAt(node.getStart(parsed));
    }
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  }

  visit(parsed);
  return sites;
}
