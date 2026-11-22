import { spawn } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  accountableDiagnostics,
  type DeclarationEmitFixture,
  nonPublicDeclarationSpecifiers,
  PACKAGE_NAME,
  validateDeclarationEmitFixtures,
} from "./declaration-emit-fixtures";
import { hasDeclarationLoadBlock } from "./declaration-loads";

type TestMode = "all" | "inline" | "declarations" | "consumer";

type TypegraphPackageJson = Readonly<{
  devDependencies?: Readonly<Record<string, string>>;
  exports?: Readonly<Record<string, Readonly<{ types: string }>>>;
}>;

/**
 * The consumer setups each declaration-emit fixture compiles under: both
 * module resolutions a modern consumer uses, each with `skipLibCheck` on and
 * off. Each names a checked-in
 * `type-smoke/tsconfig.declaration-emit.<resolution>.json` that a per-fixture
 * config extends.
 */
const DECLARATION_EMIT_VARIANTS = [
  { resolution: "bundler", skipLibCheck: true },
  { resolution: "bundler", skipLibCheck: false },
  { resolution: "node16", skipLibCheck: true },
  { resolution: "node16", skipLibCheck: false },
] as const;

const DECLARATION_EMIT_RESOLUTIONS = ["bundler", "node16"] as const;

function variantName(
  variant: Readonly<{ resolution: string; skipLibCheck: boolean }>,
): string {
  return `${variant.resolution}-${variant.skipLibCheck ? "skiplibcheck" : "libcheck"}`;
}

/** The directory of declaration-emit fixtures, under `type-smoke`. */
const DECLARATION_EMIT_FIXTURE_DIR = "declaration-emit";

/** How many fixture compilations run at once. */
const DECLARATION_EMIT_CONCURRENCY = Math.max(
  1,
  Math.min(8, Math.floor(availableParallelism() / 2)),
);

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
    const offending = nonPublicDeclarationSpecifiers(
      file,
      source,
      publicSpecifiers,
    );
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

/**
 * Reads the declaration-emit fixtures and refuses a set that could hide a
 * per-entrypoint gap (`validateDeclarationEmitFixtures`).
 */
