/**
 * The conversion ratchets for `tests/**` (T27, T28).
 *
 * `tests/**` now carries the `no-restricted-syntax` construction block, so a new
 * `{ ...backend }` is a lint error and the two sites that cannot be converted
 * are suppressed inline with their reason.
 *
 * The block is NAME-based, though, and both classes have members it cannot see:
 * a `{ ...real }` is audit-relevant and reports nothing, and the
 * transaction-scoped sources are named `tx` / `target`. So both counting
 * ratchets survive the block rather than retiring with it — the type-aware
 * scanner applies the same decision a type-aware rule would, and it is already
 * being built here for the transaction-scoped class, so keeping the
 * audit-relevant count costs one more assertion over the same scan.
 *
 * The exemption list is measured against ESLint's OWN report: an entry here is
 * a suppression ESLint says it applied, not a claim this file makes about the
 * tree. Both directions are asserted, so neither a converted site with a
 * lingering entry nor an inline directive nobody declared survives.
 */
import fs from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import {
  BACKEND_MUTATION_MESSAGE,
  BACKEND_SEAM_MESSAGE,
} from "../eslint.config.mjs";
import {
  type BackendDerivationClass,
  scanSelectorVisibleLines,
  scanTestBackendDerivations,
  sitesOfClass,
} from "./backend-derivation-scan";

const packageRoot = path.resolve(import.meta.dirname, "..");

/**
 * Audit-relevant derivations still built outside the seam.
 *
 * Both are declared exemptions with an inline directive (see EXEMPT_SITES), so
 * the baseline is the exemption list's size: every convertible site is
 * converted. The ratchet is not redundant with the lint block — the block's
 * selectors are name-based, so a `{ ...real }` or a `{ ...double }` is
 * audit-relevant and reports nothing, and this scan resolves the type instead.
 *
 * Emitted by the scanner in this commit, not transcribed.
 */
const AUDIT_RELEVANT_BASELINE = 2;

/**
 * Transaction-scoped derivations — the reasoned exemption class.
 *
 * A transaction-scoped backend is unaudited by construction, so a spread of one
 * copies a verdict that does not exist and drops nothing: the #435 failure mode
 * is structurally unreachable through them. The count is ratcheted so the class
 * cannot grow, and it becomes audit-relevant (and converted) the day
 * transaction-scoped backends start carrying a verdict.
 *
 * Emitted by the scanner in this commit, not transcribed.
 */
const TRANSACTION_SCOPED_BASELINE = 35;

/** The two messages the construction block reports. */
const CONSTRUCTION_MESSAGES = new Set([
  BACKEND_SEAM_MESSAGE,
  BACKEND_MUTATION_MESSAGE,
]);

type ExemptSite = Readonly<{
  /** Package-relative, POSIX-separated. */
  file: string;
  /** The offending source line, trimmed. */
  text: string;
  derivationClass: BackendDerivationClass;
}>;

/**
 * Sites that stay unconverted for a stated reason, rather than because nobody
 * has got to them yet.
 *
 * The reason itself is NOT repeated here: it lives in the inline
 * `eslint-disable-next-line no-restricted-syntax -- …` justification at the
 * site, which is where a reader meets the code, and the assertion below reads
 * that justification out of ESLint's report. One owner for the reason, so the
 * two copies cannot drift apart.
 */
const EXEMPT_SITES: readonly ExemptSite[] = [
  {
    file: "tests/transaction-surface-honesty.test.ts",
    text: "const { executeRaw: omittedExecuteRaw, ...backendWithoutExecuteRaw } =",
    derivationClass: "audit-relevant",
  },
  {
    file: "tests/test-utils.ts",
    text: "...backend,",
    derivationClass: "audit-relevant",
  },
];

/**
 * `file` and `text` joined on a separator neither can contain.
 *
 * Written as the six-character ESCAPE, never as the byte itself: a literal NUL
 * makes the whole file binary to Git, which then refuses to diff it and hides
 * every future edit to this ratchet from review.
 */
function siteKey(site: Readonly<{ file: string; text: string }>): string {
  return `${site.file}\u0000${site.text}`;
}

