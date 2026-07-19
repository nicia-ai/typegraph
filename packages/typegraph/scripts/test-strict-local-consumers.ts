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

const TYPESCRIPT_VERSIONS = ["5.9.3", "6.0.3"] as const;
const DRIZZLE_VERSION = "0.45.2";
const FORBIDDEN_DRIVERS = ["gel", "mysql2", "pg", "postgres"] as const;

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

async function main(): Promise<void> {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageDirectory = path.dirname(scriptDirectory);
  const packageJson = parsePackageJson(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "typegraph-strict-local-consumers-"),
  );
  const fixtureDirectory = path.join(temporaryDirectory, "fixture");
  const tarballPath = path.join(temporaryDirectory, "typegraph.tgz");

  try {
    await run("pnpm", ["build"], packageDirectory, true);
    await run("pnpm", ["pack", "--out", tarballPath], packageDirectory, true);
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
    await writeFile(
      path.join(fixtureDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "typegraph-strict-local-consumers",
          private: true,
          type: "module",
          dependencies,
          devDependencies,
        },
        undefined,
        2,
      )}\n`,
    );
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

    await run(
      "npm",
      ["install", "--omit=optional", "--no-package-lock"],
      fixtureDirectory,
    );
    const drizzleDirectory = path.join(
      fixtureDirectory,
      "node_modules",
      "drizzle-orm",
    );
    if (!(await pathExists(drizzleDirectory))) {
      throw new Error(
        "The strict fixture must install Drizzle to prove its declarations stay unreachable.",
      );
    }
    for (const driver of FORBIDDEN_DRIVERS) {
      await assertPathAbsent(
        path.join(fixtureDirectory, "node_modules", driver),
        `Unused database driver was installed: ${driver}`,
      );
    }

    const tscPath = path.join(fixtureDirectory, "node_modules", ".bin", "tsc");
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
      const listFiles = await run(
        tscPath,
        ["--listFiles"],
        fixtureDirectory,
        true,
      );
      const portableListFiles = listFiles.replaceAll("\\", "/");
      if (portableListFiles.includes("/node_modules/drizzle-orm/")) {
        throw new Error(
          `A Drizzle declaration entered the TypeScript ${typescriptVersion} program.`,
        );
      }
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
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(
    `Strict packed SQLite and PGlite consumers passed with TypeScript ${TYPESCRIPT_VERSIONS.join(" and ")}, skipLibCheck=false, no unused drivers, and zero Drizzle declarations.`,
  );
}

await main();
