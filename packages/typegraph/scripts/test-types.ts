import { spawn } from "node:child_process";
import {
  copyFile,
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reportNameForExport } from "./api-report-names";
import { hasDeclarationLoadBlock } from "./declaration-loads";
import { COVERED_ENTRYPOINTS } from "./entrypoint-stability";

type TestMode = "all" | "inline" | "declarations" | "consumer";

type TypegraphPackageJson = Readonly<{
  devDependencies?: Readonly<Record<string, string>>;
  exports?: Readonly<Record<string, Readonly<{ types: string }>>>;
}>;

const PACKAGE_NAME = "@nicia-ai/typegraph";

/**
 * The module resolutions each declaration-emit fixture compiles under. Each
 * names a checked-in `type-smoke/tsconfig.declaration-emit.<name>.json` that
 * a per-fixture config extends.
 */
const DECLARATION_EMIT_RESOLUTIONS = ["bundler", "node16"] as const;

/** The directory of declaration-emit fixtures, under `type-smoke`. */
const DECLARATION_EMIT_FIXTURE_DIR = "declaration-emit";

/**
 * Packages other than TypeGraph an emitted consumer declaration may import,
 * with any of their subpaths: the consumer depends on them directly.
 */
const DECLARATION_EMIT_FOREIGN_PACKAGES: readonly string[] = [
  "zod",
  "drizzle-orm",
];

/** How many fixture compilations run at once. */
const DECLARATION_EMIT_CONCURRENCY = Math.max(
  1,
  Math.min(8, Math.floor(availableParallelism() / 2)),
);

