/**
 * I-INVENTORY: every file under `tests/perf/` is registered in
 * {@link PERF_FIXTURES} with a mode, an engine list, a guarded regression and a
 * named mutation, and every fixture's gating matches what its own mode
 * promises — report-mode fixtures are gated on `TYPEGRAPH_PERF=1`, assert-mode
 * fixtures are not. Both the manifest and this suite read the directory and
 * the oracle file live rather than assuming either stays put.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PGLITE_GLOBS } from "../../vitest.config";
import {
  PERF_FIXTURES,
  type PerfFixture,
  type PerfFixtureEngine,
  type PerfFixtureMode,
  scanPerfFixtureFiles,
} from "./inventory";

const THIS_FILE_PATH = fileURLToPath(import.meta.url);
const PERF_DIRECTORY = path.dirname(THIS_FILE_PATH);
const THIS_FILE_NAME = path.basename(THIS_FILE_PATH);

// The exact gate EXPRESSION a fixture must bind to a local constant to count
// as gated: `const <identifier> = process.env["TYPEGRAPH_PERF"] === "1";`.
// Captures the identifier so callers can confirm it — not just some
// identifier — is the one threaded into `.runIf(...)`; two independent
// substring/regex checks that never compare identifiers would let a fixture
// declare an unused gate constant and wire `.runIf(...)` to a different,
// always-true value.
const PERF_ENV_GATE_PATTERN =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\["TYPEGRAPH_PERF"\]\s*===\s*"1"/gu;

/** Every identifier a file binds to the `TYPEGRAPH_PERF` gate expression. */
function perfGateIdentifiers(source: string): readonly string[] {
  return [...source.matchAll(PERF_ENV_GATE_PATTERN)]
    .map((match) => match[1])
    .filter((identifier): identifier is string => identifier !== undefined);
}

/** Whether `identifier` is passed as the bare argument to some `.runIf(...)` call. */
function identifierGatesRunIf(source: string, identifier: string): boolean {
  const pattern = new RegExp(String.raw`\.runIf\(\s*${identifier}\s*\)`, "u");
  return pattern.test(source);
}

function assertDefined<T>(
  value: T | undefined,
  message: string,
): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

function fixtureSource(fileName: string): string {
  return readFileSync(path.join(PERF_DIRECTORY, fileName), "utf8");
}

function fixturesWithMode(mode: PerfFixtureMode): readonly PerfFixture[] {
  return PERF_FIXTURES.filter((fixture) => fixture.mode === mode);
}

function fixturesWithEngine(engine: PerfFixtureEngine): readonly PerfFixture[] {
  return PERF_FIXTURES.filter((fixture) => fixture.engines.includes(engine));
}

describe("tests/perf inventory", () => {
  it("registers every file under tests/perf", () => {
    const registered = new Set(PERF_FIXTURES.map((fixture) => fixture.file));
    const actual = new Set(scanPerfFixtureFiles());

    // Non-vacuity: a broken scan reading an empty directory must not pass as
    // "everything is registered".
    expect(actual.size).toBeGreaterThan(0);
    expect(registered).toEqual(actual);
  });

  it("gates every report-mode fixture on TYPEGRAPH_PERF=1", () => {
    const reportFixtures = fixturesWithMode("report");
    expect(reportFixtures.length).toBeGreaterThan(0);

    for (const fixture of reportFixtures) {
      const source = fixtureSource(fixture.file);
      const gateIdentifiers = perfGateIdentifiers(source);
      assertDefined(
        gateIdentifiers[0],
        `${fixture.file} must bind process.env["TYPEGRAPH_PERF"] === "1" to a local constant`,
      );
      if (
        !gateIdentifiers.some((identifier) =>
          identifierGatesRunIf(source, identifier),
        )
      ) {
        throw new Error(
          `${fixture.file} declares a TYPEGRAPH_PERF gate constant but never passes that same identifier to .runIf(...)`,
        );
      }
    }
  });

  it("keeps every assert-mode fixture ungated so normal CI runs it", () => {
    // Excludes THIS file: its own comment above spells the gate pattern out
    // as prose (`const <identifier> = process.env["TYPEGRAPH_PERF"] === "1"`)
    // to document it, which the live scan cannot distinguish from a real
    // binding. Every OTHER assert-mode fixture has no reason to mention the
    // pattern at all.
    const assertFixtures = fixturesWithMode("assert").filter(
      (fixture) => fixture.file !== THIS_FILE_NAME,
    );
    expect(assertFixtures.length).toBeGreaterThan(0);

    for (const fixture of assertFixtures) {
      const source = fixtureSource(fixture.file);
      if (perfGateIdentifiers(source).length > 0) {
        throw new Error(
          `${fixture.file} must not bind a TYPEGRAPH_PERF gate (assert-mode fixtures always run)`,
        );
      }
    }
  });

  it("names an existing guarded file and a mutation for every fixture", () => {
    for (const fixture of PERF_FIXTURES) {
      expect(fixture.guards.length).toBeGreaterThan(0);
      expect(fixture.mutation.length).toBeGreaterThan(0);
      expect(existsSync(path.join(PERF_DIRECTORY, fixture.file))).toBe(true);
    }
  });

  it("registers every pglite-engine fixture in the vitest pglite project", () => {
    const pgliteFixtures = fixturesWithEngine("pglite");
    expect(pgliteFixtures.length).toBeGreaterThan(0);

    for (const fixture of pgliteFixtures) {
      expect(PGLITE_GLOBS).toContain(`tests/perf/${fixture.file}`);
    }
  });
});
