#!/usr/bin/env node
// PATTERN: measured comparison (see .claude/skills/blog-cover/SKILL.md).
//
// Cover/social images for the 0.35 performance release. Three of the six
// measured wins from the post, plotted so the reader SEES the change: a bar
// that shrinks to a stub says "20x faster" before any numeral is read.
//
// This replaces a six-card stat grid — each card holding "47µs -> 2.4µs" in
// type — that the 2026-08 cover review rejected as a slide rather than a
// picture. Each row is scaled to its own larger value, so the rows are not
// comparable to each other; they are separate measures, and one shared
// scale would bury 2.4µs under 174ms.
//
// Usage:
//   node chart-cover.mjs [--out-dir dir]

import process from "node:process";

import {
  CANVAS_HEIGHT,
  layoutTitle,
  MARGIN_X,
  parseOutDirArgument,
  renderBarComparison,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "typegraph-0-35-performance";
const TITLE = "TypeGraph 0.35: Faster Almost Everywhere";

const BEFORE_LABEL = "0.34";
const AFTER_LABEL = "0.35";

// Three rows maximum — a fourth pushes value labels into the footer band
// the cover lint rejects. Pick the three most legible wins, not all of them.
const ROWS = [
  {
    label: "Repeated point query",
    beforeValue: 47,
    beforeText: "47µs",
    afterValue: 2.4,
    afterText: "2.4µs",
  },
  {
    label: "Cascade delete (50 edges)",
    beforeValue: 24.4,
    beforeText: "24.4ms",
    afterValue: 3.6,
    afterText: "3.6ms",
  },
  {
    label: "Approximate vector search",
    beforeValue: 174,
    beforeText: "174ms",
    afterValue: 2.1,
    afterText: "2.1ms",
  },
];

/**
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}
  ${renderLogoMark()}
  ${renderBarComparison({
    rows: ROWS,
    beforeLabel: BEFORE_LABEL,
    afterLabel: AFTER_LABEL,
    top: 248,
  })}`);
}

/**
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 300);

  return svgDocument(`  ${renderIllustrationBackground()}
  ${renderLogoMark()}
  ${renderTitleLines(lines, fontSize, { x: MARGIN_X, centerY: CANVAS_HEIGHT / 2 })}
  <g transform="translate(430, 150) scale(0.62)">
    ${renderBarComparison({
      rows: ROWS,
      beforeLabel: BEFORE_LABEL,
      afterLabel: AFTER_LABEL,
      x: 0,
      top: 120,
      labelWidth: 300,
      barMaxWidth: 480,
    })}
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
