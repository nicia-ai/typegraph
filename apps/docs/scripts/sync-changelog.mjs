// Syncs packages/typegraph/CHANGELOG.md into the docs content collection so
// /changelog renders the same release notes changesets writes. Wired into
// predev/prebuild — the derived file is gitignored.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const source = path.resolve(repoRoot, "packages/typegraph/CHANGELOG.md");
const destination = path.resolve(here, "../src/content/docs/changelog.md");

if (!existsSync(source)) {
  process.stderr.write(
    `[sync-changelog] source not found: ${source} — skipping\n`,
  );
  process.exit(0);
}

const raw = readFileSync(source, "utf8");

// Strip the leading "# @nicia-ai/typegraph" H1 — Starlight renders its own title
// from frontmatter, and a duplicate H1 produces two stacked headings.
const body = raw.replace(/^#\s+@nicia-ai\/typegraph\s*\n+/m, "");

const frontmatter = [
  "---",
  "title: Changelog",
  "description: Release notes for @nicia-ai/typegraph",
  "sidebar:",
  "  order: 99",
  "---",
  "",
  "Release notes for [`@nicia-ai/typegraph`](https://www.npmjs.com/package/@nicia-ai/typegraph). Generated from `packages/typegraph/CHANGELOG.md` on every build.",
  "",
  "",
].join("\n");

mkdirSync(path.dirname(destination), { recursive: true });
writeFileSync(destination, frontmatter + body);
process.stdout.write(`[sync-changelog] wrote ${destination}\n`);
