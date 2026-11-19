import { spawn } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type TestMode = "all" | "inline" | "declarations" | "consumer";

type TypegraphPackageJson = Readonly<{
  devDependencies?: Readonly<Record<string, string>>;
  exports?: Readonly<Record<string, unknown>>;
}>;

const PACKAGE_NAME = "@nicia-ai/typegraph";

/**
 * The module resolutions the declaration-emit fixture compiles under. Each
 * names a checked-in `type-smoke/tsconfig.declaration-emit.<name>.json` whose
 * `outDir` is `declaration-out/<name>`.
 */
const DECLARATION_EMIT_RESOLUTIONS = ["bundler", "node16"] as const;

/** Packages other than TypeGraph an emitted consumer declaration may import. */
const DECLARATION_EMIT_FOREIGN_MODULES: ReadonlySet<string> = new Set(["zod"]);

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
    if (DECLARATION_EMIT_FOREIGN_MODULES.has(specifier)) continue;
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
    await copyFile(
      path.join(fixtureDir, "declaration-emit.ts"),
      path.join(temporaryDir, "declaration-emit.ts"),
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

    const publicSpecifiers = publicEntrypointSpecifiers(packageJson);
    for (const resolution of DECLARATION_EMIT_RESOLUTIONS) {
      console.log(
        `Emitting consumer declarations (moduleResolution: ${resolution})...`,
      );
      await runCommand(
        "pnpm",
        [
          ...commandArguments,
          "--project",
          `tsconfig.declaration-emit.${resolution}.json`,
        ],
        temporaryDir,
      );
      await assertDeclarationsNamePublicEntrypoints(
        path.join(temporaryDir, "declaration-out", resolution),
        publicSpecifiers,
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
