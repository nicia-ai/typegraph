/**
 * The construction ratchet, asserted through ESLint itself (T19, T20), plus the
 * placement of the two import bans that carry I1 and I2.
 *
 * The ban is installed for `src/**` and for `tests/**`, from two different
 * blocks, so each is fired at the fixture separately: a block that stopped
 * matching one of the two trees would still leave the other's assertions green.
 *
 * A `no-restricted-syntax` selector that matches nothing is indistinguishable
 * from a guardrail that is switched off, and both read as "protected" in the
 * config. So each selector group is fired at a fixture that must trip it, the
 * two modules the ratchet was written for are linted for real, and the set of
 * modules each import ban is NOT installed for is pinned to the modules that
 * own the mark.
 *
 * Harness note: the fixture text stays in memory and BORROWS the path of an
 * existing project file. `projectService: true` is on for this package, so a
 * `filePath` naming a file the project does not contain yields a parsing error
 * and zero rule reports — the fixture would certify nothing. Borrowing a real
 * path lints the SUPPLIED text under the real config; nothing is written, so
 * `pnpm lint` never sees the fixture.
 */
import fs from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import {
  BACKEND_AUDIT_RESTRICTIONS,
  BACKEND_CARRY_RESTRICTIONS,
  BACKEND_CONSTRUCTION_RESTRICTIONS,
  BACKEND_MUTATION_MESSAGE,
  BACKEND_SEAM_IMPORT_RESTRICTIONS,
  BACKEND_SEAM_MESSAGE,
  GLOBAL_SYMBOL_RESTRICTION,
  type RestrictedSyntaxEntry,
  RUNTIME_PORT_RESTRICTIONS,
  SOURCE_WIDE_RESTRICTIONS,
} from "../eslint.config.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");

/**
 * A `src` file covered by the blocks that carry the construction restrictions.
 * Its own content is never linted here — only its path is borrowed.
 */
const BORROWED_SRC_PATH = "src/backend/transaction-resource.ts";

/** The same, under the `tests/**` block. */
const BORROWED_TESTS_PATH = "tests/test-utils.ts";

/** The two modules whose `commonOperationMembers` rename the ratchet forced. */
const AUDITED_FACTORIES = [
  "src/backend/drizzle/sqlite.ts",
  "src/backend/drizzle/postgres.ts",
];

const CONSTRUCTION_MESSAGES = new Set([
  BACKEND_SEAM_MESSAGE,
  BACKEND_MUTATION_MESSAGE,
]);

/** Every `src` module, as a package-relative POSIX path, in code-unit order. */
function sourceModules(): readonly string[] {
  return (
    fs
      .readdirSync(path.join(packageRoot, "src"), {
        encoding: "utf8",
        recursive: true,
      })
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => path.posix.join("src", entry.split(path.sep).join("/")))
      // No comparator: code-unit order is host-independent, unlike collation.
      .toSorted()
  );
}

/**
 * One column of the `src/**` block table: a restriction group, and the modules
 * it is deliberately NOT installed for.
 *
 * A flat-config entry REPLACES rather than merges, so every per-file block has
 * to re-spread every group it does not mean to lift — and a forgotten spread
 * reads exactly like a block that never had the group. Pinning the exemption
 * set per column is what turns the table in the design into an assertion; a
 * column nobody asserts is a comment.
 */
type BanColumn = Readonly<{
  name: string;
  restrictions: readonly RestrictedSyntaxEntry[];
  exempt: readonly string[];
}>;

