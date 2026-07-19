import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ExampleMode = "sqlite" | "postgres";

const NUMBERED_EXAMPLE_PATTERN = /^\d{2}-.+\.ts$/;
const POSTGRES_EXAMPLE_PATTERN = /postgres(?:ql)?/i;

function parseMode(argument: string | undefined): ExampleMode {
  if (argument === undefined || argument === "sqlite") return "sqlite";
  if (argument === "postgres") return "postgres";
  throw new Error(
    `Unknown example mode "${argument}". Use either "sqlite" or "postgres".`,
  );
}

function belongsToMode(filename: string, mode: ExampleMode): boolean {
  const isPostgresExample = POSTGRES_EXAMPLE_PATTERN.test(filename);
  return mode === "postgres" ? isPostgresExample : !isPostgresExample;
}

async function runExample(
  packageDirectory: string,
  filename: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join("examples", filename)],
      {
        cwd: packageDirectory,
        env: process.env,
        stdio: "inherit",
      },
    );

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
          `Example ${filename} failed with exit code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv[2]);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageDirectory = path.dirname(scriptDirectory);
  const examplesDirectory = path.join(packageDirectory, "examples");
  const entries = await readdir(examplesDirectory, { withFileTypes: true });
  const numberedExamples = entries
    .filter(
      (entry) => entry.isFile() && NUMBERED_EXAMPLE_PATTERN.test(entry.name),
    )
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
  const selectedExamples = numberedExamples.filter((filename) =>
    belongsToMode(filename, mode),
  );

  if (selectedExamples.length === 0) {
    throw new Error(`No ${mode} examples were discovered.`);
  }

  console.log(
    `Running ${selectedExamples.length} ${mode} example${selectedExamples.length === 1 ? "" : "s"}...`,
  );
  for (const filename of selectedExamples) {
    console.log(`\n=== ${filename} ===`);
    await runExample(packageDirectory, filename);
  }
  console.log(
    `\nAll ${selectedExamples.length} ${mode} example${selectedExamples.length === 1 ? "" : "s"} passed.`,
  );
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
