/**
 * The repo-root-rooted claim-site scan for the phrase this repository's docs
 * and code comments use to assert that a module, or an install, carries no
 * Drizzle: "Drizzle" followed by a hyphen and "free" — spelled out fully as
 * {@link CLAIM_PHRASE_PATTERN}'s source, and deliberately NOT spelled
 * contiguously anywhere else in this file's own text (including this
 * comment), because this file is itself a `.ts` file under
 * {@link repositoryRoot} and would otherwise inflate its own scan.
 *
 * Round 2's claim-site list was a hand count and it was wrong (7 occurrences
 * in 4 source files and 3 docs pages, when the repository actually carries
 * 13 in 11 files — including the shipped `packages/typegraph/README.md` and
 * a whole heading in `backend-setup.md` making the same claim). This scan is
 * the derived replacement: {@link scanClaimSites} walks the repository from
 * {@link repositoryRoot} — NOT from `packages/typegraph`, which the same
 * search would undercount, since the 13/11 figure includes the repo-root
 * `README.md` and three `apps/docs` pages that do not exist under
 * `packages/typegraph` — and every exclusion is DATA
 * ({@link EXCLUDED_DIRECTORY_NAMES}, {@link EXCLUDED_FILE_PATTERN}), so "I
 * excluded it because I ran a different grep" is not an expressible outcome.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** One line, in one scanned file, matching {@link CLAIM_PHRASE_PATTERN}. */
export type ClaimSite = Readonly<{
  /** Repository-root-relative, POSIX-separated. */
  file: string;
  /** 1-indexed. */
  line: number;
  /** The matched line, trimmed. */
  text: string;
}>;

/**
 * The phrase every claim site names, case-insensitively. Assembled from two
 * pieces rather than written as one literal so this module's own source text
 * never spells the phrase contiguously — see the module doc above.
 */
export const CLAIM_PHRASE_PATTERN = new RegExp(
  `${"driz" + "zle"}-${"fr" + "ee"}`,
  "i",
);

/** Directories the scan never descends into. */
export const EXCLUDED_DIRECTORY_NAMES: readonly string[] = [
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  "coverage",
  ".vitest-reports",
  ".astro",
  "build",
];

/** Files whose basename matches this are never scanned — the immutable changelog. */
export const EXCLUDED_FILE_PATTERN = /changelog/i;

/** The only extensions the scan reads. */
export const SCANNED_EXTENSIONS: readonly string[] = [".md", ".ts"];

/** The repository root: two directories above `packages/typegraph/scripts`. */
export function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function shouldScanFile(fileName: string): boolean {
  if (EXCLUDED_FILE_PATTERN.test(fileName)) return false;
  return SCANNED_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}

function collectClaimSitesInFile(
  root: string,
  absoluteFilePath: string,
): ClaimSite[] {
  const text = fs.readFileSync(absoluteFilePath, "utf8");
  const lines = text.split(/\r?\n/);
  const relativeFile = path
    .relative(root, absoluteFilePath)
    .split(path.sep)
    .join("/");

  const sites: ClaimSite[] = [];
  for (const [index, line] of lines.entries()) {
    if (CLAIM_PHRASE_PATTERN.test(line)) {
      sites.push({ file: relativeFile, line: index + 1, text: line.trim() });
    }
  }
  return sites;
}

function walk(root: string, directory: string, sites: ClaimSite[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.includes(entry.name)) continue;
      walk(root, path.join(directory, entry.name), sites);
      continue;
    }
    if (!shouldScanFile(entry.name)) continue;
    sites.push(
      ...collectClaimSitesInFile(root, path.join(directory, entry.name)),
    );
  }
}

/**
 * Every claim site in the repository matching {@link CLAIM_PHRASE_PATTERN},
 * sorted by file then line. Rooted at {@link repositoryRoot}, so it finds
 * sites this same search run from `packages/typegraph` would miss.
 */
export function scanClaimSites(): readonly ClaimSite[] {
  const root = repositoryRoot();
  const sites: ClaimSite[] = [];
  walk(root, root, sites);
  return sites.toSorted(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line,
  );
}

function formatSites(sites: readonly ClaimSite[]): string {
  const lines = sites.map((site) => `${site.file}:${site.line}  ${site.text}`);
  const fileCount = new Set(sites.map((site) => site.file)).size;
  lines.push(`${sites.length} occurrences / ${fileCount} files`);
  return lines.join("\n");
}

function runCli(): void {
  const sites = scanClaimSites();
  console.log(formatSites(sites));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runCli();
}
