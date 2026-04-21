import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type TestMode = "all" | "inline" | "declarations" | "consumer";

type TypegraphPackageJson = Readonly<{
  devDependencies?: Readonly<Record<string, string>>;
}>;

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
  const override = process.env.TYPEGRAPH_TYPESCRIPT_VERSION;
  if (override !== undefined && override.trim().length > 0) {
    return override.trim();
  }

  const localSpecifier = packageJson.devDependencies?.typescript;
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

async function runDeclarationTypeTests(
  packageDir: string,
  typescriptVersion: string,
): Promise<void> {
  console.log(
    `Running declaration (tsd) tests with TypeScript ${typescriptVersion}...`,
  );

  await runCommand(
    "pnpm",
    [
      "dlx",
      `--package=typescript@${typescriptVersion}`,
      "--package=tsd",
      "tsd",
      "--files",
      "test-d/**/*.test-d.ts",
    ],
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

  const zodVersion = packageJson.devDependencies?.zod ?? "^4.0.0";
  const drizzleVersion =
    packageJson.devDependencies?.["drizzle-orm"] ?? ">=0.35.0";

  try {
    await runCommand("pnpm", ["pack", "--out", tarballPath], packageDir);

    await copyFile(
      path.join(fixtureDir, "consumer.ts"),
      path.join(temporaryDir, "consumer.ts"),
    );
    await copyFile(
      path.join(fixtureDir, "tsconfig.json"),
      path.join(temporaryDir, "tsconfig.json"),
    );

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
    await runDeclarationTypeTests(packageDir, typescriptVersion);
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