/** Every `tests/**` module, as a package-relative POSIX path. */
function testModules(): readonly string[] {
  return fs
    .readdirSync(path.join(packageRoot, "tests"), {
      encoding: "utf8",
      recursive: true,
    })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.posix.join("tests", entry.split(path.sep).join("/")))
    .toSorted();
}

/**
 * The `tests/**` modules that carry an inline suppression of the construction
 * ban, whatever it suppresses.
 *
 * A text scan rather than a lint of the whole tree: linting `tests/**` under
 * the project service costs minutes, and the files that can possibly hold a
 * suppression are exactly the files that spell the directive. Every one of them
 * is then linted for real, so an undeclared directive is caught.
 */
function modulesWithInlineSuppression(): readonly string[] {
  return testModules().filter((file) => {
    const source = fs.readFileSync(path.join(packageRoot, file), "utf8");
    return (
      source.includes("eslint-disable") &&
      source.includes("no-restricted-syntax")
    );
  });
}

type ReportedSuppression = Readonly<{
  file: string;
  line: number;
  text: string;
  justification: string;
}>;

/**
 * Every construction-ban report ESLint suppressed in `files`, as ESLint itself
 * reports it.
 */
async function reportedSuppressions(
  files: readonly string[],
): Promise<readonly ReportedSuppression[]> {
  if (files.length === 0) return [];
  const eslint = new ESLint({ cwd: packageRoot });
  const results = await eslint.lintFiles([...files]);
  return results.flatMap((result) => {
    const file = path
      .relative(packageRoot, result.filePath)
      .split(path.sep)
      .join("/");
    const lines = fs
      .readFileSync(result.filePath, "utf8")
      .split("\n")
      .map((line) => line.trim());
    return result.suppressedMessages
      .filter(
        (message) =>
          message.ruleId === "no-restricted-syntax" &&
          CONSTRUCTION_MESSAGES.has(message.message),
      )
      .map((message) => ({
        file,
        line: message.line,
        text: lines[message.line - 1] ?? "",
        justification: message.suppressions
          .map((suppression) => suppression.justification)
          .join(" "),
      }));
  });
}