const MODULE_SPECIFIER_PATTERN =
  /\b(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;

function getUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeVersionSpecifier(versionSpecifier: string): string {
  const cleaned = versionSpecifier.trim().replace(/^[~^]/, "");
  return cleaned.length > 0 ? cleaned : versionSpecifier.trim();
}

function getTypeScriptMajorVersion(typescriptVersion: string): number {
  const majorVersionMatch = /^(\d+)\./.exec(typescriptVersion);
  if (!majorVersionMatch) {
    return 0;
  }

  return Number.parseInt(majorVersionMatch[1] ?? "0", 10);
}

function getTypeScriptCliArguments(
  typescriptVersion: string,
): readonly string[] {
  const arguments_ = [
    "dlx",
    `--package=typescript@${typescriptVersion}`,
    "tsc",
  ];
  const majorVersion = getTypeScriptMajorVersion(typescriptVersion);

  if (majorVersion >= 6) {
    arguments_.push("--ignoreDeprecations", "6.0");
  }

  return arguments_;
}

function getMode(argument: string | undefined): TestMode {
  if (
    argument === undefined ||
    argument === "all" ||
    argument === "inline" ||
    argument === "declarations" ||
    argument === "consumer"
  ) {
    return argument ?? "all";
  }

  throw new Error(
    `Unknown test mode "${argument}". Use one of: all, inline, declarations, consumer.`,
  );
}

function getTypeScriptVersion(packageJson: TypegraphPackageJson): string {
  const override = process.env["TYPEGRAPH_TYPESCRIPT_VERSION"];
  if (override !== undefined && override.trim().length > 0) {
    return override.trim();
  }

  const localSpecifier = packageJson.devDependencies?.["typescript"];
  if (localSpecifier === undefined) {
    throw new Error(
      "Unable to resolve TypeScript version. Set TYPEGRAPH_TYPESCRIPT_VERSION or add devDependencies.typescript.",
    );
  }

  return normalizeVersionSpecifier(localSpecifier);
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      reject(error);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Command failed with exit code ${code ?? "unknown"}: ${command} ${args.join(" ")}`,
        ),
      );
    });
  });
}

/**
 * The public module specifiers a consumer can import: the package name joined
 * with each `exports` key.
 */
function publicEntrypointSpecifiers(
  packageJson: TypegraphPackageJson,
): ReadonlySet<string> {
  const exportKeys = Object.keys(packageJson.exports ?? {});
  if (exportKeys.length === 0) {
    throw new Error("packages/typegraph/package.json declares no exports.");
  }
  return new Set(
    exportKeys.map((exportKey) =>
      exportKey === "." ? PACKAGE_NAME : (
        `${PACKAGE_NAME}/${exportKey.slice(2)}`
      ),
    ),
  );
}

function isForeignPackageSpecifier(specifier: string): boolean {
  return DECLARATION_EMIT_FOREIGN_PACKAGES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

/**
 * Every module specifier in an emitted declaration that is neither a public
 * TypeGraph entrypoint nor an allowed foreign package. A type TypeScript could
 * not name through an entrypoint the program imports surfaces either as a
 * TS2742/TS2883 refusal or, when the path happens to resolve, as a relative
 * `dist/<hashed chunk>` specifier; this catches the second form.
 */
function nonPublicDeclarationSpecifiers(
  declarationSource: string,
  publicSpecifiers: ReadonlySet<string>,
): readonly string[] {
  const offending = new Set<string>();
  for (const match of declarationSource.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    if (publicSpecifiers.has(specifier)) continue;
    if (isForeignPackageSpecifier(specifier)) continue;
    offending.add(specifier);
  }
  return [...offending].toSorted();
}

async function assertDeclarationsNamePublicEntrypoints(
  outputDir: string,
  publicSpecifiers: ReadonlySet<string>,
): Promise<void> {
  const entries = await readdir(outputDir);
  const files = entries.filter((file) => file.endsWith(".d.ts"));
  if (files.length === 0) {
    throw new Error(
      `Declaration emit produced no .d.ts files in ${outputDir}.`,
    );
  }
  for (const file of files) {
    const source = await readFile(path.join(outputDir, file), "utf8");
    const offending = nonPublicDeclarationSpecifiers(source, publicSpecifiers);
    if (offending.length > 0) {
      throw new Error(
        `${path.join(outputDir, file)} references non-public modules: ${offending.join(", ")}`,
      );
    }
  }
}

type CapturedRun = Readonly<{ code: number; output: string }>;

/** Runs a command with its output buffered, so concurrent runs stay legible. */
async function runCommandCaptured(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CapturedRun> {
  return await new Promise<CapturedRun>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString() });
    });
  });
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: limit }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await run(item);
    }
  });
  await Promise.all(workers);
}

type DeclarationEmitFixture = Readonly<{
  /** The fixture's file name without `.ts`. */
  name: string;
  /** The TypeGraph entrypoint specifiers the fixture imports. */
  specifiers: readonly string[];
}>;

function specifierOfEntrypoint(entrypoint: string): string {
  return entrypoint === "." ? PACKAGE_NAME : (
      `${PACKAGE_NAME}/${entrypoint.slice(2)}`
    );
}

/**
 * Reads the declaration-emit fixtures and refuses a set that could hide a
 * per-entrypoint gap. Each covered entrypoint has a fixture named after its
 * API report (`typegraph-core.ts` for `/core`) that imports that entrypoint
 * and no other: a second entrypoint in the program would make the types it
 * exports nameable and mask a type the fixture's entrypoint fails to make
 * nameable. Any other fixture composes two or more covered entrypoints. A
 * fixture imports nothing else but the foreign packages a consumer depends on.
 */
async function readDeclarationEmitFixtures(
  fixtureDir: string,
): Promise<readonly DeclarationEmitFixture[]> {
  const files = (await readdir(fixtureDir)).filter((file) =>
    file.endsWith(".ts"),
  );
  const coveredSpecifiers = new Map<string, string>(
    COVERED_ENTRYPOINTS.map((entrypoint) => [
      reportNameForExport(entrypoint),
      specifierOfEntrypoint(entrypoint),
    ]),
  );
  const allowed = new Set(coveredSpecifiers.values());
  const fixtures: DeclarationEmitFixture[] = [];
  const problems: string[] = [];
  for (const file of files.toSorted()) {
    const name = file.slice(0, -".ts".length);
    const source = await readFile(path.join(fixtureDir, file), "utf8");
    const imported = [...source.matchAll(MODULE_SPECIFIER_PATTERN)].flatMap(
      (match) => (match[1] === undefined ? [] : [match[1]]),
    );
    const specifiers = [
      ...new Set(
        imported.filter((specifier) => !isForeignPackageSpecifier(specifier)),
      ),
    ];
    const disallowed = specifiers.filter(
      (specifier) => !allowed.has(specifier),
    );
    if (disallowed.length > 0) {
      problems.push(
        `${file} imports ${disallowed.join(", ")}, which is neither a covered entrypoint nor a foreign package a consumer depends on`,
      );
    }
    const own = coveredSpecifiers.get(name);
    if (
      own !== undefined &&
      (specifiers.length !== 1 || specifiers[0] !== own)
    ) {
      problems.push(
        `${file} must import ${own} and no other entrypoint; it imports ${specifiers.join(", ")}`,
      );
    }
    if (own === undefined && specifiers.length < 2) {
      problems.push(
        `${file} imports ${specifiers.length} entrypoint(s): name a single-entrypoint fixture after its report (${[...coveredSpecifiers.keys()].join(", ")})`,
      );
    }
    fixtures.push({ name, specifiers });
  }
  for (const [name, specifier] of coveredSpecifiers) {
    if (!fixtures.some((fixture) => fixture.name === name)) {
      problems.push(
        `No declaration-emit fixture for ${specifier} (${name}.ts)`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Declaration-emit fixtures are incomplete:\n${problems.join("\n")}`,
    );
  }
  return fixtures;
}

