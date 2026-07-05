/**
 * Process/network helpers shared by the imperative-container engine drivers
 * (Postgres, Neo4j) and the competitor doctor. Adapted from the sibling
 * braiddb project's `scripts/lib.ts`.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";

/** Run a command, resolving stdout; rejects with stderr on non-zero exit. */
export function spawnCapture(
  command: string,
  commandArgs: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${commandArgs.join(" ")} failed (${code}): ${stderr}`,
        ),
      );
    });
  });
}

export type SpawnStatusResult = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
}>;

/** Like `spawnCapture`, but resolves (never rejects) with the exit status. */
export function spawnStatus(
  command: string,
  commandArgs: readonly string[],
  timeoutMs: number,
): Promise<SpawnStatusResult> {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const finish = (result: Omit<SpawnStatusResult, "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, timedOut });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr, error: stringifyError(error) });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

/** An OS-assigned localhost port that was free at probe time. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate local port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Writes a JSON result file, creating parent directories as needed. */
export async function writeJsonFile(
  outputPath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
