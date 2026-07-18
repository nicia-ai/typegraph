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

const TYPESCRIPT_VERSION = "6.0.3";
const FORBIDDEN_DRIVERS = ["gel", "mysql2", "pg", "postgres"] as const;

type PackageJson = Readonly<{
  devDependencies?: Readonly<Record<string, string>>;
}>;

function normalizedVersion(
  value: string | undefined,
  fallback: string,
): string {
  return value?.replace(/^[~^]/, "") ?? fallback;
}

function parsePackageJson(contents: string): PackageJson {
  const value: unknown = JSON.parse(contents);
  if (typeof value !== "object" || value === null) {
    throw new Error("TypeGraph package manifest must be a JSON object.");
  }
  if (!("devDependencies" in value) || value.devDependencies === undefined) {
    return {};
  }
  if (
    typeof value.devDependencies !== "object" ||
    value.devDependencies === null ||
    !Object.values(value.devDependencies).every(
      (dependency) => typeof dependency === "string",
    )
  ) {
    throw new Error("TypeGraph devDependencies must be a string map.");
  }
  return {
    devDependencies: value.devDependencies as Readonly<Record<string, string>>,
  };
}

async function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  capture = false,
): Promise<string> {
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
    const child = spawn(command, arguments_, {
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
    child.on("error", reject);
    child.on("exit", (code) => {
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

async function assertPathAbsent(pathToCheck: string, message: string) {
  try {
    await stat(pathToCheck);
  } catch {
    return;
  }
  throw new Error(message);
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
      "@electric-sql/pglite": normalizedVersion(
        packageJson.devDependencies?.["@electric-sql/pglite"],
        "0.5.4",
      ),
      "@nicia-ai/typegraph": `file:${tarballPath}`,
      "better-sqlite3": normalizedVersion(
        packageJson.devDependencies?.["better-sqlite3"],
        "12.11.1",
      ),
      "drizzle-orm": "0.45.2",
      zod: normalizedVersion(packageJson.devDependencies?.zod, "4.4.3"),
    };
    const devDependencies = {
      "@types/better-sqlite3": normalizedVersion(
        packageJson.devDependencies?.["@types/better-sqlite3"],
        "7.6.13",
      ),
      "@types/node": normalizedVersion(
        packageJson.devDependencies?.["@types/node"],
        "24.13.2",
      ),
      typescript: TYPESCRIPT_VERSION,
    };
    await writeFile(
      path.join(fixtureDirectory, "package.json"),
      `${JSON.stringify(
        { private: true, type: "module", dependencies, devDependencies },
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

    await run("npm", ["install", "--omit=optional"], fixtureDirectory);
    const listFiles = await run(
      path.join(fixtureDirectory, "node_modules", ".bin", "tsc"),
      ["--listFiles"],
      fixtureDirectory,
      true,
    );

    if (
      listFiles.includes(
        `${path.sep}node_modules${path.sep}drizzle-orm${path.sep}`,
      )
    ) {
      throw new Error("A Drizzle declaration entered the TypeScript program.");
    }
    for (const driver of FORBIDDEN_DRIVERS) {
      await assertPathAbsent(
        path.join(fixtureDirectory, "node_modules", driver),
        `Unused database driver was installed: ${driver}`,
      );
    }

    await writeFile(
      path.join(fixtureDirectory, "run.mjs"),
      [
        'import { exerciseStrictLocalConsumers } from "./dist/index.js";',
        "const result = await exerciseStrictLocalConsumers();",
        'const expectedStoreResult = { statement: "verified", confidence: 0.9, factCount: 0 };',
        "const expected = { sqlite: expectedStoreResult, pglite: expectedStoreResult };",
        "if (JSON.stringify(result) !== JSON.stringify(expected)) throw new Error(JSON.stringify(result));",
        "",
      ].join("\n"),
    );
    await run("node", ["run.mjs"], fixtureDirectory);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(
    `Strict packed SQLite and PGlite consumers passed with TypeScript ${TYPESCRIPT_VERSION}, skipLibCheck=false, and no unused drivers or dialect declarations.`,
  );
}

await main();
