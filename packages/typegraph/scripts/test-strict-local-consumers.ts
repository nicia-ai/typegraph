/**
 * The L3 install-grain fixture (design §4.4c, I4).
 *
 * Two fixtures live under one `mkdtemp` root, both installed from the SAME
 * packed tarball (`pnpm build` + `pnpm pack` run exactly once):
 *
 * - `fixture/` — Drizzle installed (the pre-existing harness, behaviour
 *   preserved verbatim: same dependencies, same two-version TypeScript
 *   matrix, same `run.mjs` text). Proves no Drizzle DECLARATION enters a
 *   consumer's TypeScript program even though the package is installed.
 * - `fixture-portable/` — Drizzle deliberately ABSENT. Proves the ten
 *   portable entrypoints load and run with no Drizzle installed at all, and
 *   that every non-portable entrypoint's failure mode is exactly the one
 *   `MISSING_PEER_LEDGER` declares, in both the `import` and `require`
 *   artifact formats (I4's "the covered set is the asserted set").
 *
 * {@link FIXTURE_PLAN} is the single data table naming which fixtures run
 * and what each expects of `node_modules/drizzle-orm`; {@link
 * portableFixtureEntrypoints} derives the portable fixture's entrypoint list
 * from {@link classifyEntrypoints} rather than a hand-written list (design
 * D4) — this is not a fourth hand rendering of the entrypoint set I10 exists
 * to unify. The four `render*` functions build the portable fixture's
 * generated files as strings (no new repo-level `.mjs`/`.cjs` file), and
 * {@link renderLedgerWalkModule}'s output, `walk.cjs`, is the SINGLE owner of
 * the two ledger arms' distinguishing assertions — neither generated runner
 * (`run.mjs`, `run.cjs`) contains that decision, only a reference to it.
 */
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  MISSING_PEER_INSTALL_COMMAND,
  MISSING_PEER_LEDGER,
  MISSING_PEER_PACKAGE,
  type MissingPeerLedgerEntry,
} from "../src/backend/missing-peer-ledger";
import { classifyEntrypoints } from "./drizzle-reachability-scan";

const TYPESCRIPT_VERSIONS = ["5.9.3", "6.0.3"] as const;
const DRIZZLE_VERSION = "0.45.2";
const FORBIDDEN_DRIVERS = ["gel", "mysql2", "pg", "postgres"] as const;

/** One fixture directory, and what it expects of `node_modules/drizzle-orm`. */
export type FixturePlanEntry = Readonly<{
  directoryName: string;
  expectsDrizzleInstalled: boolean;
}>;

/**
 * The two fixtures this script runs, and the single fact that differs
 * between them. {@link runDrizzlePresentFixture} and {@link
 * runPortableFixture} each read their own row's `expectsDrizzleInstalled`
 * and hand it to {@link assertDrizzlePresence} — the one owner of the two
 * fixtures' opposite assertion — rather than each fixture spelling its own
 * `true`/`false` literal.
 */
export const FIXTURE_PLAN: readonly FixturePlanEntry[] = [
  { directoryName: "fixture", expectsDrizzleInstalled: true },
  { directoryName: "fixture-portable", expectsDrizzleInstalled: false },
];

/**
 * The published factory each `typed-refusal` ledger row's entrypoint
 * exports. `walk.cjs` looks the factory up by entrypoint rather than
 * hard-coding it, so a ledger row with no matching factory fails loudly
 * (design §4.4c step 5).
 */
export const TYPED_REFUSAL_FACTORIES: Readonly<Record<string, string>> = {
  "./sqlite/local": "createLocalSqliteStore",
  "./postgres/pglite": "createLocalPgliteStore",
};

/**
 * The two Node module-resolution error codes a missing CommonJS/ESM
 * specifier can raise (`isMissingDrizzlePeerError`'s own accepted set,
 * `src/backend/missing-peer-ledger.ts`). Not re-exported from there — that
 * module exports no such list — so this is the fixture's own record of the
 * shape Node's loader uses, not a second implementation of the predicate
 * the fixture never re-derives a verdict from.
 */
const MISSING_MODULE_ERROR_CODES: readonly string[] = [
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
];

/**
 * The typed refusal's `details.code` (`missingDrizzlePeerError`,
 * `src/backend/missing-peer-ledger.ts`). Not re-exported from there — that
 * module exports no such constant, and it is out of scope for this batch
 * (landed whole in B4b) — so this is the fixture's own record of the literal,
 * matching {@link MISSING_MODULE_ERROR_CODES}'s precedent immediately above.
 * The generated `walk.cjs` reads this value off `fixture-expectations.json`'s
 * `refusalDetailsCode` field rather than restating it as a THIRD hardcoded
 * copy, so this is the one place in the fixture that spells the string.
 */
