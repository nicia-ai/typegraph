/**
 * T17 (I8) — the write-fence decision has exactly ONE owner.
 *
 * Three ratchets, all comment-stripped AST scans over `src/**` (modelled on
 * `tests/recursive-traversal-inventory.test.ts`):
 *
 *  1. `resolveWriteFencePlan` has exactly **16** call sites — the 8 lock
 *     sites (J1-J8), the 2 construction gates (J9a recorded-clock
 *     ownership, J9b identity), the adopted-transaction writer-slot proof
 *     (J9c), the 3 consumers of the PostgreSQL schema fence (J14
 *     commit-side, J15 writer-side, J16 the writer-side clause folded into
 *     the fused managed-insert programs), the shared SQL engine
 *     factory's own resolution (J17, `createSqlBackend`), and the
 *     trusted-import table lock (J18) — enumerated in both directions,
 *     keyed on `(file, trimmed line)` so line drift cannot rot the pin.
 *
 *     J18 is not one of J1-J8: those eight sites are the ones that used to
 *     spell `dialect === "postgres"` inline before this ratchet, while
 *     trusted import's PostgreSQL/SQLite split was always made by calling a
 *     different exported function per engine, never by a dialect literal.
 *     It joins the model here because its table lock now resolves the SAME
 *     plan the other lock sites do, and is the plan's one table-lock-alone
 *     consumer — see `write-fence.ts`'s note next to
 *     `planFromLockCapabilities`.
 *
 *     J17 resolves the plan once, immediately after a profile's capability
 *     tail runs and before any member group is assembled, and gates
 *     `markSchemaFencedInsertEligible` on the result: a profile whose plan
 *     resolves `unfenced` earns every other mark this factory can hand out,
 *     but not that one, since the fused insert's lock clause is
 *     profile-supplied and an empty one is only correct when writers are
 *     actually serialized.
 *
 *     J14 and J15 REFUSE like J1-J8: both fence a read-then-write sequence
 *     that spans statements, so the lock is what makes the check binding
 *     through to the write, and skipping it would leave a check-then-write
 *     race rather than a slower but correct path. J16 is the ONLY degrading
 *     site, because its predicate lives INSIDE the insert statement: one
 *     statement cannot race itself, so an empty clause is correct at any
 *     isolation level — which is the posture SQLite has always run in.
 *  2. Zero dialect-literal comparisons (any `===`/`!==`/`==`/`!=` comparison
 *     with a `"postgres"`/`"sqlite"` string literal as either operand, or a
 *     `case` clause testing one — an EXACT mirror of the ESLint selectors,
 *     with no requirement that either side of the comparison, or the
 *     enclosing switch's discriminant, be named `dialect`) remain in the
 *     eight lock sites' five files. The same scan run over the
 *     two files that legitimately still branch on dialect for reasons that
 *     are NOT the pessimistic-lock decision (`backend/migrate-recorded-time.ts`
 *     DDL/column-type selection, `store/algorithms/iterative-graph-operation.ts`
 *     Postgres error-code classification and value selection) finds every row
 *     it returns NAMED — J10-J13 — so an exemption is a decision recorded
 *     here, not a silent survivor of the ratchet's own file scope. The scan
 *     itself (`scanForDialectLiterals`) lives in `./dialect-literal-scan` —
 *     `tests/dialect-literal-inventory.test.ts` runs the SAME scan over the
 *     whole of `src/**` for the ESLint ban's exemption list, so the two
 *     ratchets cannot disagree about what a dialect literal is.
 *  3. The four PostgreSQL lock-statement tokens (`pg_advisory_xact_lock`,
 *     `hashtext(`, `LOCK TABLE`, `current_setting('transaction_isolation')`)
 *     appear in exactly one module under all of `src/`,
 *     `backend/drizzle/postgres-fence-sql.ts`, which owns the spelling.
 *     Every lock site — the J-rows above, `backend/drizzle/trusted-import.ts`
 *     (J18), and the extension-install lock in `backend/drizzle/postgres.ts`
 *     — consumes a resolved plan's `fence.sql.*` instead, and the one
 *     PostgreSQL-only builder that lives outside the plan composes the
 *     resolved fence target's own `advisoryLockExpression` /
 *     `isolationFactExpression` members. The whole tree is scanned; the only
 *     permitted mentions outside the owning module are the prose rows in
 *     {@link FENCE_TOKEN_PROSE_EXEMPTIONS}, asserted both directions.
 *
 * *Mutation*: re-inline a dialect check at any lock site → fails naming the
 * file (both the "no resolveWriteFencePlan call added" half and the
 * "dialect literal reappeared" half catch this, from different angles).
 * *Mutation*: pin the `resolveWriteFencePlan` count at 10 (the number before
 * the Postgres schema fence's three consumers joined the model) → fails.
 * *Mutation*: pin it at 15 (the number before trusted import's table lock
 * joined the model) → fails. *Mutation*: re-inline
 * `pg_advisory_xact_lock(hashtext(...))` in a lock site
 * or in `operations/schema.ts` → fails naming the file. *Mutation*: empty out
 * `postgres-fence-sql.ts`'s builders → fails the module's own positive check.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  type FoundSite,
  parseFile,
  scanForDialectLiterals,
} from "./dialect-literal-scan";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

type InventoryEntry = Readonly<{
  file: string;
  line: string;
  site: string;
  reason: string;
}>;

/** The 11 `resolveWriteFencePlan` call sites (Contract J, I8). */
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
    line: "const identityFencePlan = resolveWriteFencePlan(backend);",
    site: "J9b",
    reason:
      "The Operational Identity construction gate refuses an unfenced backend before any statement runs.",
  },
  {
    file: "store/store.ts",
    line: "const clockFencePlan = resolveWriteFencePlan(backend);",
    site: "J9a",
    reason:
      "The recorded-clock-allocation construction gate refuses an unfenced backend before any statement runs.",
  },
  {
    file: "store/operations/write-transaction.ts",
    line: 'resolveWriteFencePlan(target).kind !== "engine-serialized"',
    site: "J9c",
    reason:
      "An adopted engine-serialized transaction proves its writer slot before any constrained-write read.",
  },
  {
    file: "backend/drizzle/postgres.ts",
    line: "resolveWriteFencePlan(fenceTarget),",
    site: "J14",
    reason:
      "acquireSchemaWriteFence resolves the plan for the per-graph schema-commit advisory lock and its FOR UPDATE. Refuses an unfenced backend: commitSchemaVersion reads the active version and writes the flip in separate statements, and says so in its own comment.",
  },
  {
    file: "backend/drizzle/postgres.ts",
    line: "resolveWriteFencePlan(fenceTarget),",
    site: "J15",
    reason:
      "lockActiveSchemaVersion resolves the plan for the managed writer's FOR SHARE on the active schema row — J14's other half, so the two must resolve one decision. Refuses an unfenced backend: the transaction HOLDS this lock across the writes it fences.",
  },
  {
    file: "backend/drizzle/postgres.ts",
    line: "const plan = resolveWriteFencePlan(fenceTarget);",
    site: "J16",
    reason:
      "schemaFenceInsertLockClause resolves the plan for the FOR SHARE the fused managed-insert programs carry INSIDE their own statement. The ONLY degrading site: an in-statement predicate cannot race itself, so an empty clause stays correct.",
  },
  {
    file: "backend/drizzle/engine/create-sql-backend.ts",
    line: "const fencePlan = resolveWriteFencePlan(fenceTarget);",
    site: "J17",
    reason:
      "createSqlBackend builds the ONE fence target from a profile's finalized capabilities and resolves the plan once, before any member group is assembled, and gates markSchemaFencedInsertEligible on the result — every dialect profile this factory assembles shares this one resolution.",
  },
  {
    file: "backend/drizzle/trusted-import.ts",
    line: "const plan = resolveWriteFencePlan(backend);",
    site: "J18",
    reason:
      "lockPostgresTrustedImportTables resolves the plan for the trusted-import table lock. The one site that takes a table lock with no advisory lock preceding it — the import owns the whole node and edge relations for its duration and runs inside its own transaction.",
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

describe("T17 — resolveWriteFencePlan has exactly 16 call sites", () => {
  const found = scanSourceTree(scanForResolveCalls);
  const diff = diffAgainstInventory(found, CALL_SITES);

  it("has exactly the 16 declared call sites, both directions", () => {
    expect(found).toHaveLength(16);
    expect(CALL_SITES).toHaveLength(16);
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

/**
 * The four literal PostgreSQL lock-statement tokens `postgres-fence-sql.ts`
 * is the one module in `src/` (outside `src/query/dialect/`) allowed to
 * spell — see that module's own docstring.
 */
const FENCE_TOKENS: readonly string[] = [
  "pg_advisory_xact_lock",
  "hashtext(",
  "LOCK TABLE",
  "current_setting('transaction_isolation')",
];

/** The module that owns every one of {@link FENCE_TOKENS}. */
const FENCE_MODULE_FILE = "backend/drizzle/postgres-fence-sql.ts";

/**
 * The only string or template literals anywhere under `src/`, outside
 * {@link FENCE_MODULE_FILE}, that mention one of {@link FENCE_TOKENS} — and
 * every one is prose, not a spelling: `unfencedRefusalMessage`'s two
 * dialect-description strings name the capability a backend should declare
 * ("an engine that honors `pg_advisory_xact_lock` and `LOCK TABLE`"). The
 * whole source tree is scanned, so a new file that spells a lock statement
 * itself fails here; a new prose mention is declared as a row, with its
 * reason, or it fails too. Asserted both directions.
 */
const FENCE_TOKEN_PROSE_EXEMPTIONS: readonly InventoryEntry[] = [
  {
    file: "backend/capabilities/write-fence.ts",
    line: '"an engine that honors `pg_advisory_xact_lock` and `LOCK TABLE`"',
    site: "prose",
    reason:
      "The PostgreSQL half of the unfenced refusal's dialect description — names the capability to declare, spells no statement.",
  },
  {
    file: "backend/capabilities/write-fence.ts",
    line: '"an engine that honors `pg_advisory_xact_lock` and `LOCK TABLE`"',
    site: "prose",
    reason:
      "The same description for the other dialect's recommendation line in that message.",
  },
];

/** String and template-literal AST tokens — comments and identifiers never match. */
function isStringOrTemplatePart(
  node: ts.Node,
): node is ts.StringLiteral | ts.TemplateLiteralToken {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddleOrTemplateTail(node)
  );
}

/**
 * Every physical line, within a string or template-literal AST node, that
 * contains at least one of {@link FENCE_TOKENS} — an AST scan rather than a
 * plain grep so a token named in a comment (this file's own docstrings
 * above, `write-fence.ts`'s, etc.) is never mistaken for a real spelling.
 * Deduplicated by line: two tokens on the same physical line (`postgres-
 * fence-sql.ts`'s `pg_advisory_xact_lock(hashtext(` is both at once) report
 * as one site — a dedup this scan needs because it matches literal
 * SUBSTRINGS within one string/template node, not whole AST nodes the way
 * `scanForDialectLiterals` above does; that scan needs no such dedup, since
 * each `BinaryExpression` or `case` clause it counts is already its own
 * node.
 */
function scanForFenceTokens(
  file: string,
  source: string,
): readonly FoundSite[] {
  const parsed = parseFile(file, source);
  const lines = source.split("\n");
  const sites: FoundSite[] = [];
  const recordedLineNumbers = new Set<number>();

  function recordAt(position: number): void {
    const { line } = parsed.getLineAndCharacterOfPosition(position);
    const lineNumber = line + 1;
    if (recordedLineNumbers.has(lineNumber)) return;
    recordedLineNumbers.add(lineNumber);
    sites.push({ file, lineNumber, line: (lines[line] ?? "").trim() });
  }

  function visit(node: ts.Node): void {
    if (isStringOrTemplatePart(node)) {
      // Search the RAW source slice, not the decoded `.text`: a multi-line
      // template head's `.text` and the source slice agree here (none of
      // these files escape a backtick or `${` inside a fence statement), and
      // slicing lets `start + index` map straight back to a source position
      // without re-deriving an offset from decoded text.
      const start = node.getStart(parsed);
      const raw = source.slice(start, node.end);
      for (const token of FENCE_TOKENS) {
        let searchFrom = 0;
        for (;;) {
          const index = raw.indexOf(token, searchFrom);
          if (index === -1) break;
          recordAt(start + index);
          searchFrom = index + token.length;
        }
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  }

  visit(parsed);
  return sites;
}

describe("T17 — the four PostgreSQL lock-statement tokens have exactly one owner", () => {
  const treeFound = scanSourceTree(scanForFenceTokens).filter(
    (site) => site.file !== FENCE_MODULE_FILE,
  );
  const proseDiff = diffAgainstInventory(
    treeFound,
    FENCE_TOKEN_PROSE_EXEMPTIONS,
  );
  const schemaFound = scanFiles(
    ["backend/drizzle/operations/schema.ts"],
    scanForFenceTokens,
  );
  const moduleFound = scanFiles([FENCE_MODULE_FILE], scanForFenceTokens);

  it(`has no fence lock-statement token anywhere under src/ outside ${FENCE_MODULE_FILE} beyond the declared prose rows`, () => {
    const reported = proseDiff.undeclared.map(
      (site) => `${site.file}:${String(site.lineNumber)}  ${site.line}`,
    );
    if (reported.length > 0) {
      throw new Error(
        `A PostgreSQL lock-statement token appears outside ${FENCE_MODULE_FILE} and is not a declared prose row — the lock spelling has re-acquired a second owner:\n\n${reported.join("\n")}`,
      );
    }
    expect(reported).toEqual([]);
  });

  it("declares no prose row that the tree no longer contains", () => {
    expect(
      proseDiff.stale.map((entry) => `${entry.file}  ${entry.line}`),
    ).toEqual([]);
  });

  it("operations/schema.ts specifically contains none of the four tokens", () => {
    expect(schemaFound).toEqual([]);
  });

  it(`${FENCE_MODULE_FILE} spells all four lock-statement tokens`, () => {
    for (const token of FENCE_TOKENS) {
      expect(
        moduleFound.some((site) => site.line.includes(token)),
        `expected ${FENCE_MODULE_FILE} to contain "${token}"`,
      ).toBe(true);
    }
  });
});
