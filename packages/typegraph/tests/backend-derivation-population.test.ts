/**
 * The conversion ratchets for `tests/**` (T27, T28).
 *
 * `tests/**` has no `no-restricted-syntax` block yet — the construction ban is
 * `src`-only until the bulk conversion lands — so the thing that keeps the gap
 * from widening in the meantime is measurement, not lint: the type-aware
 * scanner counts every backend derivation in the test tree, by class, and both
 * counts are ratcheted non-increasing.
 *
 * The scanner sees what a name-based selector cannot (a spread of `real`, of
 * `base`, of a generic parameter), which is the point of running it here rather
 * than trusting the selectors: a new `{ ...backend }` fails this file whether or
 * not ESLint would ever have reported it.
 */
import { describe, expect, it } from "vitest";

import {
  type BackendDerivationClass,
  scanSelectorVisibleLines,
  scanTestBackendDerivations,
  sitesOfClass,
} from "./backend-derivation-scan";

/**
 * Audit-relevant derivations still built outside the seam.
 *
 * Emitted by the scanner in this commit, not transcribed: 95 sites awaiting the
 * bulk conversion, plus the one declared exemption below that cannot be
 * converted at all.
 */
const AUDIT_RELEVANT_BASELINE = 96;

/**
 * Transaction-scoped derivations — the reasoned exemption class.
 *
 * A transaction-scoped backend is unaudited by construction, so a spread of one
 * copies a verdict that does not exist and drops nothing: the #435 failure mode
 * is structurally unreachable through them. The count is ratcheted so the class
 * cannot grow, and it becomes audit-relevant (and converted) the day
 * transaction-scoped backends start carrying a verdict.
 */
const TRANSACTION_SCOPED_BASELINE = 36;

type ExemptSite = Readonly<{
  /** Package-relative, POSIX-separated. */
  file: string;
  /** The offending source line, trimmed. */
  text: string;
  derivationClass: BackendDerivationClass;
  /** Why this site is not converted. Mandatory. */
  reason: string;
}>;

/**
 * Sites that stay unconverted for a stated reason, rather than because nobody
 * has got to them yet.
 *
 * In this commit the list is measured by the scanner above. The commit that
 * adds the `tests/**` ESLint block re-points the selector-visibility half at
 * ESLint's own report and adds the inline `eslint-disable` directives these
 * entries stand in for — one cannot land earlier, because
 * `reportUnusedDisableDirectives` makes a directive that precedes its rule a
 * lint error in its own right.
 */
const EXEMPT_SITES: readonly ExemptSite[] = [
  {
    file: "tests/transaction-surface-honesty.test.ts",
    text: "const { executeRaw: omittedExecuteRaw, ...backendWithoutExecuteRaw } =",
    derivationClass: "audit-relevant",
    reason:
      "The destructure IS the fixture. The case asserts that a projection preserves the ABSENCE of an optional member on a structurally wider input; feeding it a projectBackendWithout result makes the input already a projection and the assertion tautological — a load-bearing test converted into a decorative one.",
  },
  {
    file: "tests/test-utils.ts",
    text: "...backend,",
    derivationClass: "audit-relevant",
    reason:
      "`disableTransactions` models a driver that is NOT a serialized resource, so the double must not read as one. deriveBackend carries the base's verdict and a verdict is written once, so deriving from a better-sqlite3-backed base and then auditing the result `independent` throws the write-once refusal. A fresh object leaves the double unaudited, which takes the stream lease's no-op arm exactly as `independent` would. Blocks the `tests/**` block: it is selector-visible.",
  },
];

/**
 * Transaction-scoped sites the name selectors DO report (`...txBackend` ends in
 * `Backend`). They cannot stay in the exempt class past the commit that adds
 * the `tests/**` block, so they are declared as scheduled work rather than as
 * exemptions.
 */
const PENDING_CONVERSIONS: readonly Omit<ExemptSite, "derivationClass">[] = [
  {
    file: "tests/collection-api.test.ts",
    text: "...txBackend,",
    reason:
      "Selector-visible transaction-scoped derivation; converted with the rest of this file in the bulk conversion, in the same commit as the `tests/**` construction ban.",
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

  it("keeps every exemption in the class its reason argues about", () => {
    const classByKey = new Map(
      scan.sites.map((site) => [siteKey(site), site.derivationClass]),
    );
    const misfiled = EXEMPT_SITES.filter(
      (entry) => classByKey.get(siteKey(entry)) !== entry.derivationClass,
    );
    expect(misfiled.map((entry) => `${entry.file}  ${entry.text}`)).toEqual([]);
  });

  it(
    "leaves no exempt-class member visible to the construction selectors",
    { timeout: 120_000 },
    async () => {
      // What makes the exempt class safe once `tests/**` gains the construction
      // ban: a member the selectors DO report would make that commit red. Only
      // the sites declared as scheduled work may be visible.
      const files = [...new Set(transactionScoped.map((site) => site.file))];
      const visibleLines = await scanSelectorVisibleLines(files);
      const visible = transactionScoped.filter((site) =>
        visibleLines.get(site.file)?.has(site.line),
      );
      const scheduled = new Set(
        PENDING_CONVERSIONS.map((entry) => siteKey(entry)),
      );

      const undeclared = visible.filter(
        (site) => !scheduled.has(siteKey(site)),
      );
      expect(
        undeclared.map((site) => `${site.file}:${site.line}  ${site.text}`),
      ).toEqual([]);

      // ...and in the other direction: a scheduled entry that is no longer
      // visible has been converted, and its entry must go with it.
      const visibleKeys = new Set(visible.map((site) => siteKey(site)));
      const stale = PENDING_CONVERSIONS.filter(
        (entry) => !visibleKeys.has(siteKey(entry)),
      );
      expect(stale.map((entry) => `${entry.file}  ${entry.text}`)).toEqual([]);
    },
  );
});
