/**
 * Unit-grain contract tests for the L3 install-grain fixture's PORTABLE half
 * (design §4.4c, I4, B7a). These never spawn `npm`/`tsc`/`node` — they
 * assert the data and generated text the fixture is built from, so the
 * `pnpm test:strict-local-consumers` fixture-grain run (which does spawn all
 * three) can stay reserved for the mutations that actually need a real
 * install.
 */
import { describe, expect, it } from "vitest";

import { classifyEntrypoints } from "../scripts/drizzle-reachability-scan";
import {
  FIXTURE_PLAN,
  fixtureExpectations,
  portableFixtureEntrypoints,
  renderLedgerWalkModule,
  renderPortableCjsRunner,
  renderPortableEsmRunner,
  renderPortableFixtureIndex,
  specifierForEntrypoint,
  TYPED_REFUSAL_FACTORIES,
} from "../scripts/test-strict-local-consumers";
import { MISSING_PEER_LEDGER } from "../src/backend/missing-peer-ledger";

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

describe("strict consumer fixture contract", () => {
  it("the portable fixture's entrypoint list is the classification's portable arm, both directions", () => {
    const classification = classifyEntrypoints();
    const classifiedPortableEntrypoints = Object.entries(classification)
      .filter(([, value]) => value === "portable")
      .map(([entrypoint]) => entrypoint)
      .toSorted();

    expect(portableFixtureEntrypoints().toSorted()).toEqual(
      classifiedPortableEntrypoints,
    );
  });

  it("the fixture expectations partition package.json#exports into the portable list and the ledger", () => {
    const expectations = fixtureExpectations();
    const classification = classifyEntrypoints();
    const allEntrypoints = Object.keys(classification).toSorted();

    const ledgerEntrypoints = expectations.ledger.map(
      (entry) => entry.entrypoint,
    );
    const combinedEntrypoints = [
      ...expectations.portableEntrypoints,
      ...ledgerEntrypoints,
    ];

    const duplicateEntrypoints = combinedEntrypoints.filter(
      (entrypoint, index) => combinedEntrypoints.indexOf(entrypoint) !== index,
    );
    expect(
      duplicateEntrypoints,
      "the portable list and the ledger overlap or contain a duplicate",
    ).toEqual([]);
    expect(
      combinedEntrypoints.toSorted(),
      "portableEntrypoints union ledger entrypoints does not equal package.json#exports",
    ).toEqual(allEntrypoints);
  });

  it("entrypointSpecifiers covers exactly the portable and ledger entrypoints and matches specifierForEntrypoint, both directions", () => {
    const expectations = fixtureExpectations();
    const ledgerEntrypoints = expectations.ledger.map(
      (entry) => entry.entrypoint,
    );
    const allEntrypoints = [
      ...expectations.portableEntrypoints,
      ...ledgerEntrypoints,
    ].toSorted();

    expect(Object.keys(expectations.entrypointSpecifiers).toSorted()).toEqual(
      allEntrypoints,
    );
    for (const entrypoint of allEntrypoints) {
      expect(expectations.entrypointSpecifiers[entrypoint]).toBe(
        specifierForEntrypoint(entrypoint),
      );
    }
  });

  it("every typed-refusal ledger row names the factory the fixture calls, both directions", () => {
    const typedRefusalEntrypoints = MISSING_PEER_LEDGER.filter(
      (entry) => entry.arm === "typed-refusal",
    )
      .map((entry) => entry.entrypoint)
      .toSorted();
    const factoryEntrypoints = Object.keys(TYPED_REFUSAL_FACTORIES).toSorted();

    expect(factoryEntrypoints).toEqual(typedRefusalEntrypoints);
  });

  it("the generated fixture index imports every portable entrypoint and no ledger entrypoint", () => {
    const entrypoints = portableFixtureEntrypoints();
    const rendered = renderPortableFixtureIndex(entrypoints);

    for (const entrypoint of entrypoints) {
      const specifier = specifierForEntrypoint(entrypoint);
      const importPattern = new RegExp(
        String.raw`import \* as \w+ from "${escapeRegExp(specifier)}";`,
      );
      expect(
        rendered,
        `the generated fixture index does not import portable entrypoint ${entrypoint} (specifier ${specifier})`,
      ).toMatch(importPattern);
    }

    for (const entry of MISSING_PEER_LEDGER) {
      const specifier = specifierForEntrypoint(entry.entrypoint);
      expect(
        rendered.includes(`from "${specifier}"`),
        `the generated fixture index must not import the ledger entrypoint ${entry.entrypoint}`,
      ).toBe(false);
    }
  });

  it("the fixture plan runs both fixtures and only the packed-Drizzle one expects drizzle-orm installed", () => {
    expect(FIXTURE_PLAN).toEqual([
      { directoryName: "fixture", expectsDrizzleInstalled: true },
      { directoryName: "fixture-portable", expectsDrizzleInstalled: false },
    ]);
  });

  it("the arm assertions live only in the walk module", () => {
    const esmRunner = renderPortableEsmRunner();
    const cjsRunner = renderPortableCjsRunner();
    const walkModule = renderLedgerWalkModule();

    expect(esmRunner).not.toContain("MISSING_PEER_LEDGER");
    expect(cjsRunner).not.toContain("MISSING_PEER_LEDGER");
    expect(esmRunner).not.toContain("@nicia-ai/typegraph/backend");
    expect(cjsRunner).not.toContain("@nicia-ai/typegraph/backend");
    expect(esmRunner).not.toContain("MISSING_PEER_DEPENDENCY");
    expect(cjsRunner).not.toContain("MISSING_PEER_DEPENDENCY");
    expect(esmRunner).not.toContain("refusalDetailsCode");
    expect(cjsRunner).not.toContain("refusalDetailsCode");
    expect(esmRunner).toContain('"./walk.cjs"');
    expect(cjsRunner).toContain('"./walk.cjs"');
    // walk.cjs reads the code off fixture-expectations.json (which
    // fixtureExpectations() populates from the script's own
    // REFUSAL_DETAILS_CODE literal — production's missing-peer-ledger.ts
    // exports no such constant, per that literal's doc comment) rather than
    // restating the literal itself — asserting that stays the single read
    // site.
    expect(walkModule).toContain("expectations.refusalDetailsCode");
    expect(walkModule).not.toContain('"MISSING_PEER_DEPENDENCY"');
  });

  it("walk.cjs reads specifiers off entrypointSpecifiers rather than re-deriving the formula", () => {
    const walkModule = renderLedgerWalkModule();

    expect(walkModule).toContain(
      "expectations.entrypointSpecifiers[entrypoint]",
    );
    expect(walkModule).toContain(
      "expectations.entrypointSpecifiers[row.entrypoint]",
    );
    // The formula itself (the "." special case and the slice(1) fallback)
    // must appear nowhere in the generated text — only specifierForEntrypoint
    // (called once, at fixture-expectations.json generation time) computes
    // it, keeping specifierForEntrypoint's doc comment's "the one formula
    // every render function uses" claim true rather than aspirational.
    expect(walkModule).not.toContain('entrypoint === "."');
    expect(walkModule).not.toMatch(/`@nicia-ai\/typegraph\$\{/);
  });
});
