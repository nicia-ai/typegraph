/**
 * I9 baseline ratchet — records today's "no Drizzle here" claim sites (13
 * occurrences across 11 files, repo-root-rooted) as a both-directions
 * inventory. A new unqualified claim and a stale recorded row are both
 * defects: the former lets an unaudited claim of Drizzle absence ship, the
 * latter lets the two most consumer-visible ones (the shipped README, the
 * whole heading in `backend-setup.md`) quietly drop off the ledger.
 *
 * NOTE ON THIS FILE'S OWN TEXT: every recorded `text` value below is split
 * across a string concatenation at the boundary between the claim word and
 * its suffix, so this file's own source never spells the claim phrase
 * contiguously — `scripts/drizzle-claim-inventory.ts` also scans `.ts` files
 * repo-wide, and a literal, unbroken occurrence here would inflate its own
 * recorded count.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scanClaimSites } from "../scripts/drizzle-claim-inventory";

const CLAIM_WORD = "Drizzle";

/** Derived by `node --import tsx scripts/drizzle-claim-inventory.ts`. */
type RecordedClaimSite = Readonly<{
  file: string;
  text: string;
}> &
  (Readonly<{ line: number }> | Readonly<{ anchor: "exact-text-in-file" }>);

const RECORDED_CLAIM_SITES: readonly RecordedClaimSite[] = [
  {
    file: "README.md",
    line: 118,
    text:
      "strategy authors can use the complete " +
      CLAIM_WORD +
      "-free contract vocabulary from",
  },
  {
    file: "apps/docs/src/content/docs/architecture.md",
    line: 673,
    text:
      "graph DSL and its schema-derived types from the " + CLAIM_WORD + "-free",
  },
  {
    file: "apps/docs/src/content/docs/architecture.md",
    line: 675,
    text:
      "import the full " +
      CLAIM_WORD +
      "-free port vocabulary, including `GraphBackend`,",
  },
  {
    file: "apps/docs/src/content/docs/backend-setup.md",
    anchor: "exact-text-in-file",
    text: "## " + CLAIM_WORD + "-Free Entrypoints",
  },
  {
    file: "apps/docs/src/content/docs/fulltext-search.md",
    line: 661,
    text: "from the " + CLAIM_WORD + "-free backend-authoring entrypoint.",
  },
  {
    file: "packages/typegraph/README.md",
    line: 43,
    text:
      CLAIM_WORD +
      "-free `@nicia-ai/typegraph/core` entrypoint. Custom backend, dialect, and",
  },
  {
    file: "packages/typegraph/README.md",
    line: 44,
    text:
      "search-strategy authors can import the complete " +
      CLAIM_WORD +
      "-free contract vocabulary",
  },
  {
    file: "packages/typegraph/src/backend/index.ts",
    line: 2,
    text:
      "* " +
      CLAIM_WORD +
      "-free contracts for backend and query-strategy authors.",
  },
  {
    file: "packages/typegraph/src/backend/table-contribution.ts",
    line: 13,
    text:
      "* " +
      CLAIM_WORD +
      "-free, so declaring contributions does not pull the concrete",
  },
  {
    file: "packages/typegraph/src/query/dialect/fulltext-strategy.ts",
    line: 144,
    text:
      "* The tables this strategy owns, as " + CLAIM_WORD + "-free, already",
  },
  {
    file: "packages/typegraph/src/query/dialect/vector-strategy.ts",
    line: 144,
    text:
      "* The per-field storage this strategy owns for `slot`, as " +
      CLAIM_WORD +
      "-free",
  },
  {
    file: "packages/typegraph/tests/table-contribution.test.ts",
    line: 122,
    text:
      "// through `ownedTables` (" +
      CLAIM_WORD +
      "-free) and it flows into emitted DDL.",
  },
  {
    file: "packages/typegraph/type-smoke/strict-local-consumers.ts",
    line: 126,
    text:
      "// declaration graph must remain " +
      CLAIM_WORD +
      "-free even though Drizzle itself is",
  },
];

function matchesRecordedSite(
  scanned: Readonly<{ file: string; line: number; text: string }>,
  recorded: RecordedClaimSite,
): boolean {
  if (scanned.file !== recorded.file) return false;
  if ("line" in recorded) return scanned.line === recorded.line;
  return scanned.text === recorded.text;
}

describe("drizzle claim-site inventory", () => {
  it("does not inventory mutation-testing workspaces", () => {
    const root = mkdtempSync(path.join(tmpdir(), "typegraph-claim-inventory-"));
    const mutationDirectory = path.join(root, ".stryker-tmp", "sandbox");
    try {
      mkdirSync(mutationDirectory, { recursive: true });
      writeFileSync(
        path.join(root, "visible.md"),
        "A " + CLAIM_WORD + "-free public contract.\n",
      );
      writeFileSync(
        path.join(mutationDirectory, "copied.md"),
        "A " + CLAIM_WORD + "-free copied contract.\n",
      );

      expect(scanClaimSites(root)).toEqual([
        {
          file: "visible.md",
          line: 1,
          text: "A " + CLAIM_WORD + "-free public contract.",
        },
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("has the recorded shape: 13 occurrences across 11 files", () => {
    expect(RECORDED_CLAIM_SITES.length).toBe(13);
    expect(new Set(RECORDED_CLAIM_SITES.map((site) => site.file)).size).toBe(
      11,
    );
  });

  it("matches scanClaimSites() both directions", () => {
    const scanned = scanClaimSites();

    expect(scanned.length).toBe(13);
    expect(new Set(scanned.map((site) => site.file)).size).toBe(11);

    for (const site of scanned) {
      expect(
        RECORDED_CLAIM_SITES.some((recorded) =>
          matchesRecordedSite(site, recorded),
        ),
        `claim site not in the recorded inventory: ${site.file}:${site.line}`,
      ).toBe(true);
    }

    for (const recorded of RECORDED_CLAIM_SITES) {
      expect(
        scanned.some((site) => matchesRecordedSite(site, recorded)),
        `recorded claim site no longer exists: ${recorded.file}`,
      ).toBe(true);
    }

    for (const recorded of RECORDED_CLAIM_SITES) {
      const scannedSite = scanned.find((site) =>
        matchesRecordedSite(site, recorded),
      );
      expect(scannedSite?.text).toBe(recorded.text);
    }
  });

  it("counts every recorded file's occurrences", () => {
    const scanned = scanClaimSites();
    const countsByFile = new Map<string, number>();
    for (const site of scanned) {
      countsByFile.set(site.file, (countsByFile.get(site.file) ?? 0) + 1);
    }

    const recordedCountsByFile = new Map<string, number>();
    for (const site of RECORDED_CLAIM_SITES) {
      recordedCountsByFile.set(
        site.file,
        (recordedCountsByFile.get(site.file) ?? 0) + 1,
      );
    }

    expect(Object.fromEntries(countsByFile)).toEqual(
      Object.fromEntries(recordedCountsByFile),
    );
  });
});
