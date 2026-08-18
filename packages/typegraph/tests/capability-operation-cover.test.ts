/**
 * T11b — expands every operation row's `sites` against the COMMITTED
 * baseline fixture (never the live scan — that is B9's), and checks the
 * cover of the fixture's 58 `pilot` keys: each covered exactly once, no
 * stale `(file, member)` attribution, and the 2 `statically-required` keys
 * plus the 1 `not-an-access` key excluded BY NAME rather than by falling
 * out of the count.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CAPABILITY_BUNDLES } from "../src/backend/capabilities/bundle-registry";

type BaselineRow = Readonly<{
  file: string;
  line: number;
  member: string;
  class: "pilot" | "statically-required" | "not-an-access";
}>;

type BaselineFixture = Readonly<{
  commit: string;
  command: string;
  rows: readonly BaselineRow[];
}>;

function loadBaseline(): BaselineFixture {
  const fixturePath = path.join(
    import.meta.dirname,
    "fixtures",
    "bundle-member-access-baseline.json",
  );
  return JSON.parse(readFileSync(fixturePath, "utf8")) as BaselineFixture;
}

const EXCLUDED_BY_NAME: readonly Readonly<{
  file: string;
  line: number;
}>[] = [
  { file: "store/materialize-removals.ts", line: 670 },
  { file: "graph-merge/provenance-store.ts", line: 430 },
  { file: "store/recorded-capture/guards.ts", line: 64 },
];

function rowKey(row: Pick<BaselineRow, "file" | "line" | "member">): string {
  return `${row.file}:${row.line}:${row.member}`;
}

/**
 * Expands every operation row's `sites` against the baseline, returning:
 * - `coveredKeys`: a map from baseline row key to the list of `(bundle,
 *   operation)` pairs that covered it (length > 1 is a double-cover defect).
 * - `staleAttributions`: `(file, member[, lines])` attributions naming no
 *   baseline row at all.
 */
function expandCover(baseline: BaselineFixture): Readonly<{
  coveredKeys: Map<string, string[]>;
  staleAttributions: string[];
}> {
  const coveredKeys = new Map<string, string[]>();
  const staleAttributions: string[] = [];

  for (const bundle of CAPABILITY_BUNDLES) {
    for (const operation of bundle.operations) {
      const owner = `${bundle.id}/${operation.operation}`;
      for (const site of operation.sites) {
        const lines = (site as Readonly<{ lines?: readonly number[] }>).lines;
        const candidates = baseline.rows.filter(
          (row) =>
            row.file === site.file &&
            row.member === site.member &&
            (lines === undefined || lines.includes(row.line)),
        );
        if (candidates.length === 0) {
          staleAttributions.push(
            `${owner}: ${site.file}#${site.member}${
              lines === undefined ? "" : ` lines=${lines.join(",")}`
            }`,
          );
          continue;
        }
        for (const candidate of candidates) {
          const key = rowKey(candidate);
          const owners = coveredKeys.get(key) ?? [];
          owners.push(owner);
          coveredKeys.set(key, owners);
        }
      }
    }
  }

  return { coveredKeys, staleAttributions };
}

describe("capability operation cover against the committed baseline (T11b)", () => {
  it("covers every one of the 57 `pilot` keys exactly once", () => {
    const baseline = loadBaseline();
    const pilotRows = baseline.rows.filter((row) => row.class === "pilot");
    expect(pilotRows).toHaveLength(57);

    const { coveredKeys, staleAttributions } = expandCover(baseline);
    expect(staleAttributions, "stale attributions").toEqual([]);

    const uncovered: string[] = [];
    const doubleCovered: string[] = [];
    for (const row of pilotRows) {
      const key = rowKey(row);
      const owners = coveredKeys.get(key);
      if (owners === undefined || owners.length === 0) {
        uncovered.push(key);
      } else if (owners.length > 1) {
        doubleCovered.push(`${key} <- ${owners.join(", ")}`);
      }
    }
    expect(uncovered, "uncovered pilot keys").toEqual([]);
    expect(doubleCovered, "keys covered by more than one operation").toEqual(
      [],
    );
  });

  it("every (file, member) attribution resolves to at least one baseline key", () => {
    const baseline = loadBaseline();
    const { staleAttributions } = expandCover(baseline);
    expect(staleAttributions).toEqual([]);
  });

  it("excludes the 2 statically-required and 1 not-an-access keys BY NAME", () => {
    const baseline = loadBaseline();
    for (const excluded of EXCLUDED_BY_NAME) {
      const row = baseline.rows.find(
        (candidate) =>
          candidate.file === excluded.file && candidate.line === excluded.line,
      );
      expect(row, `${excluded.file}:${excluded.line}`).toBeDefined();
      expect(row?.class).not.toBe("pilot");
    }
    const nonPilotCount = baseline.rows.filter(
      (row) => row.class !== "pilot",
    ).length;
    expect(nonPilotCount).toBe(3);
  });

  it("58 + 2 + 1 = 61", () => {
    const baseline = loadBaseline();
    expect(baseline.rows).toHaveLength(61);
  });
});
