import { spawnSync } from "node:child_process";

function getUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isNodeModuleVersionMismatchError(error: unknown): boolean {
  const message = getUnknownErrorMessage(error);
  return message.includes("NODE_MODULE_VERSION");
}

function isMissingBindingsError(error: unknown): boolean {
  const message = getUnknownErrorMessage(error);
  if (message.includes("Could not locate the bindings file")) return true;

  return (
    message.includes("Cannot find module") &&
    message.includes("better_sqlite3.node")
  );
}

function getRecoveryReason(error: unknown): string | undefined {
  if (isNodeModuleVersionMismatchError(error)) {
    return "better-sqlite3 native addon mismatch detected.";
  }

  if (isMissingBindingsError(error)) {
    return "better-sqlite3 native addon is missing.";
  }

  return undefined;
}

async function canInstantiateBetterSqlite3Database(): Promise<void> {
  const module = await import("better-sqlite3");
  const Database = module.default;
  const sqlite = new Database(":memory:");
  sqlite.close();
}

function isSpawnENOENTError(
  error: unknown,
): error is Readonly<{ code: string }> {
  if (!error || typeof error !== "object") return false;
  if (!("code" in error)) return false;
  return typeof (error as Readonly<{ code: unknown }>).code === "string";
}

function runRebuild(): boolean {
  const commands = ["pnpm", "npm"];
  for (const command of commands) {
    const result = spawnSync(command, ["rebuild", "better-sqlite3"], {
      stdio: "inherit",
    });

    if (isSpawnENOENTError(result.error) && result.error.code === "ENOENT") {
      continue;
    }

    return result.status === 0;
  }

  return false;
}

async function main(): Promise<void> {
  try {
    await canInstantiateBetterSqlite3Database();
    return;
  } catch (error) {
    const recoveryReason = getRecoveryReason(error);
    if (!recoveryReason) {
      throw error;
    }

    console.warn(
      [
        `[typegraph] ${recoveryReason}`,
        `Node.js: ${process.version} (NODE_MODULE_VERSION ${process.versions.modules})`,
        "Attempting: rebuild better-sqlite3",
      ].join("\n"),
    );

    const rebuilt = runRebuild();
    if (!rebuilt) {
      throw new Error(
        [
          "[typegraph] Failed to rebuild better-sqlite3.",
          "Try running one of:",
          "  pnpm rebuild better-sqlite3",
          "  npm rebuild better-sqlite3",
        ].join("\n"),
        { cause: error },
      );
    }

    try {
      await canInstantiateBetterSqlite3Database();
    } catch (rebuildError) {
      throw new Error(
        "[typegraph] better-sqlite3 is still unavailable after rebuild.",
        { cause: rebuildError },
      );
    }
  }
}

await main();
