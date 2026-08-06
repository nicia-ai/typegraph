/**
 * T17 (I8) — the write-fence decision has exactly ONE owner.
 *
 * Two ratchets, both comment-stripped AST scans over `src/**` (modelled on
 * `tests/recursive-traversal-inventory.test.ts`):
 *
 *  1. `resolveWriteFencePlan` has exactly **12** call sites — the 8 lock
 *     sites (J1-J8), the 2 construction gates (J9a recorded-clock ownership,
 *     J9b identity), and the 2 halves of the Postgres schema fence (J14
 *     commit-side, J15 writer-side) — enumerated in both directions, keyed
 *     on `(file, trimmed line)` so line drift cannot rot the pin. J14/J15
 *     are the only DEGRADING sites: they switch on `plan.kind` directly
 *     rather than calling `requireWriteFence`, because the CAS they fence
 *     still runs correctly unfenced.
 *  2. Zero dialect-literal comparisons (`dialect (!==|===) "postgres"/
 *     "sqlite"`, in a `BinaryExpression` or a `SwitchStatement` discriminant)
 *     remain in the eight lock sites' five files. The same scan run over the
 *     two files that legitimately still branch on dialect for reasons that
 *     are NOT the pessimistic-lock decision (`backend/migrate-recorded-time.ts`
 *     DDL/column-type selection, `store/algorithms/iterative-graph-operation.ts`
 *     Postgres error-code classification and value selection) finds every row
 *     it returns NAMED — J10-J13 — so an exemption is a decision recorded
 *     here, not a silent survivor of the ratchet's own file scope.
 *
 * *Mutation*: re-inline a dialect check at any lock site → fails naming the
 * file (both the "no resolveWriteFencePlan call added" half and the
 * "dialect literal reappeared" half catch this, from different angles).
 * *Mutation*: pin the `resolveWriteFencePlan` count at 10 (the number before
 * the Postgres schema fence's two halves joined the model) → fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

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

type InventoryEntry = Readonly<{
  file: string;
  line: string;
  site: string;
  reason: string;
}>;

/** The 10 `resolveWriteFencePlan` call sites (Contract J, I8). */
const CALL_SITES: readonly InventoryEntry[] = [
  {
    file: "store/recorded-capture/clock.ts",
    line: "const plan = resolveWriteFencePlan(target);",
    site: "J1",
    reason:
      "lockRecordedGraphWrite resolves the plan for the per-graph recorded-write advisory lock.",
  },
  {
    file: "store/recorded-capture/clock.ts",
    line: "const plan = resolveWriteFencePlan(target);",
    site: "J2",
    reason:
      "lockRecordedClock resolves the plan for TypeGraph-owned recorded-clock allocation.",
  },
  {
    file: "identity/service-read.ts",
    line: "const plan = resolveWriteFencePlan(target);",
    site: "J3",
    reason:
      "lockIdentityGraph resolves the plan for the per-graph identity advisory lock.",
  },
  {
    file: "identity/service-read.ts",
    line: "const plan = resolveWriteFencePlan(target);",
    site: "J4",
    reason:
      "lockIdentityEnablementNodes resolves the plan for the enablement drain's relation lock.",
  },
  {
    file: "identity/schema-transition.ts",
    line: "const plan = resolveWriteFencePlan(target);",
    site: "J5",
    reason:
      "lockIdentityDdl resolves the plan for the database-scoped identity DDL advisory lock.",
  },
  {
    file: "graph-merge/provenance-store.ts",
    line: "const plan = resolveWriteFencePlan(tx);",
    site: "J6",
    reason:
      "drainUnfencedRowWriters resolves the plan for the sidecar-claim relation lock.",
  },
  {
    file: "backend/drizzle/contribution-materializations.ts",
    line: "const plan = resolveWriteFencePlan(deps.fenceTarget);",
    site: "J7",
    reason:
      "lockContributionDdl resolves the plan for the database-scoped contribution DDL advisory lock.",
  },
  {
    file: "backend/drizzle/contribution-materializations.ts",
    line: "const plan = resolveWriteFencePlan(deps.fenceTarget);",
    site: "J8",
    reason:
      "lockSharedFulltextTable resolves the plan for the shared fulltext table's relation lock.",
  },
  {
    file: "store/store.ts",
    line: 'resolveWriteFencePlan(backend).kind === "unfenced"',
    site: "J9b",
    reason:
      "The Operational Identity construction gate refuses an unfenced backend before any statement runs.",
  },
  {
    file: "store/store.ts",
    line: 'if (resolveWriteFencePlan(backend).kind === "unfenced") {',
    site: "J9a",
    reason:
      "The recorded-clock-allocation construction gate refuses an unfenced backend before any statement runs.",
  },
  {
    file: "backend/drizzle/postgres.ts",
    line: "const plan = resolveWriteFencePlan(fenceTarget);",
    site: "J14",
    reason:
      "acquireSchemaWriteFence resolves the plan for the per-graph schema-commit advisory lock and its FOR UPDATE. Degrades instead of refusing: the CAS it fences still runs unfenced.",
  },
  {
    file: "backend/drizzle/postgres.ts",
    line: "const plan = resolveWriteFencePlan(fenceTarget);",
    site: "J15",
    reason:
      "lockActiveSchemaVersion resolves the plan for the managed writer's FOR SHARE on the active schema row — J14's other half, so the two must resolve one decision.",
  },
];

