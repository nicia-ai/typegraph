/**
 * THE RATCHET for the prototype-key WRITE class (issue #441).
 *
 * The invariant it enforces: **an accumulator whose keys are DATA is built by
 * {@link createDataKeyedBag}, never by a `{}` literal.** `bag[key] = value` into
 * a `{}` literal does not create an entry when `key` is `__proto__` — it invokes
 * `Object.prototype`'s `__proto__` setter, which reparents the bag for an object
 * value and does nothing at all for a primitive. Either way the value is
 * dropped silently and every later own-key read agrees the writer never wrote
 * it. Kind names, schema property names, JSON-Schema keywords, query aliases and
 * `JSON.parse`d document keys are all data, and all of them admit `__proto__`.
 *
 * This class has now recurred twice because the enumeration was incomplete each
 * time — first the serializer's kind records, then `defineGraph`'s edge
 * accumulator. So it is made self-enforcing rather than re-audited: this test
 * scans `src/**` for statement-position empty-object-literal initializations and
 * fails on any that is not explicitly allowlisted below.
 *
 * ## Honest statement of its limits
 *
 * - **It is SYNTACTIC, not semantic.** It cannot tell a data-keyed accumulator
 *   from a statically-keyed struct; it only knows that a `{}` literal was
 *   assigned in statement position. It therefore flags *every* such site and
 *   relies on the allowlist to record the ones a human has judged safe.
 * - **Consequently it produces false positives, and the allowlist is the
 *   escape hatch.** Every entry carries a one-line reason. Adding an entry
 *   without one is the failure mode this file is trying to prevent.
 * - **It has false NEGATIVES too.** It does not see an object literal that is
 *   initialized with keys (`const bag = { [alias]: … }`) and only later
 *   bracket-assigned with a data key, nor one built by `Object.assign({}, …)`
 *   (which drops an own `__proto__` from its source for the same reason).
 *   Those sites were enumerated by hand in the sweep that shipped this file;
 *   this scan keeps the cheap, common shape from coming back, it does not
 *   replace review.
 *
 * Deliberately NOT a custom ESLint rule: the cost of a rule (a package, a
 * config, a parser dependency) buys nothing a 40ms file scan does not already
 * give, and the allowlist-with-reasons is more legible than inline disables
 * scattered across the tree.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

/**
 * A site the sweep classified as STATICALLY-KEYED (or otherwise not an
 * accumulator), keyed by file plus the exact source line rather than a line
 * number so unrelated edits to the same file do not invalidate it.
 */
type AllowedSite = Readonly<{
  /** Path relative to `packages/typegraph/src`. */
  file: string;
  /** The offending source line, trimmed. */
  line: string;
  /** Why a `{}` literal is correct here. Mandatory. */
  reason: string;
}>;

const ALLOWLIST: readonly AllowedSite[] = [
  {
    file: "backend/drizzle/contribution-materializations.ts",
    line: "} = {};",
    reason:
      "`gated` is keyed by `keyof GatableFulltextBackend` — a closed set of method names written in this file, not data.",
  },
  {
    file: "backend/drizzle/sqlite.ts",
    line: "const taskMarker: object = {};",
    reason:
      "An identity sentinel compared by reference; no key is ever assigned to it.",
  },
  {
    file: "backend/graph-backend-keys.ts",
    line: "> = {};",
    reason:
      "A compile-time exhaustiveness witness (`Record<Exclude<keyof GraphBackend, …>, never>`); never read, never assigned.",
  },
  {
    file: "graph-extension/validation.ts",
    line: "searchable = {};",
    reason:
      "The `{ language?: string }` modifier struct in its default form — a fixed shape, not a bag.",
  },
  {
    file: "interchange/export.ts",
    line: "terminal = {};",
    reason:
      "A `{ error?: unknown }` discriminator marking the channel closed; its one key is written by name in this file.",
  },
  {
    file: "utils/object.ts",
    line: "const result: Record<string, unknown> = {};",
    reason:
      "`compactUndefined` rebuilds an OPTION/STRUCT literal whose keys the caller writes out by name (every call site passes a literal). Its result is a public struct compared with `toStrictEqual`, so it must keep `Object.prototype`.",
  },
];

/**
 * Statement-position `= {}` (`const x = {};`, `x = {};`, or the `> = {};` tail
 * of a multi-line type annotation), plus the `{} as Record<…>` cast form.
 * Default parameter values (`options: Foo = {},` / `= {})`) are excluded by
 * construction: they never end the line at `;`.
 */
const EMPTY_LITERAL_STATEMENT = /=\s*\{\}\s*;\s*$/;
const EMPTY_LITERAL_CAST = /=\s*\{\}\s*as\s/;

type FoundSite = Readonly<{ file: string; lineNumber: number; line: string }>;

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

