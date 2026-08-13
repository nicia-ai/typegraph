/**
 * I6 baseline ratchet — records `tests/backends/adapter-test-suite.ts`'s
 * three skip axes (member-presence guards, the `skipRawQueries` option, and
 * the unguarded transaction group) as measured today, both directions, so a
 * new guard, a split conjunction, a new `capabilities.` read, or a renamed
 * option all fail loudly instead of silently widening what the kit can skip
 * unnoticed.
 */
import { describe, expect, it } from "vitest";

import {
  type MemberGuard,
  scanAdapterSuiteSkipAxes,
} from "./adapter-suite-skip-axis-scan";

/**
 * Recorded at `29d63ec` by {@link scanAdapterSuiteSkipAxes}.
 *
 * **Provenance pins, not the population ratchet.** These three
 * `RECORDED_*` constants (and the three `it` cases below that assert them
 * verbatim) pin absolute line numbers in `tests/backends/adapter-test-suite.ts`.
 * WS6's B4 will edit that file and shift every line, failing these three
 * cases with line-drift noise rather than a population change — when that
 * happens, re-baseline the line numbers here rather than relaxing the
 * assertion. The line-INSENSITIVE case that actually carries the invariant
 * is "names exactly ten distinct guarded members, both directions", below:
 * that one is the population ratchet.
 */
const RECORDED_GUARDS: readonly MemberGuard[] = [
  { line: 141, members: ["insertNodeNoReturn"], form: "single" },
  { line: 160, members: ["insertNodesBatch"], form: "single" },
  { line: 192, members: ["insertNodesBatchReturning"], form: "single" },
  { line: 217, members: ["getNodes"], form: "single" },
  { line: 464, members: ["insertEdgeNoReturn"], form: "single" },
  { line: 483, members: ["insertEdgesBatch"], form: "single" },
  { line: 515, members: ["insertEdgesBatchReturning"], form: "single" },
  { line: 548, members: ["getEdges"], form: "single" },
  { line: 1191, members: ["compileSql"], form: "single" },
  { line: 1202, members: ["compileSql", "executeRaw"], form: "conjunction" },
];

const RECORDED_OPTION_AXIS_SITES = [71, 90, 1161];
const RECORDED_UNGUARDED_TRANSACTION_CALL_LINES = [1035, 1061, 1082, 1096];

describe("adapter suite skip axes", () => {
  // Provenance pin — see the comment on RECORDED_GUARDS above.
  it("has the recorded ten guards (nine single, one conjunction), both directions", () => {
    const inventory = scanAdapterSuiteSkipAxes();

    expect(inventory.guards.length).toBe(10);
    expect(inventory.guards).toEqual(RECORDED_GUARDS);

    const singleGuards = inventory.guards.filter(
      (guard) => guard.form === "single",
    );
    const conjunctionGuards = inventory.guards.filter(
      (guard) => guard.form === "conjunction",
    );
    expect(singleGuards.length).toBe(9);
    expect(conjunctionGuards.length).toBe(1);
  });

  // The population ratchet — line-insensitive; see the comment on
  // RECORDED_GUARDS above.
  it("names exactly ten distinct guarded members, both directions", () => {
    const inventory = scanAdapterSuiteSkipAxes();
    const scannedMembers = new Set(
      inventory.guards.flatMap((guard) => guard.members),
    );
    const recordedMembers = new Set(
      RECORDED_GUARDS.flatMap((guard) => guard.members),
    );

    expect(scannedMembers.size).toBe(10);
    for (const member of scannedMembers) {
      expect(
        recordedMembers.has(member),
        `unrecorded guarded member: ${member}`,
      ).toBe(true);
    }
    for (const member of recordedMembers) {
      expect(
        scannedMembers.has(member),
        `recorded member no longer guarded: ${member}`,
      ).toBe(true);
    }
  });

  // Provenance pin — see the comment on RECORDED_GUARDS above.
  it("has the recorded skipRawQueries option-axis sites", () => {
    const inventory = scanAdapterSuiteSkipAxes();
    expect(inventory.optionAxisSites).toEqual(RECORDED_OPTION_AXIS_SITES);
  });

  it("reads no capability member (AST-scanned property access off backend.capabilities)", () => {
    const inventory = scanAdapterSuiteSkipAxes();
    expect(inventory.capabilityReadLines).toEqual([]);
  });

  // Provenance pin — see the comment on RECORDED_GUARDS above.
  it("has the recorded unguarded transaction call lines", () => {
    const inventory = scanAdapterSuiteSkipAxes();
    expect(inventory.unguardedTransactionCallLines).toEqual(
      RECORDED_UNGUARDED_TRANSACTION_CALL_LINES,
    );
  });
});
