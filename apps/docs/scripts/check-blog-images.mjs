// Fails if a published (non-draft) blog post is missing `cover` or `social`
// frontmatter, or if its cover art breaks the mechanical rules in
// lib/cover-lint.mjs (canvas size, label legibility, banned caption bands).
// Wired into pretypecheck/prebuild so a post can't ship without generated
// cover art, and no NEW cover can ship breaking those rules.
//
// Covers that predate the rules are listed in LINT_BACKLOG below and
// report without failing, so the backlog is visible without blocking the
// build. The list is a ratchet: a backlogged cover that starts passing
// fails the check until it is removed from the list, so entries cannot
// outlive the problem they describe.
//
// Each post is a directory under src/content/docs/blog/ containing
// index.mdx, generate-images.mjs, cover.png, and social.png side by side —
// see src/content/docs/blog/_template/ for the starting point and
// src/content/docs/blog/graph-merge/ for a worked bespoke-diagram example.
//
// Parses frontmatter with a couple of targeted regexes rather than a YAML
// library — every post's frontmatter is hand-authored from
// _template/_index.mdx (renamed to index.mdx on publish — see that file's
// header comment), so the shape is fully within our control and a real
// parser is more machinery than this needs.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { lintCover } from "./lib/cover-lint.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const blogDir = path.resolve(here, "../src/content/docs/blog");

/**
 * Covers that already broke these rules when the rules were introduced
 * (2026-08). They report without failing so the backlog stays visible
 * without blocking the build; remove a slug once its cover is fixed. The
 * check fails if a listed cover is already clean, so this list cannot go
 * stale.
 *
 * This is a LINT backlog, not the rework list. Several covers that pass
 * every rule here were still judged bad on composition, and two covers
 * that were judged good (materializing-event-streams,
 * truth-maintenance-for-agent-memory) appear below because small labels
 * and a stray kicker line are defects independent of how well the cover
 * is composed. The skill's pattern rules are what govern composition.
 * @type {ReadonlySet<string>}
 */
const LINT_BACKLOG = new Set();

/**
 * @param {string} source
 * @returns {string}
 */
function extractFrontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---/.exec(source);
  return match ? match[1] : "";
}

/**
 * @param {string} frontmatter
 * @param {string} key
 * @returns {boolean}
 */
function hasTopLevelKey(frontmatter, key) {
  return new RegExp(`^${key}:`, "m").test(frontmatter);
}

/**
 * @param {string} frontmatter
 * @returns {boolean}
 */
function isDraft(frontmatter) {
  return /^draft:\s*true\s*$/m.test(frontmatter);
}

// A post directory is only actually routable if it has an index.mdx —
// mirrors Starlight's own leading-underscore-FILENAME exclusion (see
// _template/_index.mdx's header comment), so a future underscore-prefixed
// scratch directory is skipped here too instead of crashing on a missing
// index.mdx.
const postDirectories = readdirSync(blogDir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      existsSync(path.join(blogDir, entry.name, "index.mdx")),
  )
  .map((entry) => entry.name);

/** @type {string[]} */
const problems = [];
/** @type {string[]} */
const backlog = [];
let publishedCount = 0;

for (const dir of postDirectories) {
  const indexPath = path.join(blogDir, dir, "index.mdx");
  const frontmatter = extractFrontmatter(readFileSync(indexPath, "utf8"));
  if (isDraft(frontmatter)) continue;
  publishedCount += 1;

  /** @type {string[]} */
  const missingKeys = [];
  if (!hasTopLevelKey(frontmatter, "cover")) missingKeys.push("cover");
  if (!hasTopLevelKey(frontmatter, "social")) missingKeys.push("social");
  if (missingKeys.length > 0) {
    problems.push(`  - ${dir}/index.mdx: missing ${missingKeys.join(", ")}`);
    continue;
  }

  const violations = lintCover({
    slug: dir,
    coverPng: path.join(blogDir, dir, "cover.png"),
    generator: path.join(blogDir, dir, "generate-images.mjs"),
  });

  if (LINT_BACKLOG.has(dir)) {
    if (violations.length === 0) {
      problems.push(
        `  - ${dir}: cover now passes every rule — remove it from LINT_BACKLOG in this script`,
      );
    } else {
      backlog.push(`  - ${dir}: ${violations.join("; ")}`);
    }
    continue;
  }

  for (const violation of violations) {
    problems.push(`  - ${dir}: ${violation}`);
  }
}

if (backlog.length > 0) {
  process.stdout.write(
    [
      `[check-blog-images] ${backlog.length} cover(s) with known violations (not failing the build):`,
      ...backlog,
      "",
    ].join("\n"),
  );
}

if (problems.length > 0) {
  process.stderr.write(
    [
      "[check-blog-images] Cover art problems:",
      "See .claude/skills/blog-cover/SKILL.md for the rules and patterns:",
      ...problems,
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `[check-blog-images] ${publishedCount} published post(s) OK\n`,
  );
}