/** The 5 files every lock site (J1-J8) lives in — zero dialect literals here. */
const LOCK_SITE_FILES: readonly string[] = [
  "store/recorded-capture/clock.ts",
  "identity/service-read.ts",
  "identity/schema-transition.ts",
  "graph-merge/provenance-store.ts",
  "backend/drizzle/contribution-materializations.ts",
];

/**
 * The dialect-literal rows the `(!==|===)` grep shape returns OUTSIDE the
 * lock sites — named so an exemption is a decision, not a silent survivor
 * (M-7, M-8). Re-measured directly against the combined tree: #520 moved
 * temporary-table construction and primary-key constraint naming behind the
 * backend-owned `recordedTableDdl` port, removing the two corresponding
 * dialect comparisons from `migrate-recorded-time.ts`.
 */
const NON_LOCK_EXEMPTIONS: readonly InventoryEntry[] = [
  {
    file: "backend/migrate-recorded-time.ts",
    line: 'target.dialect === "sqlite" ?',
    site: "J12-a",
    reason:
      "columnNames selects which introspection query to run (PRAGMA table_info vs information_schema) — not a lock.",
  },
  {
    file: "backend/migrate-recorded-time.ts",
    line: 'const revisionType = dialect === "postgres" ? "BIGINT" : "INTEGER";',
    site: "J12",
    reason: "Column-type selection in a migration — not a lock.",
  },
  {
    file: "backend/migrate-recorded-time.ts",
    line: 'const recordedAtType = dialect === "postgres" ? "TIMESTAMPTZ" : "TEXT";',
    site: "J12",
    reason: "Column-type selection in a migration — not a lock.",
  },
  {
    file: "backend/migrate-recorded-time.ts",
    line: 'return dialect === "postgres" ?',
    site: "J12",
    reason: "Column-type selection in a migration — not a lock.",
  },
  {
    file: "store/algorithms/iterative-graph-operation.ts",
    line: 'if (rounds.started || ctx.backend.dialect !== "postgres") throw error;',
    site: "J11",
    reason: "A PostgreSQL error-code classification — not a lock.",
  },
  {
    file: "store/algorithms/iterative-graph-operation.ts",
    line: 'ctx.backend.dialect === "postgres" ?',
    site: "J13",
    reason: "A dialect-keyed value selection — not a lock.",
  },
];

/** Every non-lock-site file the dialect-literal scan additionally covers. */
const NON_LOCK_SCANNED_FILES: readonly string[] = [
  "backend/migrate-recorded-time.ts",
  "store/algorithms/iterative-graph-operation.ts",
];

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

function parseFile(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
}

