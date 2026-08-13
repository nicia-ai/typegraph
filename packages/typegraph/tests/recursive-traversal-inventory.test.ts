/**
 * THE INVENTORY RATCHET for `WITH RECURSIVE` emission in `src/**` (I1).
 *
 * The invariant it enforces: **exactly six `WITH RECURSIVE` emission sites
 * exist in `src/**`, in both directions** — a site in the tree with no
 * matching entry fails, and an entry matching no site in the tree fails —
 * **and exactly one `assumeRecursiveTraversalSupported` call site exists**,
 * likewise checked both directions. Every recursive SQL builder is required
 * to take a `RecursiveTraversalVerdict` (I2);
 * `assumeRecursiveTraversalSupported` is the one sanctioned escape from
 * resolving that verdict off a real backend, and its call sites are
 * inventoried by the same scanner so a second escape hatch cannot appear
 * silently.
 *
 * **Round-1 defect this replaces (M-9):** the round-1 formulation compared
 * *file sets* against 6. On this tree, `grep -rl "WITH RECURSIVE" src
 * --include=*.ts | wc -l` is **8**, not 6, because two files —
 * `query/compiler/recursive.ts` and `backend/capabilities/recursive-traversal.ts`
 * — hold the phrase only in a doc comment and contain no emission site at
 * all. (Two more comment occurrences, at `identity/historical-sql.ts:288`
 * and `query/compiler/emitter/recursive.ts:13`, sit in files that also hold
 * a real site, so they do not change the file-set count.) A ratchet keyed
 * on the file set would have failed on arrival at 8. The fix is to key on
 * `(file, line)` after parsing comments out, so the six emission sites are
 * counted and the four comment occurrences are not.
 *
 * ## Honest statement of its limits
 *
 * - **It sees LITERALS.** `scanForRecursionEmissions` only finds the phrase
 *   inside a string or template-literal token. A phrase assembled by string
 *   concatenation (`"WITH " + "RECURSIVE"`) or produced by a helper function
 *   is invisible to it.
 * - **Two identical trimmed lines in one file share a key.** `(file, line)`
 *   is the key, so a file holding the exact same trimmed source line twice
 *   collapses both occurrences to one key. `diffAgainstInventory` compares
 *   sorted key arrays AS MULTISETS rather than as `Set`s for exactly this
 *   reason — a duplicate found key that the inventory declares once still
 *   surfaces as `undeclared` — which is stricter than the derived-backend
 *   ratchet this file is modeled on, which has no such duplicate today.
 * - **It is scoped to `src/**`.** `tests/**` legitimately spells `WITH
 *   RECURSIVE` and `assumeRecursiveTraversalSupported` in fixtures and
 *   assertions — this file's own fixtures below are exactly that — so the
 *   scan never walks outside `src`.
 * - **An aliased import of the `assume` constructor is invisible.** `import
 *   { assumeRecursiveTraversalSupported as escape } from "..."; escape(...)`
 *   calls the real function but is not a bare identifier named
 *   `assumeRecursiveTraversalSupported`, so `scanForAssumeCalls` does not see
 *   it. Renaming on import is the one bypass this scanner cannot close.
 *
 * Comment stripping is done by parsing with `ts.createSourceFile` and walking
 * the resulting AST (`ts.forEachChild`), not with a bare `ts.createScanner`
 * token loop or a regex: every one of the six sites lives inside a tagged
 * template with `${...}` interpolations, and a scanner that re-enters a
 * template body after a `}` re-lexes it as ordinary source — which mis-lexes
 * apostrophes and `--` inside the embedded SQL and can blank or swallow real
 * lines. The parser uses the same lexer, handles templates correctly, and is
 * what the tree's own `backend-derivation-inventory.test.ts` already uses
 * for the same reason (its doc comment: "Parsed with the TypeScript parser
 * rather than matched with a regex"); this file follows that precedent.
 * Positions are read with `node.getStart(parsed)`, never `node.pos`: `pos`
 * includes leading trivia, so a comment holding the phrase directly above a
 * phrase-free literal would attribute the comment's text to the literal —
 * the row "does not report a WITH RECURSIVE that only appears in a comment"
 * below is what pins that.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RECURSION_PHRASE = "WITH RECURSIVE";
const ASSUME_CONSTRUCTOR = "assumeRecursiveTraversalSupported";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

/** A site found by scanning source text. */
type FoundSite = Readonly<{
  /** Path relative to `packages/typegraph/src`. */
  file: string;
  lineNumber: number;
  /** The site's own source line, trimmed. */
  line: string;
}>;

