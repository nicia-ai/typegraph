/**
 * T9 — runtime witness for the pilot capability-bundle registry's totality
 * and disjointness (I5).
 *
 * The compile-time proofs at the bottom of `bundle-registry.ts` guarantee
 * this holds for the TYPE; this suite is the runtime witness over the DATA,
 * so a drift between the type-level names and the actual `as const` values
 * (which the type-level proofs cannot see, since they only see the inferred
 * literal types) fails a test rather than only failing silently at the type
 * level in some future edit.
 */
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_BUNDLES,
  UNBUNDLED_OPTIONAL_MEMBERS,
  WS5B_SEED_BUNDLES,
} from "../src/backend/capabilities/bundle-registry";

function bundledMembers(): readonly string[] {
  const members: string[] = [];
  for (const bundle of CAPABILITY_BUNDLES) {
    if ("core" in bundle) members.push(...bundle.core);
    if ("extras" in bundle) {
      for (const extra of bundle.extras) members.push(...extra.members);
    }
  }
  return members;
}

describe("capability bundle totality (T9)", () => {
  it("15 pilot + 70 unbundled = 85, with no member counted twice", () => {
    const bundled = bundledMembers();
    const bundledSet = new Set(bundled);
    expect(bundled.length).toBe(bundledSet.size);
    expect(bundledSet.size).toBe(15);

    const unbundledNames = Object.keys(UNBUNDLED_OPTIONAL_MEMBERS);
    expect(unbundledNames.length).toBe(70);

    const overlap = unbundledNames.filter((name) => bundledSet.has(name));
    expect(overlap).toEqual([]);

    expect(bundledSet.size + unbundledNames.length).toBe(85);
  });

  it("pairwise bundle member sets are disjoint", () => {
    const seen = new Map<string, string>();
    for (const bundle of CAPABILITY_BUNDLES) {
      const members: string[] = [];
      if ("core" in bundle) members.push(...bundle.core);
      if ("extras" in bundle) {
        for (const extra of bundle.extras) members.push(...extra.members);
      }
      for (const member of members) {
        const owner = seen.get(member);
        expect(
          owner,
          `"${member}" claimed by both "${owner}" and "${bundle.id}"`,
        ).toBeUndefined();
        seen.set(member, bundle.id);
      }
    }
  });

  it("every `reasoned` entry carries a non-empty reason", () => {
    for (const [name, entry] of Object.entries(UNBUNDLED_OPTIONAL_MEMBERS)) {
      if (entry.kind !== "reasoned") continue;
      expect(
        entry.reason.length,
        `"${name}" has an empty reason`,
      ).toBeGreaterThan(0);
    }
  });

  it("every `deferred` entry carries a bundle and a ceiling", () => {
    for (const [name, entry] of Object.entries(UNBUNDLED_OPTIONAL_MEMBERS)) {
      if (entry.kind !== "deferred") continue;
      expect(entry.workstream).toBe("WS5b");
      expect(typeof entry.bundle, `"${name}" has no bundle`).toBe("string");
      expect(
        entry.ceiling,
        `"${name}" has a negative ceiling`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("grouping `deferred` entries by bundle reproduces WS5B_SEED_BUNDLES exactly", () => {
    const grouped = new Map<string, Set<string>>();
    for (const [name, entry] of Object.entries(UNBUNDLED_OPTIONAL_MEMBERS)) {
      if (entry.kind !== "deferred") continue;
      const members = grouped.get(entry.bundle) ?? new Set<string>();
      members.add(name);
      grouped.set(entry.bundle, members);
    }

    const seedBundleIds = Object.keys(WS5B_SEED_BUNDLES);
    expect([...grouped.keys()].toSorted()).toEqual(
      [...seedBundleIds].toSorted(),
    );

    for (const [bundleId, members] of grouped) {
      const seedMembers =
        WS5B_SEED_BUNDLES[bundleId as keyof typeof WS5B_SEED_BUNDLES];
      expect([...members].toSorted(), `bundle "${bundleId}"`).toEqual(
        [...seedMembers].toSorted(),
      );
    }
  });

  it("22 reasoned entries sum to 68 accesses; 48 deferred entries sum to 197", () => {
    const entries = Object.values(UNBUNDLED_OPTIONAL_MEMBERS);
    const reasoned = entries.filter((entry) => entry.kind === "reasoned");
    const deferred = entries.filter((entry) => entry.kind === "deferred");
    expect(reasoned.length).toBe(22);
    expect(deferred.length).toBe(48);
    // B9's scanner corrected two grep-tier undercounts with type-aware
    // evidence: `tableNames` 22->23 (store/store.ts:1001 holds two accesses
    // on one physical line) and `ensureIdentityTables` 3->4
    // (identity/schema-transition.ts:228 is a real access the grep
    // receiver-name filter never matched). 58 -> 60; #520 then added the
    // one live `recordedTableDdl` access.
    expect(reasoned.reduce((sum, entry) => sum + entry.accesses, 0)).toBe(68);
    expect(deferred.reduce((sum, entry) => sum + entry.ceiling, 0)).toBe(197);
  });
});
