#!/usr/bin/env node
// PATTERN: measured comparison (see .claude/skills/blog-cover/SKILL.md).
//
// Reference implementation for a post whose payload is measurements rather
// than a mechanism. Copy this into the post's folder as generate-images.mjs
// and replace ROWS with that post's real numbers.
//
// The point of the pattern is that the reader SEES the change: a bar that
// shrinks to a stub says "20x faster" before any numeral is read. The
// failure it replaces is the stat grid — a row of cards each containing
// "47µs -> 2.4µs" — which is a slide, not a picture, and which got both
// numeric covers rejected in the 2026-08 cover review.
//
// The numbers below are the real 0.35 release measurements, kept here so
// the reference renders something truthful rather than placeholder data.
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

const SLUG = "chart-cover-reference";
const TITLE = "TypeGraph 0.35: A Performance Release";

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
