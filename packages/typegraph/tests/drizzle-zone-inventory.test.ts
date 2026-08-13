/**
 * I1 baseline ratchet — the sanctioned Drizzle-specifier zone
 * (`DRIZZLE_ZONE` in `eslint.config.mjs`) is closed data, asserted both
 * directions against the real module graph: every zone entry genuinely
 * imports a Drizzle specifier, and every module that genuinely imports one
 * is a zone entry. `tests/backend-construction-lint.test.ts`'s `banColumns`
 * is the home of the per-block "installed whole, never half" check (its
 * `DRIZZLE_ZONE_RESTRICTIONS` column) — this file owns the zone LIST's
 * own both-directions correctness, the shared-pattern check, the lockfile
 * breadth check, the four-AST-form fixtures, and the reference-tree
 * installation, none of which `banColumns` covers.
 *
 * NOTE ON THIS FILE'S OWN TEXT: this docblock and every string literal below
 * deliberately never spell the contiguous phrase this repo uses elsewhere to
 * claim Drizzle absence (see `scripts/drizzle-claim-inventory.ts`) — that
 * scanner's `CLAIM_PHRASE_PATTERN` would count a literal occurrence here as a
 * new, unqualified claim site and fail `tests/drizzle-claim-sites.test.ts`.
 */
import fs from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import {
  BACKEND_CONSTRUCTION_RESTRICTIONS,
  DRIZZLE_SPECIFIER_PATTERN_SOURCE,
  DRIZZLE_ZONE,
  DRIZZLE_ZONE_MESSAGE,
  DRIZZLE_ZONE_RESTRICTIONS,
} from "../eslint.config.mjs";
import {
  collectModuleEdges,
  DRIZZLE_SPECIFIER_PATTERN,
} from "../scripts/drizzle-reachability-scan";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");

/** Every `src` module, as a package-relative POSIX path. */
function allSourceModules(): readonly string[] {
  return fs
    .readdirSync(path.join(PACKAGE_ROOT, "src"), {
      encoding: "utf8",
      recursive: true,
    })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.posix.join("src", entry.split(path.sep).join("/")))
    .toSorted();
}

/** Every `src` module with at least one real Drizzle-specifier edge. */
function realDrizzleImporters(): readonly string[] {
  return allSourceModules().filter((file) => {
    const edges = collectModuleEdges(path.join(PACKAGE_ROOT, file));
    return edges.some((edge) => DRIZZLE_SPECIFIER_PATTERN.test(edge.specifier));
  });
}

/**
 * Parses `pnpm-lock.yaml`'s `packages:` section — the deduplicated resolved
 * coordinate list, keyed `<name>@<version>:` with no peer-dependency suffix
 * (that suffix only appears in the separate `snapshots:` section) — and
 * returns every package name found there. A scoped name's `/` is handled by
 * requiring at most one `@`-delimited scope segment before the version.
 */