async function readDeclarationEmitFixtures(
  fixtureDir: string,
): Promise<readonly DeclarationEmitFixture[]> {
  const entries = await readdir(fixtureDir);
  const files = await Promise.all(
    entries
      .filter((file) => file.endsWith(".ts"))
      .map(async (file) => ({
        file,
        source: await readFile(path.join(fixtureDir, file), "utf8"),
      })),
  );
  const { fixtures, problems } = validateDeclarationEmitFixtures(files);
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
  const pgliteVersion =
    packageJson.devDependencies?.["@electric-sql/pglite"] ?? "^0.5.8";
  const tsupVersion = packageJson.devDependencies?.["tsup"] ?? "^8.5.1";
  const libsqlVersion =
    packageJson.devDependencies?.["@libsql/client"] ?? "^0.18.0";
  const nodeTypesVersion =
    packageJson.devDependencies?.["@types/node"] ?? "^24.0.0";
  const betterSqliteTypesVersion =
    packageJson.devDependencies?.["@types/better-sqlite3"] ?? "^9.6.0";
  const localTypescriptVersion =
    packageJson.devDependencies?.["typescript"] ?? "^5.9.3";

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
        // The optional peer the PGlite adapter's results are typed with: a
        // consumer exporting them depends on it, and without it TypeScript
        // emits an unresolved bare `PGlite` that fails downstream.
        "@electric-sql/pglite": pgliteVersion,
        // The libSQL adapter's peer, which its declarations import.
        "@libsql/client": libsqlVersion,
        "drizzle-orm": drizzleVersion,
        zod: zodVersion,
      },
      devDependencies: {
        // The re-bundling consumer: tsup's declaration rollup
        // (rollup-plugin-dts) compiles a fixture and rolls its declarations,
        // keeping the package as an external import.
        tsup: tsupVersion,
        typescript: localTypescriptVersion,
        // A Node consumer's globals (`AbortSignal`, `URL`) and the local
        // SQLite driver's types, which a downstream program with
        // `skipLibCheck` off needs to check the declarations it loads.
        "@types/node": nodeTypesVersion,
        "@types/better-sqlite3": betterSqliteTypesVersion,
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
    const failures: string[] = [];
    let thirdPartyDiagnostics = 0;

    /**
     * Runs `tsc` and records a failure for any diagnostic the run is
     * accountable for (`accountableDiagnostics`): one in the consumer's
     * files, its emitted declarations or TypeGraph's declarations. A
     * non-zero exit with no diagnostic at all is a failure too.
     */
    async function runAccountable(
      label: string,
      configPath: string,
    ): Promise<boolean> {
      const run = await runCommandCaptured(
        "pnpm",
        [...commandArguments, "--pretty", "false", "--project", configPath],
        temporaryDir,
      );
      if (run.code === 0) return true;
      const { accountable, thirdParty } = accountableDiagnostics(run.output);
      thirdPartyDiagnostics += thirdParty.length;
      if (accountable.length === 0 && thirdParty.length > 0) return true;
      failures.push(
        `${label}: tsc exited ${run.code}\n${accountable.length > 0 ? accountable.join("\n") : run.output}`,
      );
      return false;
    }

    /**
     * Compiles a second program that imports `declarationFile` the way a
     * downstream project consumes a library's declarations, with
     * `skipLibCheck` off so the declaration itself is checked. Any
     * diagnostic fails the run: an emitted declaration that names an
     * unresolvable type passes its own emit and fails here.
     */
    async function checkDownstream(
      label: string,
      resolution: (typeof DECLARATION_EMIT_RESOLUTIONS)[number],
      declarationFile: string,
    ): Promise<boolean> {
      const downstreamDir = path.join(
        "downstream",
        label.replaceAll(/[^\w-]+/g, "_"),
      );
      await mkdir(path.join(temporaryDir, downstreamDir), { recursive: true });
      const importPath = path
        .relative(downstreamDir, declarationFile.replace(/\.d\.ts$/, ".js"))
        .split(path.sep)
        .join("/");
      await writeFile(
        path.join(temporaryDir, downstreamDir, "downstream.ts"),
        `import type * as emitted from "${importPath.startsWith(".") ? importPath : `./${importPath}`}";\nexport type Emitted = typeof emitted;\n`,
        "utf8",
      );
      const configPath = path.join(downstreamDir, "tsconfig.json");
      await writeFile(
        path.join(temporaryDir, configPath),
        `${JSON.stringify(
          {
            extends: `../../tsconfig.declaration-emit.${resolution}.json`,
            compilerOptions: {
              noEmit: true,
              declaration: false,
              emitDeclarationOnly: false,
              skipLibCheck: false,
              rootDir: "../..",
            },
            files: ["downstream.ts"],
          },
          undefined,
          2,
        )}\n`,
        "utf8",
      );
      return await runAccountable(
        `${label}: downstream program importing ${declarationFile}`,
        configPath,
      );
    }

    /** Whether every declaration in `outDir` names only public specifiers; records a failure otherwise. */
    async function namesOnlyPublicSpecifiers(
      label: string,
      outDir: string,
    ): Promise<boolean> {
      try {
        await assertDeclarationsNamePublicEntrypoints(
          path.join(temporaryDir, outDir),
          publicSpecifiers,
        );
        return true;
      } catch (error: unknown) {
        failures.push(`${label}: ${getUnknownErrorMessage(error)}`);
        return false;
      }
    }

    async function checkEmitted(
      label: string,
      resolution: (typeof DECLARATION_EMIT_RESOLUTIONS)[number],
      outDir: string,
      fixtureName: string,
    ): Promise<void> {
      if (!(await namesOnlyPublicSpecifiers(label, outDir))) return;
      if (
        await checkDownstream(
          label,
          resolution,
          path.join(outDir, `${fixtureName}.d.ts`),
        )
      ) {
        console.log(`  ${label}: ok`);
      }
    }

    const runs = DECLARATION_EMIT_VARIANTS.flatMap((variant) =>
      fixtures.map((fixture) => ({ fixture, variant })),
    );
    console.log(
      `Emitting consumer declarations for ${fixtures.length} fixtures under ${DECLARATION_EMIT_VARIANTS.map((variant) => variantName(variant)).join(", ")}, then compiling each emitted declaration downstream...`,
    );
    await mapWithConcurrency(
      runs,
      DECLARATION_EMIT_CONCURRENCY,
      async ({ fixture, variant }) => {
        const label = `${fixture.name} (${variantName(variant)})`;
        const outDir = path.join(
          "declaration-out",
          variantName(variant),
          fixture.name,
        );
        const configName = `tsconfig.declaration-emit.${variantName(variant)}.${fixture.name}.json`;
        await writeFile(
          path.join(temporaryDir, configName),
          `${JSON.stringify(
            {
              extends: `./tsconfig.declaration-emit.${variant.resolution}.json`,
              compilerOptions: { outDir, skipLibCheck: variant.skipLibCheck },
              files: [`${DECLARATION_EMIT_FIXTURE_DIR}/${fixture.name}.ts`],
            },
            undefined,
            2,
          )}\n`,
          "utf8",
        );
        if (!(await runAccountable(label, configName))) return;
        await checkEmitted(label, variant.resolution, outDir, fixture.name);
      },
    );

    console.log(
      `Re-bundling each fixture's declarations with tsup (rollup-plugin-dts, TypeScript ${localTypescriptVersion}), then compiling each bundle downstream...`,
    );
    await mapWithConcurrency(
      fixtures,
      DECLARATION_EMIT_CONCURRENCY,
      async (fixture) => {
        const label = `${fixture.name} (tsup re-bundle)`;
        const outDir = path.join("rebundle-out", fixture.name);
        const run = await runCommandCaptured(
          "pnpm",
          [
            "exec",
            "tsup",
            `${DECLARATION_EMIT_FIXTURE_DIR}/${fixture.name}.ts`,
            "--dts-only",
            "--format",
            "esm",
            "--out-dir",
            outDir,
            "--tsconfig",
            "tsconfig.declaration-emit.bundler.json",
            "--no-config",
            "--silent",
          ],
          temporaryDir,
        );
        if (run.code !== 0) {
          failures.push(`${label}: tsup exited ${run.code}\n${run.output}`);
          return;
        }
        await checkEmitted(label, "bundler", outDir, fixture.name);
      },
    );

    console.log(
      `${thirdPartyDiagnostics} diagnostic(s) located in third-party declarations were reported by skipLibCheck-off runs and not counted.`,
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
