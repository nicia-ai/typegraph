#!/usr/bin/env node
// PATTERN: <name one of the five in .claude/skills/blog-cover/SKILL.md>
//
// Starting point for a new post's cover/social images. Read the blog-cover
// skill before editing this file — in particular "The one rule this system
// exists to enforce" and "Step 0: choose a pattern by name".
//
// This file does NOT render a usable cover as-is, deliberately. It used to
// call the generic seeded-graph fallback, which produced an abstract node
// scatter that could not say anything about the post; that fallback is
// retired (see the skill) because it fails by construction. Replace the
// marked section below with a real diagram before shipping.
//
// The fastest correct route is to copy the reference generator for the
// pattern you picked and edit its data:
//
//   field with a lit path  ../graph-algorithms/generate-images.mjs
//   fan                    ../infinite-graph-databases/generate-images.mjs
//   converging streams     ../materializing-event-streams/generate-images.mjs
//   cascade + dead branch  ../truth-maintenance-for-agent-memory/generate-images.mjs
//   containment inversion  ../portable-stores/generate-images.mjs
//   measured comparison    ../_reference/chart-cover.mjs
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

import process from "node:process";

import {
  CANVAS_HEIGHT,
  CONTENT_SAFE_TOP,
  layoutTitle,
  MARGIN_X,
  parseOutDirArgument,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "my-post";
const TITLE = "Post title";

/**
 * The diagram itself, drawn once and reused by both images. Hand-lay-out
 * nodes and edges as plain objects with explicit coordinates; keep every
 * label at 15px or larger, and keep content below CONTENT_SAFE_TOP so it
 * clears the logo. `scripts/lib/cover-lint.mjs` enforces both.
 * @returns {string}
 */
function renderDiagram() {
  return `<text x="${MARGIN_X}" y="${CONTENT_SAFE_TOP + 120}" font-size="20" font-family="system-ui, -apple-system, sans-serif" fill="#dc2626">Replace renderDiagram() with this post's illustration.</text>`;
}

/**
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}
  ${renderLogoMark()}
  ${renderDiagram()}`);
}

/**
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 300);

  return svgDocument(`  ${renderIllustrationBackground()}
  ${renderLogoMark()}
  ${renderTitleLines(lines, fontSize, { x: MARGIN_X, centerY: CANVAS_HEIGHT / 2 })}
  <g transform="translate(420, 153) scale(0.66)">
    ${renderDiagram()}
  </g>`);
}

function main() {
  writeBlogImages({
    slug: SLUG,
    outDir: parseOutDirArgument(process.argv.slice(2)),
    coverSvg: generateCoverSvg(),
    socialSvg: generateSocialSvg(),
  });
}

main();