/**
 * Refuses a packed artifact whose entry declarations do not carry the
 * declaration loads `scripts/build.ts` writes: without them a consumer
 * importing one entrypoint cannot name the types it loads from others.
 */
async function assertPackedDeclarationLoads(
  installedPackageDir: string,
  packageJson: TypegraphPackageJson,
): Promise<void> {
  const exports = packageJson.exports ?? {};
  const missing: string[] = [];
  for (const [exportPath, exported] of Object.entries(exports)) {
    for (const extension of [".d.ts", ".d.cts"]) {
      const file = exported.types.replace(/\.d\.ts$/, extension);
      const source = await readFile(
        path.join(installedPackageDir, file),
        "utf8",
      );
      if (!hasDeclarationLoadBlock(source, exports, exportPath, extension)) {
        missing.push(file);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Packed declarations lack their declaration loads: ${missing.join(", ")}`,
    );
  }
}

async function getPackageJson(
  packageDir: string,
): Promise<TypegraphPackageJson> {
  const packageJsonPath = path.join(packageDir, "package.json");
  const rawContents = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(rawContents) as unknown;

  if (typeof parsed !== "object" || !parsed) {
    throw new Error(
      "packages/typegraph/package.json is not a valid JSON object.",
    );
  }

  return parsed;
}

async function ensureBuildArtifacts(packageDir: string): Promise<void> {
  console.log("Building package before declaration and consumer checks...");
  await runCommand("pnpm", ["build"], packageDir);
}

async function runInlineTypecheck(
  packageDir: string,
  typescriptVersion: string,
): Promise<void> {
  console.log(
    `Running inline typecheck with TypeScript ${typescriptVersion}...`,
  );

  const commandArguments = getTypeScriptCliArguments(typescriptVersion);

  await runCommand(
    "pnpm",
    [
      ...commandArguments,
      "--noEmit",
      "--skipLibCheck",
      "--project",
      "tsconfig.json",
    ],
    packageDir,
  );
}

async function runDeclarationTypeTests(packageDir: string): Promise<void> {
  console.log("Running declaration tests with tsd's bundled TypeScript...");

  await runCommand(
    "pnpm",
    ["dlx", "--package=tsd", "tsd", "--files", "test-d/**/*.test-d.ts"],
    packageDir,
  );
}

async function runConsumerTypeSmokeTest(
  packageDir: string,
  packageJson: TypegraphPackageJson,
  typescriptVersion: string,
): Promise<void> {
  console.log(
    `Running packed-artifact consumer smoke test with TypeScript ${typescriptVersion}...`,
  );

  const temporaryDir = await mkdtemp(
    path.join(tmpdir(), "typegraph-consumer-smoke-"),
  );
  const tarballPath = path.join(temporaryDir, "typegraph.tgz");
  const fixtureDir = path.join(packageDir, "type-smoke");

  const zodVersion = packageJson.devDependencies?.["zod"] ?? "^4.5.0";
  const drizzleVersion =
    packageJson.devDependencies?.["drizzle-orm"] ?? ">=0.35.0";

  try {
    await runCommand("pnpm", ["pack", "--out", tarballPath], packageDir);

    await copyFile(
      path.join(fixtureDir, "consumer.ts"),
      path.join(temporaryDir, "consumer.ts"),
    );
    await copyFile(
      path.join(fixtureDir, "edge-endpoint-compat.ts"),
      path.join(temporaryDir, "edge-endpoint-compat.ts"),
    );
    await copyFile(
      path.join(fixtureDir, "tsconfig.json"),
      path.join(temporaryDir, "tsconfig.json"),
    );
    await cp(
      path.join(fixtureDir, DECLARATION_EMIT_FIXTURE_DIR),
      path.join(temporaryDir, DECLARATION_EMIT_FIXTURE_DIR),
      { recursive: true },
    );
    const fixtures = await readDeclarationEmitFixtures(
      path.join(temporaryDir, DECLARATION_EMIT_FIXTURE_DIR),
    );
    for (const resolution of DECLARATION_EMIT_RESOLUTIONS) {
      const configName = `tsconfig.declaration-emit.${resolution}.json`;
      await copyFile(
        path.join(fixtureDir, configName),
        path.join(temporaryDir, configName),
      );
    }

    const smokePackageJson = {
      name: "typegraph-consumer-smoke",
      private: true,
      type: "module",
      dependencies: {
        "@nicia-ai/typegraph": "file:./typegraph.tgz",
        "drizzle-orm": drizzleVersion,
        zod: zodVersion,
      },
    };

    await writeFile(
      path.join(temporaryDir, "package.json"),
      `${JSON.stringify(smokePackageJson, undefined, 2)}\n`,
      "utf8",
    );

    await runCommand("pnpm", ["install", "--no-frozen-lockfile"], temporaryDir);
    const commandArguments = getTypeScriptCliArguments(typescriptVersion);

    await runCommand(
      "pnpm",
      [...commandArguments, "--noEmit", "--project", "tsconfig.json"],
      temporaryDir,
    );

    await assertPackedDeclarationLoads(
      path.join(temporaryDir, "node_modules", PACKAGE_NAME),
      packageJson,
    );

    const publicSpecifiers = publicEntrypointSpecifiers(packageJson);
    const runs = DECLARATION_EMIT_RESOLUTIONS.flatMap((resolution) =>
      fixtures.map((fixture) => ({ fixture, resolution })),
    );
    console.log(
      `Emitting consumer declarations for ${fixtures.length} fixtures under ${DECLARATION_EMIT_RESOLUTIONS.join(" and ")} resolution...`,
    );
    const failures: string[] = [];
    await mapWithConcurrency(
      runs,
      DECLARATION_EMIT_CONCURRENCY,
      async ({ fixture, resolution }) => {
        const label = `${fixture.name} (${resolution})`;
        const outDir = path.join("declaration-out", resolution, fixture.name);
        const configName = `tsconfig.declaration-emit.${resolution}.${fixture.name}.json`;
        await writeFile(
          path.join(temporaryDir, configName),
          `${JSON.stringify(
            {
              extends: `./tsconfig.declaration-emit.${resolution}.json`,
              compilerOptions: { outDir },
              files: [`${DECLARATION_EMIT_FIXTURE_DIR}/${fixture.name}.ts`],
            },
            undefined,
            2,
          )}\n`,
          "utf8",
        );
        const run = await runCommandCaptured(
          "pnpm",
          [...commandArguments, "--project", configName],
          temporaryDir,
        );
        if (run.code !== 0) {
          failures.push(`${label}: tsc exited ${run.code}\n${run.output}`);
          return;
        }
        try {
          await assertDeclarationsNamePublicEntrypoints(
            path.join(temporaryDir, outDir),
            publicSpecifiers,
          );
          console.log(`  ${label}: ok`);
        } catch (error: unknown) {
          failures.push(`${label}: ${getUnknownErrorMessage(error)}`);
        }
      },
    );
    if (failures.length > 0) {
      throw new Error(
        `Declaration emit failed for ${failures.length} fixture run(s):\n${failures.join("\n")}`,
      );
    }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptPath);
  const packageDir = path.dirname(scriptDir);

  const mode = getMode(process.argv[2]);
  const packageJson = await getPackageJson(packageDir);
  const typescriptVersion = getTypeScriptVersion(packageJson);

  if (mode === "all" || mode === "inline") {
    await runInlineTypecheck(packageDir, typescriptVersion);
  }

  if (mode === "all" || mode === "declarations" || mode === "consumer") {
    await ensureBuildArtifacts(packageDir);
  }

  if (mode === "all" || mode === "declarations") {
    await runDeclarationTypeTests(packageDir);
  }

  if (mode === "all" || mode === "consumer") {
    await runConsumerTypeSmokeTest(packageDir, packageJson, typescriptVersion);
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(`Type test runner failed: ${getUnknownErrorMessage(error)}`);
  process.exit(1);
}