describe("backend derivation population", () => {
  const scan = scanTestBackendDerivations();
  const auditRelevant = sitesOfClass(scan, "audit-relevant");
  const transactionScoped = sitesOfClass(scan, "transaction-scoped");

  it("has no more audit-relevant derivations than the recorded baseline", () => {
    if (auditRelevant.length > AUDIT_RELEVANT_BASELINE) {
      const added = auditRelevant.map(
        (site) => `${site.file}:${site.line}  ${site.text}`,
      );
      throw new Error(
        `tests/** now builds ${auditRelevant.length} audit-relevant backend derivations outside the seam; the recorded baseline is ${AUDIT_RELEVANT_BASELINE}.\n\n` +
          `Build the new one through src/backend/derive-backend.ts — deriveBackend to decorate, projectBackendWithout to narrow by omission — so it carries the source's serialized-resource verdict. A spread builds a NEW object the audit does not follow, and the import/clone guards then let a read-and-write-through-one-connection stream proceed into a deadlock (#435).\n\n` +
          `The tests/** lint block reports the spellings a NAME selector can see; this scan resolves the type, so it also reports the ones it cannot.\n\n` +
          `Current sites:\n${added.join("\n")}`,
      );
    }
    expect(auditRelevant.length).toBeLessThanOrEqual(AUDIT_RELEVANT_BASELINE);
  });

  it("has no more transaction-scoped derivations than the recorded baseline", () => {
    if (transactionScoped.length > TRANSACTION_SCOPED_BASELINE) {
      const sites = transactionScoped.map(
        (site) => `${site.file}:${site.line}  ${site.text}`,
      );
      throw new Error(
        `tests/** now builds ${transactionScoped.length} transaction-scoped backend derivations; the recorded baseline is ${TRANSACTION_SCOPED_BASELINE}.\n\n` +
          `The exempt class is reasoned, not open: a transaction-scoped backend carries no verdict, so copying one drops nothing. Growing it still costs — every member converts on the day transaction-scoped backends start being audited. Derive through the seam instead.\n\n` +
          `Current sites:\n${sites.join("\n")}`,
      );
    }
    expect(transactionScoped.length).toBeLessThanOrEqual(
      TRANSACTION_SCOPED_BASELINE,
    );
  });

  it("reports near misses so a new generic helper is classified by hand", () => {
    // Never asserted: a near miss is a spread whose source type has `getNode`
    // but fails the whole-backend marker test — a members fragment, or a
    // generic helper whose constraint is narrower than the backends it is
    // really called with. The scanner cannot decide which; a human must.
    if (scan.nearMisses.length > 0) {
      process.stdout.write(
        `Backend-derivation near misses (classify by hand):\n${scan.nearMisses
          .map((site) => `  ${site.file}:${site.line}  ${site.text}`)
          .join("\n")}\n`,
      );
    }
    expect(scan.nearMisses.length).toBeGreaterThanOrEqual(0);
  });

  it("has no stale exemption entry", () => {
    // An exemption that outlives the code it excuses is how the class comes
    // back: the next reader trusts a list that no longer describes the tree.
    const present = new Set(scan.sites.map((site) => siteKey(site)));
    const stale = EXEMPT_SITES.filter((entry) => !present.has(siteKey(entry)));
    expect(stale.map((entry) => `${entry.file}  ${entry.text}`)).toEqual([]);
  });

  it("keeps every exemption in the class it was filed under", () => {
    const classByKey = new Map(
      scan.sites.map((site) => [siteKey(site), site.derivationClass]),
    );
    const misfiled = EXEMPT_SITES.filter(
      (entry) => classByKey.get(siteKey(entry)) !== entry.derivationClass,
    );
    expect(misfiled.map((entry) => `${entry.file}  ${entry.text}`)).toEqual([]);
  });

  it(
    "declares exactly the suppressions ESLint reports, each with a reason",
    { timeout: 120_000 },
    async () => {
      // The list is checked against the linter's own answer, not against a
      // re-implementation of it: a site that no longer violates has an unused
      // directive (a lint error in its own right under
      // `reportUnusedDisableDirectives`) and drops out of this report, and a
      // directive nobody declared shows up here without an entry.
      const suppressions = await reportedSuppressions(
        modulesWithInlineSuppression(),
      );

      const declared = new Set(EXEMPT_SITES.map((entry) => siteKey(entry)));
      const undeclared = suppressions.filter(
        (suppression) => !declared.has(siteKey(suppression)),
      );
      expect(
        undeclared.map(
          (suppression) =>
            `${suppression.file}:${suppression.line}  ${suppression.text}`,
        ),
      ).toEqual([]);

      const suppressed = new Set(
        suppressions.map((suppression) => siteKey(suppression)),
      );
      const unsuppressed = EXEMPT_SITES.filter(
        (entry) => !suppressed.has(siteKey(entry)),
      );
      expect(
        unsuppressed.map((entry) => `${entry.file}  ${entry.text}`),
      ).toEqual([]);

      // A suppression with no justification is an exemption with no reason.
      const unreasoned = suppressions.filter(
        (suppression) => suppression.justification.trim().length === 0,
      );
      expect(
        unreasoned.map(
          (suppression) => `${suppression.file}:${suppression.line}`,
        ),
      ).toEqual([]);
    },
  );

  it(
    "leaves no exempt-class member visible to the construction selectors",
    { timeout: 120_000 },
    async () => {
      // What makes the exempt class safe now that `tests/**` carries the
      // construction ban: a member the selectors DO report would be a lint
      // error, and the only way to keep it would be a suppression for a site
      // whose exemption argues from a class the ban does not cover.
      const files = [...new Set(transactionScoped.map((site) => site.file))];
      const visibleLines = await scanSelectorVisibleLines(files);
      const visible = transactionScoped.filter((site) =>
        visibleLines.get(site.file)?.has(site.line),
      );
      expect(
        visible.map((site) => `${site.file}:${site.line}  ${site.text}`),
      ).toEqual([]);
    },
  );
});
