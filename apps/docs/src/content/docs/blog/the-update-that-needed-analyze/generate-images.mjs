#!/usr/bin/env node
// PATTERN: measured comparison (see .claude/skills/blog-cover/SKILL.md).
//
// The UPDATE statement behind updateWhere(), run against rows PostgreSQL has
// not analyzed, in the previous release and now. Bars are scaled per row, so
// each pair shows the change at that size; the numbers are the benchmark's
// (300,000 analyzed rows of other graphs in the table).
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

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

const SLUG = "the-update-that-needed-analyze";
const TITLE = "The Bulk Update That Was Fast Until Nobody Ran ANALYZE";

const BEFORE_LABEL = "0.75";
const AFTER_LABEL = "0.76";

// Three rows maximum: a fourth pushes value labels into the footer band the
// cover lint rejects.
const ROWS = [
  {
    label: "1,000 rows updated",
    beforeValue: 0.26,
    beforeText: "0.26 s",
    afterValue: 0.05,
    afterText: "0.05 s",
  },
  {
    label: "5,000 rows updated",
    beforeValue: 19.6,
    beforeText: "19.6 s",
    afterValue: 0.29,
    afterText: "0.29 s",
  },
  {
    label: "10,000 rows updated",
    beforeValue: 92.5,
    beforeText: "92.5 s",
    afterValue: 0.55,
    afterText: "0.55 s",
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