function installedPackageNames(): readonly string[] {
  const text = fs.readFileSync(path.join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
  const lines = text.split("\n");
  const packagesStart = lines.indexOf("packages:");
  const snapshotsStart = lines.indexOf("snapshots:");
  if (
    packagesStart === -1 ||
    snapshotsStart === -1 ||
    snapshotsStart <= packagesStart
  ) {
    throw new Error(
      "pnpm-lock.yaml: could not locate the packages:/snapshots: section boundaries.",
    );
  }

  const KEY_PATTERN = /^ {2}(@[^/]+\/[^@]+|[^@]+)@(\S+):$/;
  const names = new Set<string>();
  for (const line of lines.slice(packagesStart + 1, snapshotsStart)) {
    const match = KEY_PATTERN.exec(line);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return [...names].toSorted();
}

const eslint = new ESLint({ cwd: PACKAGE_ROOT });

/** One fixture per AST form the zone ban's five selectors cover. */
const ZONE_FORM_FIXTURES: readonly Readonly<{
  name: string;
  source: string;
}>[] = [
  {
    name: "static import",
    source: 'import { sql } from "drizzle-orm";\nvoid sql;',
  },
  {
    name: "re-export (named)",
    source: 'export { sql } from "drizzle-orm";',
  },
  {
    name: "re-export (all)",
    source: 'export * from "drizzle-orm";',
  },
  {
    name: "dynamic import",
    source:
      'export async function loadDrizzle() {\n  return import("drizzle-orm");\n}',
  },
  {
    name: "require",
    source:
      'const drizzleModule = require("drizzle-orm");\nvoid drizzleModule;',
  },
];

/** The zone-ban messages ESLint reports for `source` linted under `borrowedPath`. */
async function zoneMessages(
  source: string,
  borrowedPath: string,
): Promise<readonly string[]> {
  const results = await eslint.lintText(source, {
    filePath: path.join(PACKAGE_ROOT, borrowedPath),
  });
  return results
    .flatMap((result) => result.messages)
    .filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        message.message === DRIZZLE_ZONE_MESSAGE,
    )
    .map((message) => message.message);
}

describe("drizzle zone inventory (I1)", () => {
  it("the zone list equals the set of src modules importing a Drizzle specifier, both directions", () => {
    const scanned = realDrizzleImporters();
    const zoneFiles = DRIZZLE_ZONE.map((entry) => entry.file);
    expect(scanned.toSorted()).toEqual(zoneFiles.toSorted());
  });

  it("every zone entry names an existing file and carries a non-empty reason", () => {
    expect(DRIZZLE_ZONE.length).toBe(30);

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of DRIZZLE_ZONE) {
      if (seen.has(entry.file)) duplicates.push(entry.file);
      seen.add(entry.file);

      expect(
        fs.existsSync(path.join(PACKAGE_ROOT, entry.file)),
        `${entry.file} does not exist`,
      ).toBe(true);
      expect(
        entry.reason.length,
        `${entry.file}'s reason is empty`,
      ).toBeGreaterThan(0);
    }
    expect(duplicates).toEqual([]);
  });

  it("the lint selectors and the reachability scan share one specifier pattern", () => {
    expect(new RegExp(DRIZZLE_SPECIFIER_PATTERN_SOURCE).source).toBe(
      DRIZZLE_SPECIFIER_PATTERN.source,
    );

    for (const restriction of DRIZZLE_ZONE_RESTRICTIONS) {
      expect(
        restriction.selector.includes(DRIZZLE_SPECIFIER_PATTERN_SOURCE),
        `selector: ${restriction.selector}`,
      ).toBe(true);
    }
  });

  it("matches every installed package whose name contains drizzle", () => {
    const names = installedPackageNames();
    const drizzlePackages = names.filter((name) => /(^|\/)drizzle/.test(name));

    expect(drizzlePackages.length).toBeGreaterThan(0);
    expect(drizzlePackages).toContain("drizzle-orm");
    for (const name of drizzlePackages) {
      expect(DRIZZLE_SPECIFIER_PATTERN.test(name), `package: ${name}`).toBe(
        true,
      );
    }
  });

  it(
    "reports each of the four AST forms for a src module outside the zone",
    { timeout: 120_000 },
    async () => {
      const borrowedPath = "src/backend/table-contribution.ts";
      for (const fixture of ZONE_FORM_FIXTURES) {
        const messages = await zoneMessages(fixture.source, borrowedPath);
        expect(messages, `form: ${fixture.name}`).toEqual([
          DRIZZLE_ZONE_MESSAGE,
        ]);
      }
    },
  );

  it(
    "reports nothing for a Drizzle import in a zone module",
    { timeout: 120_000 },
    async () => {
      const borrowedZonePath = "src/backend/drizzle/ddl.ts";
      for (const fixture of ZONE_FORM_FIXTURES) {
        const messages = await zoneMessages(fixture.source, borrowedZonePath);
        expect(messages, `form: ${fixture.name}`).toEqual([]);
      }

      const results = await eslint.lintFiles(
        DRIZZLE_ZONE.map((entry) => path.join(PACKAGE_ROOT, entry.file)),
      );
      const zoneReports = results.flatMap((result) =>
        result.messages
          .filter(
            (message) =>
              message.ruleId === "no-restricted-syntax" &&
              message.message === DRIZZLE_ZONE_MESSAGE,
          )
          .map(
            (message) =>
              `${path.relative(PACKAGE_ROOT, result.filePath)}:${message.line}`,
          ),
      );
      expect(zoneReports).toEqual([]);
    },
  );

  it(
    "installs the zone ban and the construction ban for the reference-backend tree",
    { timeout: 120_000 },
    async () => {
      // tests/reference/reference-backend.ts does not exist yet (it lands in
      // B5) — calculateConfigForFile resolves a config for a path regardless
      // of whether the file itself is present.
      const config: unknown = await eslint.calculateConfigForFile(
        path.join(PACKAGE_ROOT, "tests/reference/reference-backend.ts"),
      );
      const rules =
        typeof config === "object" && config !== null && "rules" in config ?
          config.rules
        : undefined;
      const entry =
        (
          typeof rules === "object" &&
          rules !== null &&
          "no-restricted-syntax" in rules
        ) ?
          rules["no-restricted-syntax"]
        : undefined;
      if (!Array.isArray(entry)) {
        throw new TypeError(
          "no-restricted-syntax is not configured for tests/reference/reference-backend.ts",
        );
      }

      const resolvedSelectors = new Set(
        entry
          .slice(1)
          .map((option: unknown) =>
            (
              typeof option === "object" &&
              option !== null &&
              "selector" in option &&
              typeof option.selector === "string"
            ) ?
              option.selector
            : undefined,
          )
          .filter((selector) => selector !== undefined),
      );

      const requiredSelectors = [
        ...DRIZZLE_ZONE_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
      ].map((restriction) => restriction.selector);

      for (const selector of requiredSelectors) {
        expect(resolvedSelectors.has(selector), `selector: ${selector}`).toBe(
          true,
        );
      }
    },
  );

  it("declares drizzle-orm as an optional peer dependency", () => {
    // Interim guard: this keeps the peerDependenciesMeta flip asserted
    // between this batch and the missing-peer refusal that follows it,
    // rather than shipping the loosening with no test at all.
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as Readonly<{
      peerDependencies: Readonly<Record<string, string>>;
      peerDependenciesMeta: Readonly<Record<string, { optional?: boolean }>>;
    }>;

    expect(packageJson.peerDependenciesMeta["drizzle-orm"]?.optional).toBe(
      true,
    );
    expect(packageJson.peerDependencies["drizzle-orm"]).toBeDefined();
  });
});
