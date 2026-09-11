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
  it("15 pilot + 83 unbundled = 98, with no member counted twice", () => {
    const bundled = bundledMembers();
    const bundledSet = new Set(bundled);
    expect(bundled.length).toBe(bundledSet.size);
    expect(bundledSet.size).toBe(15);

    const unbundledNames = Object.keys(UNBUNDLED_OPTIONAL_MEMBERS);
    expect(unbundledNames.length).toBe(83);

    const overlap = unbundledNames.filter((name) => bundledSet.has(name));
    expect(overlap).toEqual([]);

    expect(bundledSet.size + unbundledNames.length).toBe(98);
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

  it("33 reasoned entries sum to 97 accesses; 50 deferred entries sum to 219", () => {
    const entries = Object.values(UNBUNDLED_OPTIONAL_MEMBERS);
    const reasoned = entries.filter((entry) => entry.kind === "reasoned");
    const deferred = entries.filter((entry) => entry.kind === "deferred");
    expect(reasoned.length).toBe(33);
    expect(deferred.length).toBe(50);
    // B9's scanner corrected two grep-tier undercounts with type-aware
    // evidence: `tableNames` 22->23 (store/store.ts:1001 holds two accesses
    // on one physical line) and `ensureIdentityTables` 3->4
    // (identity/schema-transition.ts:228 is a real access the grep
    // receiver-name filter never matched). 58 -> 60; #520 then added the
    // one live `recordedTableDdl` access. The required command port no longer
    // belongs in this optional-member inventory. Durable identity adoption
    // adds one empty-kind fence and one optional preflight selection. The
    // set-based edge-delete fallback adds one batch write access, and atomic
    // node-delete refusal diagnosis adds one heterogeneous endpoint-set read.
    // Resolving the write-fence spelling through the fence plan then added
    // `fenceSql`, a reasoned member with 2 live accesses: every lock site
    // reads `fence.sql`, never `.fenceSql` itself, except the one dialect-
    // gated isolation check that has no resolved plan to read a spelling
    // through (see the registry's own entry) — 88 -> 90. The catalog-
    // introspection bag then added `catalog`, a reasoned member whose own
    // absence refusal lives in backend/capabilities/ — a directory the live
    // scanner excludes wholesale — so its measured access count is 0 and
    // the floor is unchanged. The forked working-copy strategy then reads
    // the connected backend's `tableNames` to fence them against the base
    // store's resolved schema — 90 -> 91. Item D.2's acyclicity probe reads
    // `tableNames` twice more to build the `SqlSchema` its ontology-
    // tightening preflight and constraint-fence audit families need — 91
    // -> 93. The merge planner's seed-hop acyclicity conflict detection reads
    // `tableNames` once more to build the `SqlSchema` its plan-time preview
    // needs — 93 -> 94. The composition delete cascade's parts-closure read
    // then added a 5th `findEdgesByHeterogeneousEndpointSet` consumer,
    // raising its ceiling by one — 217 -> 218. Item E's composition
    // tightening then adds one more `tableNames` access on top of that: the
    // preflight's SEPARATE D-10 check over the full proposed composition
    // relation builds its own `SqlSchema`, alongside the ontology
    // acyclicity probe's — 94 -> 95. The lineage capability then added
    // `lineage`, a reasoned member with two live accesses (`resolveLineage`'s
    // two reads of the backend's own `lineage`, in
    // `store/recorded-capture/lineage.ts`) — 95 -> 97. A prior fix round
    // briefly grew that further by re-deriving `resolveLineage(target)`'s
    // resolution and comparing it against the transaction handle's own
    // `lineage` by identity inside `assertTargetUnchanged` — a dead read
    // (`LineageMembers` took no session argument, so the comparison never
    // actually pinned anything to the transaction). Giving `revision`/
    // `changesSince` a real `session` parameter made that comparison
    // unnecessary: `assertTargetUnchanged` now reaches `lineage` through
    // `requireLineage(txBackend, …)`, which reads `.lineage` inside
    // `backend/capabilities/`, outside the scanner's scope — back to 97.
    // The engine-native recorded-time capability then added `recordedTime`,
    // a reasoned member with zero measured accesses for the same reason as
    // `catalog`: every current read is either inside `backend/capabilities/`
    // or off `EngineProvisioning`, never off a `GraphBackend`/
    // `TransactionBackend`-typed receiver — still 97. The deferred ceilings
    // moved 218 -> 219 when the unattached-parts audit began reading one
    // page's attachment candidates through
    // `findEdgesByHeterogeneousEndpointSet` (its 6th consumer).
    expect(reasoned.reduce((sum, entry) => sum + entry.accesses, 0)).toBe(97);
    expect(deferred.reduce((sum, entry) => sum + entry.ceiling, 0)).toBe(219);
  });
});
