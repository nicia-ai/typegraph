import { execSync } from "node:child_process";

export function resolveGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

export function resolveGitRefName(): string | undefined {
  try {
    const ref = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
    }).trim();
    return ref === "HEAD" ? undefined : ref;
  } catch {
    return undefined;
  }
}