function banColumns(modules: readonly string[]): readonly BanColumn[] {
  return [
    // The two guardrails that apply to the whole library source, and the
    // construction ratchet: no module is exempt from any of them. The seam is
    // no exception — `deriveBackend` is a Proxy, the projections build through
    // `Object.fromEntries`, and neither spells a `*Backend` spread.
    {
      name: "SOURCE_WIDE_RESTRICTIONS",
      restrictions: SOURCE_WIDE_RESTRICTIONS,
      exempt: [],
    },
    {
      name: "BACKEND_CONSTRUCTION_RESTRICTIONS",
      restrictions: BACKEND_CONSTRUCTION_RESTRICTIONS,
      exempt: [],
    },
    {
      name: "GLOBAL_SYMBOL_RESTRICTION",
      restrictions: [GLOBAL_SYMBOL_RESTRICTION],
      exempt: ["src/utils/global-symbol.ts"],
    },
    {
      // Runtime symbols are private to src/store, so the ban is installed for
      // everything outside it. Declared as the rule rather than as a frozen
      // list: a new store module is in the same class by construction.
      name: "RUNTIME_PORT_RESTRICTIONS",
      restrictions: RUNTIME_PORT_RESTRICTIONS,
      exempt: modules.filter((file) => file.startsWith("src/store/")),
    },
    {
      name: "BACKEND_SEAM_IMPORT_RESTRICTIONS",
      restrictions: BACKEND_SEAM_IMPORT_RESTRICTIONS,
      exempt: [
        "src/backend/derive-backend.ts",
        "src/backend/drizzle/contribution-materializations.ts",
        "src/backend/drizzle/postgres.ts",
        "src/store/operations/edge-batch-validation.ts",
        "src/store/operations/node-operations.ts",
        "src/store/operations/write-executor.ts",
        "src/store/recorded-capture.ts",
        "src/store/recorded-read-service.ts",
        "src/store/store.ts",
      ],
    },
    {
      /** I1: the only `src` module that may import `carryBackendResourceAudit`. */
      name: "BACKEND_CARRY_RESTRICTIONS",
      restrictions: BACKEND_CARRY_RESTRICTIONS,
      exempt: ["src/backend/derive-backend.ts"],
    },
    {
      /** I2: the only `src` modules that may import `auditBackendResource`. */
      name: "BACKEND_AUDIT_RESTRICTIONS",
      restrictions: BACKEND_AUDIT_RESTRICTIONS,
      exempt: [
        "src/backend/drizzle/postgres.ts",
        "src/backend/drizzle/sqlite.ts",
      ],
    },
  ];
}

/** The selector of one resolved `no-restricted-syntax` option, if it has one. */
function optionSelector(option: unknown): string | undefined {
  if (typeof option === "string") return option;
  if (
    typeof option === "object" &&
    option !== null &&
    "selector" in option &&
    typeof option.selector === "string"
  ) {
    return option.selector;
  }
  return undefined;
}

/**
 * The `no-restricted-syntax` selectors ESLint resolves for `file`.
 *
 * Flat-config entries REPLACE rather than merge, so this reads the rule array
 * the last matching block actually installed — the only thing that decides
 * whether a ban applies to a module.
 */
async function resolvedSelectors(file: string): Promise<ReadonlySet<string>> {
  const config: unknown = await eslint.calculateConfigForFile(
    path.join(packageRoot, file),
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
    throw new TypeError(`no-restricted-syntax is not configured for ${file}`);
  }
  return new Set(
    entry
      .slice(1)
      .map((option) => optionSelector(option))
      .filter((selector) => selector !== undefined),
  );
}

/** How many of `ban`'s selectors are installed for a file. */
function installedCount(
  selectors: ReadonlySet<string>,
  ban: readonly RestrictedSyntaxEntry[],
): number {
  return ban.filter((restriction) => selectors.has(restriction.selector))
    .length;
}

const eslint = new ESLint({ cwd: packageRoot });

/**
 * The construction-ratchet messages ESLint reports for `source`.
 *
 * Filtered by rule id AND by message identity: a borrowed path also runs the
 * type-aware rules over the fixture, so an unrelated report must not be able to
 * masquerade as the selector firing.
 */
async function constructionReports(
  source: string,
  borrowedPath: string,
): Promise<readonly string[]> {
  const results = await eslint.lintText(source, {
    filePath: path.join(packageRoot, borrowedPath),
  });
  return results
    .flatMap((result) => result.messages)
    .filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        CONSTRUCTION_MESSAGES.has(message.message),
    )
    .map((message) => message.message);
}

/**
 * Fires each selector group at a fixture linted under `borrowedPath`.
 *
 * One helper for both trees: the two blocks install the SAME group, so a case
 * that held for `src` and not for `tests` would be a block that forgot the
 * spread, not a different contract.
 */