function scanForEmptyObjectAccumulators(): readonly FoundSite[] {
  const sites: FoundSite[] = [];
  for (const file of collectTypeScriptFiles(SOURCE_ROOT)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.trim();
      // Doc-comment and comment bodies routinely quote `{}` while explaining
      // this very rule.
      if (line.startsWith("*") || line.startsWith("//")) continue;
      if (!EMPTY_LITERAL_STATEMENT.test(line) && !EMPTY_LITERAL_CAST.test(line))
        continue;
      sites.push({
        file: path.relative(SOURCE_ROOT, file).replaceAll(path.sep, "/"),
        lineNumber: index + 1,
        line,
      });
    }
  }
  return sites;
}

/**
 * `file` and `line` joined on a separator neither can contain.
 *
 * Written as the six-character ESCAPE `\u0000`, never as the byte itself: a
 * literal NUL makes the whole file binary to Git, which then refuses to diff it
 * and hides every future edit to this ratchet from review — the failure mode the
 * file exists to prevent, applied to the file itself.
 */
function siteKey(site: Readonly<{ file: string; line: string }>): string {
  return `${site.file}\u0000${site.line}`;
}

describe("data-keyed bag ratchet", () => {
  const sites = scanForEmptyObjectAccumulators();

  it("has no empty-object-literal accumulator outside the allowlist", () => {
    const allowed = new Set(ALLOWLIST.map((entry) => siteKey(entry)));
    const violations = sites.filter((site) => !allowed.has(siteKey(site)));

    const reported = violations.map(
      (site) => `${site.file}:${site.lineNumber}  ${site.line}`,
    );
    if (reported.length > 0) {
      // Thrown rather than asserted so the remediation instructions lead the
      // failure output instead of trailing a diff of anonymous strings.
      throw new Error(
        `A \`{}\` literal was assigned in statement position at a site the allowlist does not cover:\n\n${reported.join("\n")}\n\n` +
          `If its keys are DATA — a kind name, a schema property name, a JSON-Schema keyword, a query alias, anything off \`JSON.parse\` — build it with \`createDataKeyedBag()\` from src/utils/object.ts. A \`bag[key] = value\` with \`key === "__proto__"\` reaches \`Object.prototype\`'s setter and silently drops the value.\n\n` +
          `If its keys are STATIC — an options struct, a discriminated-union member, a fixed lookup table — add it to ALLOWLIST in this file with a one-line reason.`,
      );
    }
    expect(reported).toEqual([]);
  });

  it("has no stale allowlist entry", () => {
    // An allowlist that outlives the code it excuses is how the class comes
    // back: the next reader trusts a list that no longer describes the tree.
    const present = new Set(sites.map((site) => siteKey(site)));
    const stale = ALLOWLIST.filter((entry) => !present.has(siteKey(entry)));

    const reported = stale.map((entry) => `${entry.file}  ${entry.line}`);
    if (reported.length > 0) {
      throw new Error(
        `These allowlist entries no longer match any source line — the code moved or was fixed. Delete them:\n\n${reported.join("\n")}`,
      );
    }
    expect(reported).toEqual([]);
  });

  it("catches a data-keyed accumulator regressed to a `{}` literal", () => {
    // The scanner is itself load-bearing, so it is exercised against the exact
    // line `defineGraph`'s edge accumulator had before the fix. Without this,
    // a scanner that silently matched nothing would still pass both tests
    // above.
    const regressed = "const result: Record<string, EdgeRegistration> = {};";
    expect(EMPTY_LITERAL_STATEMENT.test(regressed)).toBe(true);
    expect(new Set(ALLOWLIST.map((entry) => entry.line))).not.toContain(
      regressed,
    );

    // …and against the shapes it must NOT flag: default parameter values.
    expect(
      EMPTY_LITERAL_STATEMENT.test("options: SqliteBackendOptions = {},"),
    ).toBe(false);
    expect(
      EMPTY_LITERAL_STATEMENT.test(
        "export function createSqlSchema(names: Partial<SqlTableNames> = {}): SqlSchema {",
      ),
    ).toBe(false);
  });

  it("scans the tree cheaply enough to stay in the unit suite", () => {
    const started = performance.now();
    const rescan = scanForEmptyObjectAccumulators();
    const elapsedMs = performance.now() - started;

    expect(rescan.length).toBe(sites.length);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("requires a reason on every allowlist entry", () => {
    const missing = ALLOWLIST.filter(
      (entry) => entry.reason.trim().length < 20,
    );
    expect(missing.map((entry) => entry.file)).toEqual([]);
  });
});

describe("source text stays reviewable", () => {
  it("has no NUL byte in any source or test file", () => {
    // Git classifies a file containing a NUL byte as BINARY: it prints "Binary
    // files differ" instead of a diff, GitHub renders nothing, and every edit to
    // that file passes review unread. This ratchet file itself shipped a literal
    // NUL as a separator and was invisible for exactly that reason — so the
    // check is the whole tree, not the one file, because the next one will be
    // somewhere else. Write the six-character escape (`\u0000`) instead.
    const roots = [SOURCE_ROOT, path.dirname(fileURLToPath(import.meta.url))];
    const offenders = roots
      .flatMap((root) => collectTypeScriptFiles(root))
      .filter((file) => fs.readFileSync(file).includes(0))
      .map((file) => path.relative(SOURCE_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