/** A declared site: where it is, which of the six/one it is, and why. */
type InventoryEntry = Readonly<{
  /** Path relative to `packages/typegraph/src`. */
  file: string;
  /** The site's own source line, trimmed. */
  line: string;
  /** "A".."F" for an emission site, "compileQuery default" for the assume call. */
  site: string;
  /** What emits here, or why the assumption is sound here. Mandatory. */
  reason: string;
}>;

/**
 * The six `WITH RECURSIVE` emission sites, measured on this branch (§2 of
 * the batch spec, reproduced from `grep -rn "WITH RECURSIVE" src
 * --include=*.ts`).
 */
const EMISSION_SITES: readonly InventoryEntry[] = [
  {
    file: "query/compiler/emitter/recursive.ts",
    line: "sql`WITH RECURSIVE`,",
    site: "A",
    reason:
      "emitRecursiveQuerySql assembles the top-level SELECT over the compiled recursive CTE list.",
  },
  {
    file: "store/recursive-cte.ts",
    line: "return sql`WITH RECURSIVE reachable AS (${baseCase} UNION ALL ${recursiveCase})`;",
    site: "B",
    reason:
      "buildReachableCte compiles a fixed/variable-length traversal into a bounded reachable set.",
  },
  {
    file: "identity/service-read.ts",
    line: "WITH RECURSIVE",
    site: "C",
    reason:
      "loadHistoricalClasses reconstructs identity classes as of a historical read coordinate.",
  },
  {
    file: "identity/historical-sql.ts",
    line: "WITH RECURSIVE",
    site: "D",
    reason:
      "historicalIdentityPeerClassQuery expands one seed's peer class for a historical identity read.",
  },
  {
    file: "store/algorithms/weighted-shortest-path.ts",
    line: "WITH RECURSIVE chain AS (",
    site: "E",
    reason:
      "extractPathFromWorkingTable walks predecessor pointers back to the source through a bounded chain.",
  },
  {
    file: "identity/service-mutation.ts",
    line: "WITH RECURSIVE",
    site: "F",
    reason:
      "loadIdentityWindowLedger reconstructs the identity component ledger across a mutation's window.",
  },
];

/** The one sanctioned `assumeRecursiveTraversalSupported` call site. */
const ASSUME_CALL_SITES: readonly InventoryEntry[] = [
  {
    file: "query/compiler/index.ts",
    line: 'assumeRecursiveTraversalSupported("compileQuery called without a backend");',
    site: "compileQuery default",
    reason:
      "compileQuery's public entry point takes no backend, so it has no capabilities to resolve a verdict from.",
  },
];

/**
 * Every `WITH RECURSIVE` emission in `source`: every occurrence of
 * {@link RECURSION_PHRASE} inside a string- or template-literal token, with
 * comments and non-literal code excluded by construction because only those
 * token kinds are inspected.
 *
 * `node.getStart(parsed)` — never `node.pos` — is the slice's start, because
 * `pos` includes leading trivia and would fold a preceding comment's text
 * into the literal it precedes.
 */