const REFUSAL_DETAILS_CODE = "MISSING_PEER_DEPENDENCY";

/** Everything `walk.cjs` needs to walk the portable entrypoints and the ledger, serialized once as JSON. */
export type FixtureExpectations = Readonly<{
  portableEntrypoints: readonly string[];
  ledger: readonly MissingPeerLedgerEntry[];
  typedRefusalFactories: Readonly<Record<string, string>>;
  missingPeerPackage: string;
  missingPeerInstallCommand: string;
  refusalDetailsCode: typeof REFUSAL_DETAILS_CODE;
  missingModuleErrorCodes: readonly string[];
  entrypointSpecifiers: Readonly<Record<string, string>>;
}>;

const PackageJsonSchema = z.object({
  devDependencies: z.record(z.string(), z.string()).optional(),
});

type PackageJson = z.infer<typeof PackageJsonSchema>;

function normalizeVersion(
  versionSpecifier: string | undefined,
  fallback: string,
): string {
  return versionSpecifier?.replace(/^[~^]/, "") ?? fallback;
}

function parsePackageJson(contents: string): PackageJson {
  return PackageJsonSchema.parse(JSON.parse(contents));
}

function platformExecutable(command: string): string {
  if (process.platform !== "win32") return command;
  const commandName = path.basename(command);
  return (
      commandName === "npm" || commandName === "pnpm" || commandName === "tsc"
    ) ?
      `${command}.cmd`
    : command;
}

async function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  capture = false,
): Promise<string> {
  // User-level npm configuration can change optional/peer installation and
  // make this hermetic consumer test pass or fail for unrelated reasons.
  const environment =
    command === "npm" ?
      Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.toLowerCase().startsWith("npm_config_"),
        ),
      )
    : process.env;

  return new Promise<string>((resolve, reject) => {
    let output = "";
    const child = spawn(platformExecutable(command), arguments_, {
      cwd,
      env: environment,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(
        new Error(
          `${command} ${arguments_.join(" ")} failed (${code ?? "unknown"}).\n${output}`,
        ),
      );
    });
  });
}

async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await stat(pathToCheck);
    return true;
  } catch {
    return false;
  }
}

async function assertPathAbsent(
  pathToCheck: string,
  message: string,
): Promise<void> {
  if (await pathExists(pathToCheck)) {
    throw new Error(message);
  }
}

/**
 * The single owner of the two fixtures' opposite assertion about
 * `node_modules/drizzle-orm` (design §3). Every call site passes a {@link
 * FixturePlanEntry}'s own `expectsDrizzleInstalled`, never a literal, so
 * flipping a plan row's expectation actually flips which message this
 * throws against the fixture's real, installed `node_modules`.
 */
async function assertDrizzlePresence(
  fixtureDirectory: string,
  expected: boolean,
): Promise<void> {
  const drizzleDirectory = path.join(
    fixtureDirectory,
    "node_modules",
    "drizzle-orm",
  );
  const isInstalled = await pathExists(drizzleDirectory);
  if (expected && !isInstalled) {
    throw new Error(
      "The strict fixture must install Drizzle to prove its declarations stay unreachable.",
    );
  }
  if (!expected && isInstalled) {
    throw new Error(
      "The portable fixture must not have drizzle-orm installed; peerDependenciesMeta must mark it optional.",
    );
  }
}

function fixturePlanEntry(directoryName: string): FixturePlanEntry {
  const entry = FIXTURE_PLAN.find(
    (candidate) => candidate.directoryName === directoryName,
  );
  if (entry === undefined) {
    throw new Error(
      `No FIXTURE_PLAN entry named ${JSON.stringify(directoryName)}.`,
    );
  }
  return entry;
}

