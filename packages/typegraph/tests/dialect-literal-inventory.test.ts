/**
 * The dialect-literal ESLint ban's exemption ratchet.
 *
 * `eslint.config.mjs` bans an AST-level `dialect === "postgres"` /
 * `"sqlite"` comparison or `switch (dialect)` across every `.ts` file under
 * `src` (`DIALECT_SEAM_RESTRICTIONS`, spread into every `no-restricted-syntax`
 * block that covers `src`). `DIALECT_LITERAL_EXEMPTIONS`, in that same file,
 * lifts the ban file by file wherever a literal still exists, each entry
 * carrying the reason it may, whether the exemption is permanent or a later
 * commit removes it, and the number of such sites the reason accounts for.
 *
 * This test runs `scanForDialectLiterals` (factored into
 * `./dialect-literal-scan` so this ratchet and
 * `tests/lock-fence-plan-inventory.test.ts` cannot disagree about what a
 * dialect literal is) over the whole of `src/**`, and asserts the set of
 * files it finds equals `DIALECT_LITERAL_EXEMPTIONS`'s file list, both
 * directions: a file that stops branching on dialect fails as loudly as one
 * that starts and is not named. It then asserts each entry's `sites` count
 * against the same scan of that one file, so a reason naming several
 * decisions cannot survive after one of them is removed.
 *
 * `scanForDialectLiterals` is narrower than the ESLint selectors it echoes —
 * see its own docblock — so it is not itself the proof that the ban is wired
 * up everywhere; that is `tests/backend-construction-lint.test.ts`'s
 * DIALECT_SEAM_RESTRICTIONS column, which resolves ESLint's real config for
 * every module. This test only keeps the exemption list honest against the
 * tree.
 *
 * `tests/lock-fence-plan-inventory.test.ts` runs a narrower instance of the
 * same scan (the eight lock sites plus two named non-lock exemptions) to
 * prove the pessimistic-lock decision specifically has not re-acquired an
 * inline dialect check; this ratchet is the whole-tree count the ESLint ban
 * itself needs.
 *
 * *Mutation*: add `dialect === "postgres"` to a file not in
 * `DIALECT_LITERAL_EXEMPTIONS` → the "undeclared" half fails, naming the
 * file, and `pnpm exec eslint` on that file fails too (the same selector).
 * *Mutation*: remove `DIALECT_LITERAL_EXEMPTIONS`'s entry for a file whose
 * literal still exists → the "undeclared" half fails, since the scan still
 * finds it. *Mutation*: keep an exemption entry after its literal is
 * deleted → the "stale" half fails, naming the entry. *Mutation*: delete one
 * of two dialect-literal sites a single entry's `sites: 2` accounts for →
 * the site-count assertion fails, naming the entry, before the file drops out
 * of the "undeclared"/"stale" sets entirely.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DIALECT_LITERAL_EXEMPTIONS } from "../eslint.config.mjs";
import { scanForDialectLiterals } from "./dialect-literal-scan";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

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

/** Every `src/**` file's dialect-literal site count (relative to `src/`, POSIX-separated, prefixed `src/`), zero omitted. */
function siteCountsByFile(): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const full of collectTypeScriptFiles(SOURCE_ROOT)) {
    const relativeToSource = path
      .relative(SOURCE_ROOT, full)
      .replaceAll(path.sep, "/");
    const source = fs.readFileSync(full, "utf8");
    const siteCount = scanForDialectLiterals(relativeToSource, source).length;
    if (siteCount > 0) {
      counts.set(`src/${relativeToSource}`, siteCount);
    }
  }
  return counts;
}

describe("the dialect-literal ban's exemption list matches the tree, both directions", () => {
  const siteCounts = siteCountsByFile();
  const found = new Set(siteCounts.keys());
  const declared = new Set(
    DIALECT_LITERAL_EXEMPTIONS.map((entry) => entry.file),
  );

  it("has one exemption entry per exempted file, with no duplicates", () => {
    expect(DIALECT_LITERAL_EXEMPTIONS.length).toBe(declared.size);
  });

  it("names every file a dialect literal was found in", () => {
    const undeclared = [...found].filter((file) => !declared.has(file));
    if (undeclared.length > 0) {
      throw new Error(
        `A dialect literal exists in a file DIALECT_LITERAL_EXEMPTIONS does not name (eslint.config.mjs):\n\n${undeclared.toSorted().join("\n")}`,
      );
    }
    expect(undeclared).toEqual([]);
  });

  it("declares no exemption for a file that no longer contains a dialect literal", () => {
    const stale = [...declared].filter((file) => !found.has(file));
    if (stale.length > 0) {
      throw new Error(
        `DIALECT_LITERAL_EXEMPTIONS names a file with no dialect literal left in it (eslint.config.mjs) — narrow or delete the entry:\n\n${stale.toSorted().join("\n")}`,
      );
    }
    expect(stale).toEqual([]);
  });

  it("gives every entry a non-empty reason, an explicit permanent flag, and a positive site count", () => {
    for (const entry of DIALECT_LITERAL_EXEMPTIONS) {
      expect(
        entry.reason.length,
        `${entry.file} needs a reason`,
      ).toBeGreaterThan(0);
      expect(
        typeof entry.permanent,
        `${entry.file}'s permanent flag must be a boolean`,
      ).toBe("boolean");
      expect(
        Number.isInteger(entry.sites) && entry.sites > 0,
        `${entry.file}'s sites count must be a positive integer`,
      ).toBe(true);
    }
  });

  it("matches each entry's declared site count against the tree", () => {
    const mismatched = DIALECT_LITERAL_EXEMPTIONS.filter(
      (entry) => siteCounts.get(entry.file) !== entry.sites,
    ).map(
      (entry) =>
        `${entry.file}: declared ${entry.sites}, found ${siteCounts.get(entry.file) ?? 0}`,
    );
    if (mismatched.length > 0) {
      throw new Error(
        `DIALECT_LITERAL_EXEMPTIONS' sites count no longer matches the tree (eslint.config.mjs) — a reason that covered more than one site must narrow as sites are removed:\n\n${mismatched.join("\n")}`,
      );
    }
    expect(mismatched).toEqual([]);
  });
});