function scanForRecursionEmissions(
  file: string,
  source: string,
): readonly FoundSite[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const lines = source.split("\n");
  const sites: FoundSite[] = [];

  const LITERAL_KINDS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
  ]);

  function visit(node: ts.Node): void {
    if (LITERAL_KINDS.has(node.kind)) {
      const start = node.getStart(parsed);
      const text = source.slice(start, node.end);
      let searchIndex = 0;
      for (;;) {
        const foundIndex = text.indexOf(RECURSION_PHRASE, searchIndex);
        if (foundIndex === -1) break;
        const { line } = parsed.getLineAndCharacterOfPosition(
          start + foundIndex,
        );
        sites.push({
          file,
          lineNumber: line + 1,
          line: (lines[line] ?? "").trim(),
        });
        searchIndex = foundIndex + RECURSION_PHRASE.length;
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  }

  visit(parsed);
  return sites;
}

/**
 * Every bare `assumeRecursiveTraversalSupported(...)` call in `source`. A
 * property-access callee (`registry.assumeRecursiveTraversalSupported(...)`)
 * is deliberately not a match, and import specifiers, export specifiers, doc
 * comments and the `export function` declaration are excluded by
 * construction — none of them is a `CallExpression`.
 */
function scanForAssumeCalls(
  file: string,
  source: string,
): readonly FoundSite[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const lines = source.split("\n");
  const sites: FoundSite[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === ASSUME_CONSTRUCTOR
    ) {
      const start = node.expression.getStart(parsed);
      const { line } = parsed.getLineAndCharacterOfPosition(start);
      sites.push({
        file,
        lineNumber: line + 1,
        line: (lines[line] ?? "").trim(),
      });
    }
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  }

  visit(parsed);
  return sites;
}

/**
 * The naive, round-1 formulation this file replaces: every line whose
 * trimmed text contains {@link RECURSION_PHRASE}, comment or code alike.
 * Kept only so the contrast with {@link scanForRecursionEmissions} can be
 * asserted (the "records the file-set formulation this replaces" row) —
 * never used to compute the live inventory.
 */
function scanRawPhraseLines(
  file: string,
  source: string,
): readonly FoundSite[] {
  const sites: FoundSite[] = [];
  for (const [index, rawLine] of source.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line.includes(RECURSION_PHRASE)) continue;
    sites.push({ file, lineNumber: index + 1, line });
  }
  return sites;
}

function collectTypeScriptFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTypeScriptFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/** Runs `scanFile` over every `.ts` file under `src/**`. */
function scanSourceTree<T>(
  scanFile: (file: string, source: string) => readonly T[],
): readonly T[] {
  return collectTypeScriptFiles(SOURCE_ROOT).flatMap((file) =>
    scanFile(
      path.relative(SOURCE_ROOT, file).replaceAll(path.sep, "/"),
      fs.readFileSync(file, "utf8"),
    ),
  );
}

/**
 * `file` and `line` joined on a separator neither can contain, written as the
 * six-character escape and never as the byte: a literal NUL makes the file
 * binary to Git, which then hides every future edit to this ratchet from
 * review.
 */
function siteKey(site: Readonly<{ file: string; line: string }>): string {
  return `${site.file}\u0000${site.line}`;
}

/**
 * Compares `found` against `declared` as MULTISETS of {@link siteKey}, not
 * as `Set`s: a `found` key occurring twice against a `declared` entry
 * naming it once leaves one occurrence unmatched, which is reported as
 * `undeclared` rather than silently accepted because the key is "present".
 * Checked both directions in one pass over two sorted copies.
 */
function diffAgainstInventory(
  found: readonly FoundSite[],
  declared: readonly InventoryEntry[],
): Readonly<{
  undeclared: readonly FoundSite[];
  stale: readonly InventoryEntry[];
}> {
  const remainingDeclaredKeys = declared
    .map((entry) => siteKey(entry))
    .toSorted();
  const undeclared = found.filter((site) => {
    const index = remainingDeclaredKeys.indexOf(siteKey(site));
    if (index === -1) return true;
    remainingDeclaredKeys.splice(index, 1);
    return false;
  });

  const remainingFoundKeys = found.map((site) => siteKey(site)).toSorted();
  const stale = declared.filter((entry) => {
    const index = remainingFoundKeys.indexOf(siteKey(entry));
    if (index === -1) return true;
    remainingFoundKeys.splice(index, 1);
    return false;
  });

  return { undeclared, stale };
}

/**
 * A fixture holding the phrase only in comments, in four shapes: a line
 * comment, a JSDoc block comment, a block comment whose text happens to
 * contain a fake tagged-template code sample (I1's named case — comment
 * text, not a real template literal), and a comment immediately preceding a
 * phrase-free template literal (the shape that pins `getStart` vs `pos`).
 */