async function writeFixtureTsconfig(fixtureDirectory: string): Promise<void> {
  await writeFile(
    path.join(fixtureDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          verbatimModuleSyntax: true,
          isolatedModules: true,
          declaration: true,
          skipLibCheck: false,
          rootDir: "src",
          outDir: "dist",
          lib: ["ES2023"],
          types: ["node"],
        },
        include: ["src/**/*.ts"],
      },
      undefined,
      2,
    )}\n`,
  );
}

async function writeFixturePackageJson(
  fixtureDirectory: string,
  name: string,
  dependencies: Readonly<Record<string, string>>,
  devDependencies: Readonly<Record<string, string>>,
): Promise<void> {
  await writeFile(
    path.join(fixtureDirectory, "package.json"),
    `${JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        dependencies,
        devDependencies,
      },
      undefined,
      2,
    )}\n`,
  );
}

async function installFixture(fixtureDirectory: string): Promise<void> {
  await run(
    "npm",
    ["install", "--omit=optional", "--no-package-lock"],
    fixtureDirectory,
  );
}

async function assertForbiddenDriversAbsent(
  fixtureDirectory: string,
  packages: readonly string[],
): Promise<void> {
  for (const packageName of packages) {
    await assertPathAbsent(
      path.join(fixtureDirectory, "node_modules", packageName),
      `Unused database driver was installed: ${packageName}`,
    );
  }
}

/** Runs `tsc --listFiles` in `fixtureDirectory`, first confirming the active `tsc` really is `typescriptVersion`. */
async function compileFixture(
  fixtureDirectory: string,
  typescriptVersion: string,
): Promise<string> {
  const tscPath = path.join(fixtureDirectory, "node_modules", ".bin", "tsc");
  const reportedVersion = await run(
    tscPath,
    ["--version"],
    fixtureDirectory,
    true,
  );
  if (!reportedVersion.includes(`Version ${typescriptVersion}`)) {
    throw new Error(
      `Expected TypeScript ${typescriptVersion}, received ${reportedVersion.trim()}.`,
    );
  }
  return run(tscPath, ["--listFiles"], fixtureDirectory, true);
}

function assertNoDrizzleDeclarations(
  listFiles: string,
  typescriptVersion: string,
): void {
  const portableListFiles = listFiles.replaceAll("\\", "/");
  if (portableListFiles.includes("/node_modules/drizzle-orm/")) {
    throw new Error(
      `A Drizzle declaration entered the TypeScript ${typescriptVersion} program.`,
    );
  }
}

/** Every published entrypoint {@link classifyEntrypoints} classifies `"portable"`. Derived, never hand-written (design D4). */
export function portableFixtureEntrypoints(): readonly string[] {
  return Object.entries(classifyEntrypoints())
    .filter(([, classification]) => classification === "portable")
    .map(([entrypoint]) => entrypoint);
}

/**
 * Every published entrypoint (portable ∪ ledger) mapped to its
 * {@link specifierForEntrypoint} result, computed once here so `walk.cjs`
 * reads the answer off `fixture-expectations.json` instead of re-deriving the
 * formula as inline generated-JS text — the same precedent as
 * {@link REFUSAL_DETAILS_CODE}.
 */
function entrypointSpecifierTable(): Readonly<Record<string, string>> {
  const entrypoints = [
    ...portableFixtureEntrypoints(),
    ...MISSING_PEER_LEDGER.map((entry) => entry.entrypoint),
  ];
  return Object.fromEntries(
    entrypoints.map((entrypoint) => [
      entrypoint,
      specifierForEntrypoint(entrypoint),
    ]),
  );
}

/** The data `walk.cjs` reads at runtime, generated once and written as `fixture-expectations.json`. */
export function fixtureExpectations(): FixtureExpectations {
  return {
    portableEntrypoints: portableFixtureEntrypoints(),
    ledger: MISSING_PEER_LEDGER,
    typedRefusalFactories: TYPED_REFUSAL_FACTORIES,
    missingPeerPackage: MISSING_PEER_PACKAGE,
    missingPeerInstallCommand: MISSING_PEER_INSTALL_COMMAND,
    refusalDetailsCode: REFUSAL_DETAILS_CODE,
    missingModuleErrorCodes: MISSING_MODULE_ERROR_CODES,
    entrypointSpecifiers: entrypointSpecifierTable(),
  };
}

/**
 * `"@nicia-ai/typegraph" + (entrypoint === "." ? "" : entrypoint.slice(1))` —
 * the one formula every render function uses, directly or (for
 * `walk.cjs`, which runs in a separate, later Node process) via
 * {@link entrypointSpecifierTable}'s precomputed `entrypointSpecifiers` map,
 * which calls this function once per entrypoint when `fixture-expectations.json`
 * is generated. Exported so `tests/strict-consumer-fixture-contract.test.ts`
 * calls this rather than re-spelling the formula as its own private copy.
 */
export function specifierForEntrypoint(entrypoint: string): string {
  return entrypoint === "." ?
      "@nicia-ai/typegraph"
    : `@nicia-ai/typegraph${entrypoint.slice(1)}`;
}

/** A valid, unique JS identifier for a portable entrypoint's namespace import. */
function importNameForEntrypoint(entrypoint: string): string {
  if (entrypoint === ".") return "typegraphRoot";
  const segment = entrypoint.slice(2);
  return segment.replaceAll(/-([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

/**
 * The portable fixture's generated `src/index.ts`: one namespace import per
 * `entrypoints` specifier (never a ledger entrypoint), plus
 * `exercisePortableConsumer`, which asserts every namespace has at least one
 * own key and then runs one real portable code path — `defineNode` /
 * `defineGraph` from the root and `serializeSchema` from `./schema`, with no
 * backend at all — asserting the serialized node's `kind`. `async` and named
 * exactly this so B7b can extend it with a reference-backend cycle without
 * reshaping the fixture.
 */
export function renderPortableFixtureIndex(
  entrypoints: readonly string[],
): string {
  const importNames = entrypoints.map((entrypoint) =>
    importNameForEntrypoint(entrypoint),
  );
  const importLines = entrypoints.map(
    (entrypoint, index) =>
      `import * as ${importNames[index]} from "${specifierForEntrypoint(entrypoint)}";`,
  );
  const namespaceEntryLines = entrypoints.map(
    (entrypoint, index) =>
      `  [${JSON.stringify(entrypoint)}, ${importNames[index]}],`,
  );

  const rootIndex = entrypoints.indexOf(".");
  const schemaIndex = entrypoints.indexOf("./schema");
  if (rootIndex === -1 || schemaIndex === -1) {
    throw new Error(
      'renderPortableFixtureIndex requires both the "." and "./schema" entrypoints to exercise a real portable code path.',
    );
  }
  const rootImportName = importNames[rootIndex];
  const schemaImportName = importNames[schemaIndex];

  return [
    ...importLines,
    "",
    'import { z } from "zod";',
    "",
    "const namespaceEntries: readonly (readonly [string, unknown])[] = [",
    ...namespaceEntryLines,
    "];",
    "",
    "export async function exercisePortableConsumer(): Promise<",
    "  readonly Readonly<{ entrypoint: string; exportCount: number }>[]",
    "> {",
    "  const rows: Readonly<{ entrypoint: string; exportCount: number }>[] = [];",
    "  for (const [entrypoint, namespace] of namespaceEntries) {",
    "    const exportCount = Object.keys(namespace as object).length;",
    "    if (exportCount === 0) {",
    "      throw new Error(",
    "        `Portable entrypoint ${entrypoint} exported no own members.`,",
    "      );",
    "    }",
    "    rows.push({ entrypoint, exportCount });",
    "  }",
    "",
    `  const PortableFixtureNode = ${rootImportName}.defineNode("PortableFixtureNode", {`,
    "    schema: z.object({ value: z.string() }),",
    "  });",
    `  const portableFixtureGraph = ${rootImportName}.defineGraph({`,
    '    id: "portable-fixture",',
    "    nodes: { PortableFixtureNode: { type: PortableFixtureNode } },",
    "    edges: {},",
    "  });",
    `  const serialized = ${schemaImportName}.serializeSchema(portableFixtureGraph, 1);`,
    '  const nodeDefinition = serialized.nodes["PortableFixtureNode"];',
    "  if (",
    "    nodeDefinition === undefined ||",
    '    nodeDefinition.kind !== "PortableFixtureNode"',
    "  ) {",
    "    throw new Error(",
    '      "serializeSchema did not report the expected node kind for the portable fixture real code path.",',
    "    );",
    "  }",
    "",
    "  return rows;",
    "}",
    "",
  ].join("\n");
}

/**
 * `walk.cjs` — the SINGLE owner of the two ledger arms' distinguishing
 * assertions (design §4.4c step 5, §5). CommonJS so both runners can consume
 * it with one form (`require` in CJS, a static `import` in ESM — Node's
 * CJS/ESM interop statically analyzes this file's `module.exports` object
 * literal). Neither `run.mjs` nor `run.cjs` contains an arm decision; each
 * only calls into here.
 */
export function renderLedgerWalkModule(): string {
  return [
    '"use strict";',
    "",
    'const assert = require("node:assert/strict");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "",
    "function loadExpectations() {",
    "  const text = fs.readFileSync(",
    '    path.join(__dirname, "fixture-expectations.json"),',
    '    "utf8",',
    "  );",
    "  return JSON.parse(text);",
    "}",
    "",
    "function assertLedgerPartitionsExports() {",
    "  const expectations = loadExpectations();",
    "  const packageJsonPath = path.join(",
    "    __dirname,",
    '    "node_modules",',
    '    "@nicia-ai",',
    '    "typegraph",',
    '    "package.json",',
    "  );",
    "  const packageJson = JSON.parse(",
    '    fs.readFileSync(packageJsonPath, "utf8"),',
    "  );",
    "  const exportEntrypoints = Object.keys(packageJson.exports).toSorted();",
    "",
    "  const portableEntrypoints = expectations.portableEntrypoints;",
    "  const ledgerEntrypoints = expectations.ledger.map(",
    "    (entry) => entry.entrypoint,",
    "  );",
    "  const combinedEntrypoints = [...portableEntrypoints, ...ledgerEntrypoints];",
    "  const duplicateEntrypoints = combinedEntrypoints.filter(",
    "    (entrypoint, index) => combinedEntrypoints.indexOf(entrypoint) !== index,",
    "  );",
    "  assert.deepEqual(",
    "    duplicateEntrypoints,",
    "    [],",
    '    "the portable list and the ledger overlap or contain duplicates",',
    "  );",
    "  assert.deepEqual(",
    "    combinedEntrypoints.toSorted(),",
    "    exportEntrypoints,",
    '    "portableEntrypoints union ledger entrypoints does not equal package.json#exports",',
    "  );",
    "}",
    "",
    "async function walkPortableEntrypoints({ format, loadEntrypoint }) {",
    "  const expectations = loadExpectations();",
    "  const walked = [];",
    "  for (const entrypoint of expectations.portableEntrypoints) {",
    "    const specifier = expectations.entrypointSpecifiers[entrypoint];",
    "    const moduleExports = await loadEntrypoint(specifier);",
    "    const exportCount = Object.keys(moduleExports).length;",
    "    assert.ok(",
    "      exportCount > 0,",
    "      `${format} of ${entrypoint} exported no members`,",
    "    );",
    "    walked.push(entrypoint);",
    "  }",
    "  assert.deepEqual(",
    "    walked.toSorted(),",
    "    expectations.portableEntrypoints.toSorted(),",
    "    `walked portable entrypoint set does not match expectations for format ${format}`,",
    "  );",
    "}",
    "",
    "async function walkLedger({ format, loadEntrypoint, buildGraph }) {",
    "  const expectations = loadExpectations();",
    "  const rows = expectations.ledger.filter((row) =>",
    "    row.formats.includes(format),",
    "  );",
    "  const asserted = [];",
    "",
    "  for (const row of rows) {",
    "    const specifier = expectations.entrypointSpecifiers[row.entrypoint];",
    "",
    '    if (row.arm === "typed-refusal") {',
    "      const moduleExports = await loadEntrypoint(specifier);",
    "      const factoryName = expectations.typedRefusalFactories[row.entrypoint];",
    "      if (factoryName === undefined) {",
    "        throw new Error(",
    "          `No TYPED_REFUSAL_FACTORIES entry for ${row.entrypoint}`,",
    "        );",
    "      }",
    "      const factory = moduleExports[factoryName];",
    "      assert.equal(",
    "        typeof factory,",
    '        "function",',
    "        `${row.entrypoint}: ${factoryName} is not a function`,",
    "      );",
    "",
    "      let caught;",
    "      try {",
    "        await factory(buildGraph(), {",
    '          schemaManagement: { systemIndexes: "skip" },',
    "        });",
    "      } catch (error) {",
    "        caught = error;",
    "      }",
    "      assert.ok(",
    "        caught !== undefined,",
    "        `${row.entrypoint} (${format}): expected the factory to reject`,",
    "      );",
    "      assert.equal(",
    "        caught.name,",
    '        "ConfigurationError",',
    "        `${row.entrypoint} (${format}): expected ConfigurationError, got ${caught.name}`,",
    "      );",
    "      assert.equal(",
    "        caught.details && caught.details.code,",
    "        expectations.refusalDetailsCode,",
    "        `${row.entrypoint} (${format}): wrong details.code`,",
    "      );",
    "      assert.equal(",
    "        caught.details && caught.details.package,",
    "        expectations.missingPeerPackage,",
    "        `${row.entrypoint} (${format}): wrong details.package`,",
    "      );",
    "      assert.equal(",
    "        caught.details && caught.details.entrypoint,",
    "        row.entrypoint,",
    "        `${row.entrypoint} (${format}): wrong details.entrypoint`,",
    "      );",
    "      assert.ok(",
    "        caught.message.includes(expectations.missingPeerPackage),",
    "        `${row.entrypoint} (${format}): message does not mention the peer`,",
    "      );",
    "      assert.ok(",
    "        caught.message.includes(expectations.missingPeerInstallCommand),",
    "        `${row.entrypoint} (${format}): message does not mention the install command`,",
    "      );",
    "      const cause = caught.cause;",
    "      assert.ok(",
    "        cause !== undefined,",
    "        `${row.entrypoint} (${format}): expected a cause`,",
    "      );",
    "      assert.ok(",
    "        expectations.missingModuleErrorCodes.includes(cause.code),",
    "        `${row.entrypoint} (${format}): cause.code ${cause.code} is not a recognised missing-module code`,",
    "      );",
    "      assert.ok(",
    "        /drizzle-orm/.test(cause.message),",
    "        `${row.entrypoint} (${format}): cause message does not name a drizzle-orm specifier`,",
    "      );",
    "      console.log(",
    "        `${row.entrypoint} (${format}): cause.code = ${cause.code}`,",
    "      );",
    "      asserted.push(row.entrypoint);",
    "      continue;",
    "    }",
    "",
    '    if (row.arm === "documented-resolution-error") {',
    "      let caught;",
    "      try {",
    "        await loadEntrypoint(specifier);",
    "      } catch (error) {",
    "        caught = error;",
    "      }",
    "      assert.ok(",
    "        caught !== undefined,",
    "        `${row.entrypoint} (${format}): expected module load to fail`,",
    "      );",
    "      assert.ok(",
    "        expectations.missingModuleErrorCodes.includes(caught.code),",
    "        `${row.entrypoint} (${format}): code ${caught.code} is not a recognised missing-module code`,",
    "      );",
    "      assert.ok(",
    "        /drizzle-orm/.test(caught.message),",
    "        `${row.entrypoint} (${format}): message does not name drizzle-orm`,",
    "      );",
    "      assert.notEqual(",
    "        caught.name,",
    '        "ConfigurationError",',
    "        `${row.entrypoint} (${format}): the documented-resolution-error arm must not be the typed refusal`,",
    "      );",
    "      assert.notEqual(",
    "        caught.details && caught.details.code,",
    "        expectations.refusalDetailsCode,",
    "        `${row.entrypoint} (${format}): the documented-resolution-error arm must not carry ${expectations.refusalDetailsCode}`,",
    "      );",
    "      asserted.push(row.entrypoint);",
    "      continue;",
    "    }",
    "",
    "    throw new Error(`Unknown ledger arm ${row.arm} for ${row.entrypoint}`);",
    "  }",
    "",
    "  assert.deepEqual(",
    "    asserted.toSorted(),",
    "    rows.map((row) => row.entrypoint).toSorted(),",
    "    `asserted-entrypoint set does not match the format-${format} ledger rows`,",
    "  );",
    "}",
    "",
    "module.exports = {",
    "  assertLedgerPartitionsExports,",
    "  loadExpectations,",
    "  walkLedger,",
    "  walkPortableEntrypoints,",
    "};",
    "",
  ].join("\n");
}

/** `run.mjs` — the ESM walk. Thin: it names the four calls and nothing else. */
export function renderPortableEsmRunner(): string {
  return [
    'import assert from "node:assert/strict";',
    'import { defineGraph, defineNode } from "@nicia-ai/typegraph";',
    'import { z } from "zod";',
    "",
    'import { exercisePortableConsumer } from "./dist/index.js";',
    "import {",
    "  assertLedgerPartitionsExports,",
    "  loadExpectations,",
    "  walkLedger,",
    "  walkPortableEntrypoints,",
    '} from "./walk.cjs";',
    "",
    "const expectations = loadExpectations();",
    "",
    'const LedgerProbeNode = defineNode("LedgerProbeNode", {',
    "  schema: z.object({ value: z.string() }),",
    "});",
    "function buildGraph() {",
    "  return defineGraph({",
    '    id: "ledger-probe",',
    "    nodes: { LedgerProbeNode: { type: LedgerProbeNode } },",
    "    edges: {},",
    "  });",
    "}",
    "",
    "assertLedgerPartitionsExports();",
    "",
    "await walkPortableEntrypoints({",
    '  format: "import",',
    "  loadEntrypoint: (specifier) => import(specifier),",
    "});",
    "",
    "await walkLedger({",
    '  format: "import",',
    "  loadEntrypoint: (specifier) => import(specifier),",
    "  buildGraph,",
    "});",
    "",
    "const rows = await exercisePortableConsumer();",
    "assert.deepEqual(",
    "  rows.map((row) => row.entrypoint).toSorted(),",
    "  expectations.portableEntrypoints.toSorted(),",
    ");",
    "",
    "console.log(",
    '  "run.mjs: portable ESM walk complete (entrypoints imported, ledger exhausted).",',
    ");",
    "",
  ].join("\n");
}

/** `run.cjs` — the CJS walk. Same four calls, `require` in place of `import`, wrapped so a rejection exits non-zero. */
export function renderPortableCjsRunner(): string {
  return [
    '"use strict";',
    "",
    'const assert = require("node:assert/strict");',
    'const { defineGraph, defineNode } = require("@nicia-ai/typegraph");',
    'const { z } = require("zod");',
    "const {",
    "  assertLedgerPartitionsExports,",
    "  loadExpectations,",
    "  walkLedger,",
    "  walkPortableEntrypoints,",
    '} = require("./walk.cjs");',
    "",
    "async function main() {",
    "  const expectations = loadExpectations();",
    "",
    '  const LedgerProbeNode = defineNode("LedgerProbeNode", {',
    "    schema: z.object({ value: z.string() }),",
    "  });",
    "  function buildGraph() {",
    "    return defineGraph({",
    '      id: "ledger-probe",',
    "      nodes: { LedgerProbeNode: { type: LedgerProbeNode } },",
    "      edges: {},",
    "    });",
    "  }",
    "",
    "  assertLedgerPartitionsExports();",
    "",
    "  await walkPortableEntrypoints({",
    '    format: "require",',
    "    loadEntrypoint: (specifier) => Promise.resolve(require(specifier)),",
    "  });",
    "",
    "  await walkLedger({",
    '    format: "require",',
    "    loadEntrypoint: (specifier) => Promise.resolve(require(specifier)),",
    "    buildGraph,",
    "  });",
    "",
    '  const { exercisePortableConsumer } = await import("./dist/index.js");',
    "  const rows = await exercisePortableConsumer();",
    "  assert.deepEqual(",
    "    rows.map((row) => row.entrypoint).toSorted(),",
    "    expectations.portableEntrypoints.toSorted(),",
    "  );",
    "",
    "  console.log(",
    '    "run.cjs: portable CJS walk complete (entrypoints required, ledger exhausted).",',
    "  );",
    "}",
    "",
    "main().catch((error) => {",
    "  console.error(error);",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
}

/** Fixture 1, unchanged in behaviour: Drizzle installed, both TypeScript versions, its original `run.mjs`. */
async function runDrizzlePresentFixture(
  temporaryDirectory: string,
  tarballPath: string,
  packageJson: PackageJson,
  packageDirectory: string,
): Promise<void> {
  const planEntry = fixturePlanEntry("fixture");
  const fixtureDirectory = path.join(
    temporaryDirectory,
    planEntry.directoryName,
  );
  await mkdir(path.join(fixtureDirectory, "src"), { recursive: true });
  await copyFile(
    path.join(packageDirectory, "type-smoke", "strict-local-consumers.ts"),
    path.join(fixtureDirectory, "src", "index.ts"),
  );

  const dependencies = {
    "@electric-sql/pglite": normalizeVersion(
      packageJson.devDependencies?.["@electric-sql/pglite"],
      "0.5.4",
    ),
    "@nicia-ai/typegraph": `file:${tarballPath}`,
    "better-sqlite3": normalizeVersion(
      packageJson.devDependencies?.["better-sqlite3"],
      "12.11.1",
    ),
    "drizzle-orm": DRIZZLE_VERSION,
    zod: normalizeVersion(packageJson.devDependencies?.["zod"], "4.4.3"),
  };
  const devDependencies = {
    "@types/node": normalizeVersion(
      packageJson.devDependencies?.["@types/node"],
      "24.13.2",
    ),
    typescript: TYPESCRIPT_VERSIONS[0],
  };
  await writeFixturePackageJson(
    fixtureDirectory,
    "typegraph-strict-local-consumers",
    dependencies,
    devDependencies,
  );
  await writeFixtureTsconfig(fixtureDirectory);

  await installFixture(fixtureDirectory);
  await assertDrizzlePresence(
    fixtureDirectory,
    planEntry.expectsDrizzleInstalled,
  );
  await assertForbiddenDriversAbsent(fixtureDirectory, FORBIDDEN_DRIVERS);

  for (const [index, typescriptVersion] of TYPESCRIPT_VERSIONS.entries()) {
    if (index > 0) {
      await run(
        "npm",
        [
          "install",
          "--no-save",
          "--omit=optional",
          "--no-package-lock",
          "--ignore-scripts",
          `typescript@${typescriptVersion}`,
        ],
        fixtureDirectory,
      );
    }
    const listFiles = await compileFixture(fixtureDirectory, typescriptVersion);
    assertNoDrizzleDeclarations(listFiles, typescriptVersion);
  }

  await writeFile(
    path.join(fixtureDirectory, "run.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { createRequire } from "node:module";',
      'import { defineGraph, defineNode } from "@nicia-ai/typegraph";',
      'import { createLocalSqliteStore } from "@nicia-ai/typegraph/sqlite/local";',
      'import { z } from "zod";',
      'import { exerciseStrictLocalConsumers } from "./dist/index.js";',
      "const require = createRequire(import.meta.url);",
      'const { exportGraph } = require("@nicia-ai/typegraph/interchange");',
      "const result = await exerciseStrictLocalConsumers();",
      "const expectedStoreResult = {",
      '  statement: "verified",',
      "  confidence: 0.9,",
      "  queryCount: 1,",
      "  reachableCount: 2,",
      "  transactionFactCount: 1,",
      "};",
      "assert.deepEqual(result, {",
      "  pglite: expectedStoreResult,",
      "  sqlite: expectedStoreResult,",
      "});",
      'const CrossFormatNode = defineNode("CrossFormatNode", {',
      "  schema: z.object({ value: z.string() }),",
      "});",
      "const crossFormatGraph = defineGraph({",
      '  id: "cross-format-runtime-port",',
      "  nodes: { CrossFormatNode: { type: CrossFormatNode } },",
      "  edges: {},",
      "});",
      "const crossFormatStore = await createLocalSqliteStore(crossFormatGraph, {",
      '  schemaManagement: { systemIndexes: "skip" },',
      "});",
      "try {",
      '  await crossFormatStore.nodes.CrossFormatNode.create({ value: "shared" });',
      "  const exported = await exportGraph(crossFormatStore);",
      "  assert.equal(exported.nodes.length, 1);",
      '  assert.equal(exported.nodes[0]?.properties.value, "shared");',
      "} finally {",
      "  await crossFormatStore.close();",
      "}",
      "",
    ].join("\n"),
  );
  await run("node", ["run.mjs"], fixtureDirectory);
}

/** Fixture 2: `drizzle-orm` absent, the ten portable entrypoints, the ledger walk in both artifact formats. */
async function runPortableFixture(
  temporaryDirectory: string,
  tarballPath: string,
  packageJson: PackageJson,
): Promise<void> {
  const planEntry = fixturePlanEntry("fixture-portable");
  const fixtureDirectory = path.join(
    temporaryDirectory,
    planEntry.directoryName,
  );
  await mkdir(path.join(fixtureDirectory, "src"), { recursive: true });

  const portableEntrypoints = portableFixtureEntrypoints();
  await writeFile(
    path.join(fixtureDirectory, "src", "index.ts"),
    renderPortableFixtureIndex(portableEntrypoints),
  );

  const dependencies = {
    "@electric-sql/pglite": normalizeVersion(
      packageJson.devDependencies?.["@electric-sql/pglite"],
      "0.5.4",
    ),
    "@nicia-ai/typegraph": `file:${tarballPath}`,
    "better-sqlite3": normalizeVersion(
      packageJson.devDependencies?.["better-sqlite3"],
      "12.11.1",
    ),
    zod: normalizeVersion(packageJson.devDependencies?.["zod"], "4.4.3"),
  };
  const devDependencies = {
    "@types/node": normalizeVersion(
      packageJson.devDependencies?.["@types/node"],
      "24.13.2",
    ),
    typescript: TYPESCRIPT_VERSIONS[0],
  };
  await writeFixturePackageJson(
    fixtureDirectory,
    "typegraph-strict-local-consumers-portable",
    dependencies,
    devDependencies,
  );
  await writeFixtureTsconfig(fixtureDirectory);

  await installFixture(fixtureDirectory);
  await assertDrizzlePresence(
    fixtureDirectory,
    planEntry.expectsDrizzleInstalled,
  );
  await assertForbiddenDriversAbsent(fixtureDirectory, [
    ...FORBIDDEN_DRIVERS,
    MISSING_PEER_PACKAGE,
  ]);

  const typescriptVersion = TYPESCRIPT_VERSIONS[0];
  const listFiles = await compileFixture(fixtureDirectory, typescriptVersion);
  assertNoDrizzleDeclarations(listFiles, typescriptVersion);

  await writeFile(
    path.join(fixtureDirectory, "fixture-expectations.json"),
    `${JSON.stringify(fixtureExpectations(), undefined, 2)}\n`,
  );
  await writeFile(
    path.join(fixtureDirectory, "walk.cjs"),
    renderLedgerWalkModule(),
  );
  await writeFile(
    path.join(fixtureDirectory, "run.mjs"),
    renderPortableEsmRunner(),
  );
  await writeFile(
    path.join(fixtureDirectory, "run.cjs"),
    renderPortableCjsRunner(),
  );

  await run("node", ["run.mjs"], fixtureDirectory);
  await run("node", ["run.cjs"], fixtureDirectory);
}

async function main(): Promise<void> {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageDirectory = path.dirname(scriptDirectory);
  const packageJson = parsePackageJson(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "typegraph-strict-local-consumers-"),
  );
  const tarballPath = path.join(temporaryDirectory, "typegraph.tgz");

  try {
    await run("pnpm", ["build"], packageDirectory, true);
    await run("pnpm", ["pack", "--out", tarballPath], packageDirectory, true);

    await runDrizzlePresentFixture(
      temporaryDirectory,
      tarballPath,
      packageJson,
      packageDirectory,
    );
    await runPortableFixture(temporaryDirectory, tarballPath, packageJson);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(
    [
      `Strict packed SQLite and PGlite consumers passed with TypeScript ${TYPESCRIPT_VERSIONS.join(" and ")}, skipLibCheck=false, no unused drivers, and zero Drizzle declarations.`,
      "The portable fixture (drizzle-orm absent) exhausted MISSING_PEER_LEDGER over both the ESM (run.mjs) and CJS (run.cjs) install-grain walks.",
    ].join(" "),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await main();
}