async function expectEverySelectorFires(borrowedPath: string): Promise<void> {
  const declarations =
    "declare const someBackend: { getNode: unknown };\n" +
    "declare function getBackend(): { getNode: unknown; getEdge: unknown };\n";

  expect(
    await constructionReports(
      `${declarations}export const copy = { ...someBackend };`,
      borrowedPath,
    ),
  ).toEqual([BACKEND_SEAM_MESSAGE]);

  expect(
    await constructionReports(
      `${declarations}const { getNode, ...rest } = getBackend();\nexport { getNode, rest };`,
      borrowedPath,
    ),
  ).toEqual([BACKEND_SEAM_MESSAGE]);

  // Object.assign is split so a mutation and a copy do not share one
  // message: the first argument is MUTATED, later arguments are copied.
  expect(
    await constructionReports(
      `${declarations}export const mutated = Object.assign(someBackend, {});`,
      borrowedPath,
    ),
  ).toEqual([BACKEND_MUTATION_MESSAGE]);

  expect(
    await constructionReports(
      `${declarations}export const copied = Object.assign({}, someBackend);`,
      borrowedPath,
    ),
  ).toEqual([BACKEND_SEAM_MESSAGE]);
}

describe("backend construction lint ratchet", () => {
  it(
    "reports every derivation-shaped construction in src",
    { timeout: 120_000 },
    async () => {
      await expectEverySelectorFires(BORROWED_SRC_PATH);
    },
  );

  it(
    "reports every derivation-shaped construction in tests",
    { timeout: 120_000 },
    async () => {
      // The test tree's own block, which lands with the bulk conversion. Before
      // it existed this same fixture reported NOTHING under a `tests/**` path —
      // deleting the block puts it back to zero and fails here.
      await expectEverySelectorFires(BORROWED_TESTS_PATH);
    },
  );

  it(
    "leaves the two audited factories clean",
    { timeout: 120_000 },
    async () => {
      // The factories primitively construct their backend from an operations
      // members fragment, which no selector matches — but a members fragment
      // named `commonBackend` DID match, which is why the locals are named
      // `commonOperationMembers`. Reverting either rename fails here.
      const results = await eslint.lintFiles(
        AUDITED_FACTORIES.map((file) => path.join(packageRoot, file)),
      );
      const reported = results.flatMap((result) =>
        result.messages
          .filter(
            (message) =>
              message.ruleId === "no-restricted-syntax" &&
              CONSTRUCTION_MESSAGES.has(message.message),
          )
          .map(
            (message) =>
              `${path.relative(packageRoot, result.filePath)}:${message.line}`,
          ),
      );
      expect(reported).toEqual([]);
    },
  );

  it(
    "installs every guardrail whole, exempting only the modules that own the mark",
    { timeout: 120_000 },
    async () => {
      // Which guardrail applies to which module is decided entirely by which
      // block spreads which list, and a per-file block that forgets a spread
      // switches that guardrail off silently — the config still reads as
      // protected. So resolve every src module's rule array and let the
      // per-column exemption sets themselves be the assertion.
      const modules = sourceModules();
      const columns = banColumns(modules);
      const observed = new Map<string, string[]>(
        columns.map((column) => [column.name, []]),
      );
      const partiallyInstalled: string[] = [];

      for (const file of modules) {
        const selectors = await resolvedSelectors(file);
        for (const column of columns) {
          const installed = installedCount(selectors, column.restrictions);
          if (installed === 0) {
            observed.get(column.name)?.push(file);
            continue;
          }
          // A group is spread whole or not at all: half a list would leave,
          // say, the re-export half of a ban off with no exemption declared.
          if (installed !== column.restrictions.length) {
            partiallyInstalled.push(`${column.name} ${file}`);
          }
        }
      }

      expect(partiallyInstalled).toEqual([]);
      for (const column of columns) {
        expect({
          column: column.name,
          exempt: observed.get(column.name),
        }).toEqual({ column: column.name, exempt: column.exempt });
      }
    },
  );
});
