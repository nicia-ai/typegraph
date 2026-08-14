/**
 * THE LIVE ACCESS-INVENTORY RATCHET (I6, T21) — the live counterpart to
 * `tests/capability-operation-cover.test.ts` (T11b), which is pinned to the
 * COMMITTED baseline fixture at `b688c48` and never re-scans the tree. This
 * suite calls `scanBundleMemberAccesses` directly and pins every one of the
 * six buckets it partitions `src/**`'s `OptionalGraphBackendMember` accesses
 * into, so a scattered read that regresses I6's "no new pilot residue"
 * invariant — or a `deferred` ceiling a future change quietly exceeds (T21)
 * — fails here, not just in a human's re-reading of the registry.
 *
 * Every pinned constant below is re-derived from the scan itself, published
 * in the batch report alongside the reproduction command
 * (`node --import tsx scripts/bundle-member-access-scan.ts`), never
 * hand-adjusted to make a number agree with prose.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  NOT_AN_ACCESS_SITES,
  scanBundleMemberAccesses,
  STATICALLY_REQUIRED_SITES,
} from "../scripts/bundle-member-access-scan";
import {
  type ReasonedUnbundledMember,
  UNBUNDLED_OPTIONAL_MEMBERS,
} from "../src/backend/capabilities/bundle-registry";

const PILOT_COUNT = 0;
const ANNOTATED_RESIDUE_COUNT = 7;
const ANNOTATED_RESIDUE_PAIR_COUNT = 3;
const STATICALLY_REQUIRED_COUNT = 2;
const REASONED_FLOOR = 60;
const DEFERRED_LIVE_TOTAL = 187;
const DEFERRED_DECLARED_TOTAL = 190;
const TOTAL_ROW_COUNT = 256;

function rowKey(
  row: Readonly<{ file: string; line: number; member: string }>,
): string {
  return `${row.file}:${row.line}#${row.member}`;
}

function pairKey(row: Readonly<{ file: string; member: string }>): string {
  return `${row.file}#${row.member}`;
}

function readSourceFile(sourceRelativePath: string): string {
  return readFileSync(
    path.join(import.meta.dirname, "..", "src", sourceRelativePath),
    "utf8",
  );
}

describe("live bundle member access scan (I6, T21)", () => {
  // Resolved once, at collection time — the same pattern
  // `tests/backend-derivation-population.test.ts` uses for its own
  // ts.Program-backed scan. Building the program costs a couple of seconds;
  // paying that cost inside the FIRST `it()` risked the default 5s per-test
  // budget under file-parallel load, even though `scanBundleMemberAccesses`
  // itself memoizes.
  const scan = scanBundleMemberAccesses();

  it("reports zero pilot-class accesses (I6 target, T22(d))", () => {
    const pilotRows = scan.rows.filter((row) => row.class === "pilot");
    expect(
      pilotRows.map((row) => rowKey(row)),
      "every pilot-class row must be rewired or annotated away; none remain",
    ).toEqual([]);
    expect(scan.byClass.pilot).toBe(PILOT_COUNT);
  });

  it("the annotated pilot residue is exactly 7 rows over 3 (file, member) pairs", () => {
    const annotatedRows = scan.rows.filter(
      (row) => row.class === "annotated-residue",
    );
    expect(annotatedRows.length).toBe(ANNOTATED_RESIDUE_COUNT);
    const pairs = new Set(annotatedRows.map((row) => pairKey(row)));
    expect(pairs.size).toBe(ANNOTATED_RESIDUE_PAIR_COUNT);
    expect([...pairs].toSorted()).toEqual(
      [
        "identity/sql-target.ts#executeStatement",
        "store/recorded-capture/guards.ts#executeStatement",
        "backend/migrate-recorded-time.ts#executeStatement",
      ].toSorted(),
    );
  });

  it("a name match on a non-port receiver is not an access", () => {
    const scannedKeys = new Set(scan.rows.map((row) => rowKey(row)));
    for (const site of NOT_AN_ACCESS_SITES) {
      // (ii) the snippet still occurs verbatim in the file, so this assertion
      // cannot pass vacuously after an unrelated edit moves the line — and it
      // lets us find the exact line the (i) check below must be absent at,
      // since some of these (file, member) pairs (guards.ts#executeStatement)
      // legitimately have OTHER, real access rows at different lines.
      const contents = readSourceFile(site.file);
      const snippetIndex = contents.indexOf(site.snippet);
      expect(
        snippetIndex,
        `expected to find the snippet ${JSON.stringify(site.snippet)} in src/${site.file}`,
      ).toBeGreaterThanOrEqual(0);
      const snippetLine = contents.slice(0, snippetIndex).split("\n").length;

      // (i) the (file, line, member) key never appears in the live scan.
      const appearsAsAccess = scan.rows.some(
        (row) =>
          row.file === site.file &&
          row.member === site.member &&
          row.line === snippetLine,
      );
      expect(
        appearsAsAccess,
        `${site.file}:${snippetLine}#${site.member} (${site.reason}) must never be reported as an access`,
      ).toBe(false);
    }
    // The fixture row the accepted mutation forces into the scan: a
    // verdict-record receiver reported as pilot only when the receiver test
    // is broken (Mutation B). Under the real receiver test it must be absent.
    expect(scannedKeys.has("store/store.ts:4373#verifyContributions")).toBe(
      false,
    );
  });

  it("every reasoned member's live count equals its declared `accesses`", () => {
    const mismatches: string[] = [];
    let reasonedTotal = 0;
    for (const [member, entry] of Object.entries(UNBUNDLED_OPTIONAL_MEMBERS)) {
      if (entry.kind !== "reasoned") continue;
      const reasoned = entry as ReasonedUnbundledMember;
      const live = scan.perMember[member] ?? 0;
      reasonedTotal += live;
      if (live !== reasoned.accesses) {
        mismatches.push(
          `${member}: live=${live} declared=${reasoned.accesses}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
    expect(reasonedTotal).toBe(REASONED_FLOOR);
    expect(scan.byClass.reasoned).toBe(REASONED_FLOOR);
  });

  it("no deferred member exceeds its ceiling", () => {
    const overages: string[] = [];
    let deferredLiveTotal = 0;
    let deferredDeclaredTotal = 0;
    for (const [member, entry] of Object.entries(UNBUNDLED_OPTIONAL_MEMBERS)) {
      if (entry.kind !== "deferred") continue;
      const live = scan.perMember[member] ?? 0;
      deferredLiveTotal += live;
      deferredDeclaredTotal += entry.ceiling;
      if (live > entry.ceiling) {
        const offendingLines = scan.rows
          .filter((row) => row.member === member)
          .map((row) => `${row.file}:${row.line}`)
          .join(", ");
        overages.push(
          `${member}: live=${live} exceeds ceiling=${entry.ceiling} (${offendingLines})`,
        );
      }
    }
    expect(overages).toEqual([]);
    expect(deferredLiveTotal).toBe(DEFERRED_LIVE_TOTAL);
    expect(deferredDeclaredTotal).toBe(DEFERRED_DECLARED_TOTAL);
    expect(scan.byClass.deferred).toBe(DEFERRED_LIVE_TOTAL);
  });

  it("the class partition covers every scanned row (total 256)", () => {
    // STATICALLY_REQUIRED_SITES asserted positively: each must appear in the
    // scan output, so an arm-(b) regression that stops resolving them fails
    // loudly here rather than silently shrinking the bucket.
    for (const site of STATICALLY_REQUIRED_SITES) {
      const matches = scan.rows.filter(
        (row) =>
          row.file === site.file &&
          row.member === site.member &&
          row.class === "statically-required",
      );
      expect(
        matches.length,
        `expected at least one statically-required row for ${site.file}#${site.member} (${site.declaringType})`,
      ).toBeGreaterThan(0);
    }
    expect(scan.byClass["statically-required"]).toBe(STATICALLY_REQUIRED_COUNT);

    const sum =
      scan.byClass.pilot +
      scan.byClass["annotated-residue"] +
      scan.byClass["statically-required"] +
      scan.byClass.reasoned +
      scan.byClass.deferred;
    expect(sum).toBe(scan.rows.length);
    expect(scan.rows.length).toBe(TOTAL_ROW_COUNT);

    const knownClasses = new Set<string>([
      "pilot",
      "annotated-residue",
      "statically-required",
      "reasoned",
      "deferred",
    ]);
    const unclassified = scan.rows.filter(
      (row) => !knownClasses.has(row.class),
    );
    expect(
      unclassified.map((row) => rowKey(row)),
      "every scanned row must fall into exactly one of the five classes",
    ).toEqual([]);
  });
});