const COMMENT_ONLY_FIXTURE = [
  "// WITH RECURSIVE at the top of this scratch fixture, in a line comment.",
  "const lineComment = 1;",
  "",
  "/**",
  " * Explains the invariant by naming `WITH RECURSIVE` directly, in a JSDoc",
  " * block comment.",
  " */",
  "const docComment = 2;",
  "",
  "/* A block comment holding a fake code sample: sql`WITH RECURSIVE` — still",
  "   just comment text. */",
  "const blockCommentTemplate = 3;",
  "",
  "const precedingClean =",
  "  // WITH RECURSIVE, immediately preceding a template literal with none.",
  "  `SELECT 1`;",
].join("\n");

describe("recursion inventory ratchet", () => {
  const emissionSites = scanSourceTree(scanForRecursionEmissions);
  const emissionDiff = diffAgainstInventory(emissionSites, EMISSION_SITES);

  const assumeSites = scanSourceTree(scanForAssumeCalls);
  const assumeDiff = diffAgainstInventory(assumeSites, ASSUME_CALL_SITES);

  it("has no WITH RECURSIVE emission site in src outside the inventory", () => {
    const reported = emissionDiff.undeclared.map(
      (site) => `${site.file}:${String(site.lineNumber)}  ${site.line}`,
    );
    if (reported.length > 0) {
      throw new Error(
        `A WITH RECURSIVE literal is emitted at a site EMISSION_SITES does not declare:\n\n${reported.join("\n")}\n\n` +
          `Every SQL builder that emits a recursive CTE must take a RecursiveTraversalVerdict and refuse (or, for the weighted-shortest-path fallback, degrade) when the engine cannot recurse (I1). Add an entry to EMISSION_SITES in this file, site "G" onward, with a one-line reason naming the emitting function — the reason is the review.`,
      );
    }
    expect(reported).toEqual([]);
  });

  it("has no stale emission-site inventory entry", () => {
    const reported = emissionDiff.stale.map(
      (entry) => `${entry.file}  ${entry.line}`,
    );
    if (reported.length > 0) {
      throw new Error(
        `These EMISSION_SITES entries match no WITH RECURSIVE emission in src — the code moved or the site was removed. Delete them:\n\n${reported.join("\n")}`,
      );
    }
    expect(reported).toEqual([]);
  });

  it("has exactly one assumeRecursiveTraversalSupported call site in src, and the inventory names it", () => {
    const reported = assumeDiff.undeclared.map(
      (site) => `${site.file}:${String(site.lineNumber)}  ${site.line}`,
    );
    if (reported.length > 0) {
      throw new Error(
        `A bare assumeRecursiveTraversalSupported(...) call exists at a site ASSUME_CALL_SITES does not declare:\n\n${reported.join("\n")}\n\n` +
          `This is the one sanctioned escape from resolving a verdict off a real backend's capabilities (I2). Add an entry to ASSUME_CALL_SITES in this file with a one-line reason, or resolve the verdict from a backend instead.`,
      );
    }
    expect(reported).toEqual([]);
  });

  it("has no stale assume-call-site inventory entry", () => {
    const reported = assumeDiff.stale.map(
      (entry) => `${entry.file}  ${entry.line}`,
    );
    if (reported.length > 0) {
      throw new Error(
        `These ASSUME_CALL_SITES entries match no assumeRecursiveTraversalSupported call in src — the code moved or the call was removed. Delete them:\n\n${reported.join("\n")}`,
      );
    }
    expect(reported).toEqual([]);
  });

  it("reports emission-site shapes the source tree does not currently contain", () => {
    // Four shapes a line-oriented or non-parser scanner tends to miss: the
    // phrase alone on its own line inside a multi-line template (no
    // interpolation involved at all), the phrase inside a TemplateMiddle
    // sitting between two `${...}` interpolations, the phrase inside a
    // plain `sql.raw("...")` string-literal argument, and two
    // phrase-bearing lines inside one template literal.
    const fixture = [
      "const headOnly = sql`",
      "  WITH RECURSIVE foo AS (",
      "    SELECT 1",
      "  )",
      "`;",
      "",
      "const middle = sql`",
      "  ${a}",
      "  WITH RECURSIVE",
      "  ${b}",
      "`;",
      "",
      'const raw = sql.raw("WITH RECURSIVE raw_cte AS (SELECT 1)");',
      "",
      "const twice = sql`",
      "  WITH RECURSIVE a AS (SELECT 1)",
      "  WITH RECURSIVE b AS (SELECT 2)",
      "`;",
    ].join("\n");

    const found = scanForRecursionEmissions("fixture.ts", fixture);

    expect(
      found.map((site) => `${String(site.lineNumber)}:${site.line}`),
    ).toEqual([
      "2:WITH RECURSIVE foo AS (",
      "9:WITH RECURSIVE",
      '13:const raw = sql.raw("WITH RECURSIVE raw_cte AS (SELECT 1)");',
      "16:WITH RECURSIVE a AS (SELECT 1)",
      "17:WITH RECURSIVE b AS (SELECT 2)",
    ]);
  });

  it("does not report a WITH RECURSIVE that only appears in a comment", () => {
    expect(
      scanForRecursionEmissions("fixture.ts", COMMENT_ONLY_FIXTURE),
    ).toEqual([]);
  });

  it("records the file-set formulation this replaces", () => {
    // M-9, reproduced in miniature: the round-1 formulation counted FILES
    // holding the phrase with a comment-blind scan and compared that count
    // to 6. On this tree `grep -rl "WITH RECURSIVE" src --include=*.ts | wc
    // -l` is 8 for exactly 6 real emission sites (EMISSION_SITES.length),
    // because two files hold the phrase only in a doc comment. This
    // fixture reproduces the shape in miniature: at least four comment
    // lines a raw, line-oriented scan cannot distinguish from code, and
    // zero real sites once the parser strips comments out.
    const raw = scanRawPhraseLines("fixture.ts", COMMENT_ONLY_FIXTURE);
    const scanned = scanForRecursionEmissions(
      "fixture.ts",
      COMMENT_ONLY_FIXTURE,
    );

    expect(raw.length).toBeGreaterThanOrEqual(4);
    expect(scanned).toEqual([]);
  });

  it("reports a duplicate emission site the inventory declares only once", () => {
    const duplicateLine = "sql`WITH RECURSIVE dup AS (SELECT 1)`;";
    const found: readonly FoundSite[] = [
      { file: "scratch/duplicate.ts", lineNumber: 10, line: duplicateLine },
      { file: "scratch/duplicate.ts", lineNumber: 25, line: duplicateLine },
    ];
    const declared: readonly InventoryEntry[] = [
      {
        file: "scratch/duplicate.ts",
        line: duplicateLine,
        site: "scratch",
        reason:
          "A synthetic single-entry inventory used only to exercise the multiset diff.",
      },
    ];

    const { undeclared } = diffAgainstInventory(found, declared);

    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]?.lineNumber).toBe(25);
  });

  it("excludes imports, re-exports and the declaration of the assume constructor", () => {
    const fixture = [
      'import { assumeRecursiveTraversalSupported } from "../backend/capabilities/recursive-traversal";',
      "",
      "export { assumeRecursiveTraversalSupported };",
      "",
      "/**",
      " * Calls {@link assumeRecursiveTraversalSupported} when no backend is",
      " * available.",
      " */",
      "export function assumeRecursiveTraversalSupported(reason: string) {",
      "  return reason;",
      "}",
      "",
      'const verdict = assumeRecursiveTraversalSupported("scratch fixture call");',
      "",
      'registry.assumeRecursiveTraversalSupported("scratch fixture member call");',
    ].join("\n");

    const found = scanForAssumeCalls("fixture.ts", fixture);

    expect(
      found.map((site) => `${String(site.lineNumber)}:${site.line}`),
    ).toEqual([
      '13:const verdict = assumeRecursiveTraversalSupported("scratch fixture call");',
    ]);
  });

  it("requires a reason on every inventory entry", () => {
    const missing = [...EMISSION_SITES, ...ASSUME_CALL_SITES].filter(
      (entry) => entry.reason.trim().length < 20,
    );
    expect(missing.map((entry) => `${entry.file}#${entry.site}`)).toEqual([]);
  });
});
