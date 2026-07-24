// Fails if a published (non-draft) blog post is missing `cover` or `social`
// frontmatter. Wired into pretypecheck/prebuild so a post can't ship
// without generated cover art.
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

const here = path.dirname(fileURLToPath(import.meta.url));
const blogDir = path.resolve(here, "../src/content/docs/blog");

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

for (const dir of postDirectories) {
  const indexPath = path.join(blogDir, dir, "index.mdx");
  const frontmatter = extractFrontmatter(readFileSync(indexPath, "utf8"));
  if (isDraft(frontmatter)) continue;

  /** @type {string[]} */
  const missingKeys = [];
  if (!hasTopLevelKey(frontmatter, "cover")) missingKeys.push("cover");
  if (!hasTopLevelKey(frontmatter, "social")) missingKeys.push("social");
  if (missingKeys.length > 0) {
    problems.push(`  - ${dir}/index.mdx: missing ${missingKeys.join(", ")}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(
    [
      "[check-blog-images] Published posts must have cover + social images.",
      "See src/content/docs/blog/_template/ to generate them:",
      ...problems,
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `[check-blog-images] ${postDirectories.length} post(s) OK\n`,
  );
}