/** Every bare `resolveWriteFencePlan(...)` call in `source`. */
function scanForResolveCalls(
  file: string,
  source: string,
): readonly FoundSite[] {
  const parsed = parseFile(file, source);
  const lines = source.split("\n");
  const sites: FoundSite[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "resolveWriteFencePlan"
    ) {
      // Key on the ENCLOSING STATEMENT's line, not the call expression's own
      // line: J9a/J9b call it inside an `if (...)` condition, where the call
      // expression's own start IS the statement's start, so this is
      // equivalent there and uniform everywhere else too.
      const start = node.getStart(parsed);
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
 * `"sqlite"` case — the two shapes I8's baseline measured (a `switch` is
 * what `clock.ts`'s pre-fix `lockRecordedClock` used, which the
 * `(!==|===)` grep shape does not match at all).
 */
function scanForDialectLiterals(
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

function siteKey(site: Readonly<{ file: string; line: string }>): string {
  return `${site.file} ${site.line}`;
}

/** Both-directions diff, as MULTISETS of {@link siteKey} (see the recursion ratchet this mirrors). */
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

function scanFiles<T>(
  files: readonly string[],
  scanFile: (file: string, source: string) => readonly T[],
): readonly T[] {
  return files.flatMap((relativeFile) => {
    const fullPath = path.join(SOURCE_ROOT, relativeFile);
    return scanFile(relativeFile, fs.readFileSync(fullPath, "utf8"));
  });
}

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

describe("T17 — resolveWriteFencePlan has exactly 12 call sites", () => {
  const found = scanSourceTree(scanForResolveCalls);
  const diff = diffAgainstInventory(found, CALL_SITES);

  it("has exactly the 12 declared call sites, both directions", () => {
    expect(found).toHaveLength(12);
    expect(CALL_SITES).toHaveLength(12);
    const undeclaredReport = diff.undeclared.map(
      (site) => `${site.file}:${String(site.lineNumber)}  ${site.line}`,
    );
    if (undeclaredReport.length > 0) {
      throw new Error(
        `A resolveWriteFencePlan call exists at a site CALL_SITES does not declare:\n\n${undeclaredReport.join("\n")}`,
      );
    }
    const staleReport = diff.stale.map(
      (entry) => `${entry.file}  ${entry.line}`,
    );
    if (staleReport.length > 0) {
      throw new Error(
        `These CALL_SITES entries match no resolveWriteFencePlan call in src — the code moved or the site was removed:\n\n${staleReport.join("\n")}`,
      );
    }
    expect(undeclaredReport).toEqual([]);
    expect(staleReport).toEqual([]);
  });
});

describe("T17 — no dialect literal remains at a lock site; every non-lock row is named", () => {
  const lockSiteFound = scanFiles(LOCK_SITE_FILES, scanForDialectLiterals);
  const nonLockFound = scanFiles(
    NON_LOCK_SCANNED_FILES,
    scanForDialectLiterals,
  );
  const nonLockDiff = diffAgainstInventory(nonLockFound, NON_LOCK_EXEMPTIONS);

  it("has zero dialect-literal comparisons in the 5 lock-site files", () => {
    const reported = lockSiteFound.map(
      (site) => `${site.file}:${String(site.lineNumber)}  ${site.line}`,
    );
    if (reported.length > 0) {
      throw new Error(
        `A dialect literal remains at a lock site — the pessimistic-lock decision has re-acquired a second owner:\n\n${reported.join("\n")}`,
      );
    }
    expect(reported).toEqual([]);
  });

  it("names every dialect-literal row the non-lock files return, both directions", () => {
    const undeclaredReport = nonLockDiff.undeclared.map(
      (site) => `${site.file}:${String(site.lineNumber)}  ${site.line}`,
    );
    if (undeclaredReport.length > 0) {
      throw new Error(
        `A dialect-literal comparison exists that NON_LOCK_EXEMPTIONS does not name:\n\n${undeclaredReport.join("\n")}`,
      );
    }
    const staleReport = nonLockDiff.stale.map(
      (entry) => `${entry.file}  ${entry.line}`,
    );
    if (staleReport.length > 0) {
      throw new Error(
        `These NON_LOCK_EXEMPTIONS entries match no dialect-literal comparison in src — the code moved or was removed:\n\n${staleReport.join("\n")}`,
      );
    }
    expect(undeclaredReport).toEqual([]);
    expect(staleReport).toEqual([]);
  });
});
