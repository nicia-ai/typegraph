#!/usr/bin/env node
// PATTERN: fan, run in reverse — many collapsing into one
// (see .claude/skills/blog-cover/SKILL.md).
//
// Cover/social images for "One Statement Instead of Fifty". The N+1 read is
// the whole title, so the picture is the count: fifty faint query lines
// fanning from one caller out to fifty rows, with the single bulk statement
// drawn over them as one thick line to a bracket spanning the same rows.
//
// The fifty are drawn, not asserted. A caption reading "50 -> 1" is the stat
// grid this design system exists to avoid; a fan of fifty lines against one
// says the same thing before any label is read.
//
// Deliberately not the round-trip ladder used by serverless-write-fusion:
// that post is about exchanges over time on a wire, this one is about the
// breadth of a single read.
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

import process from "node:process";

import {
  CANVAS_HEIGHT,
  layoutTitle,
  MARGIN_X,
  parseOutDirArgument,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "bulk-reads-and-schema-fencing";
const TITLE =
  "One Statement Instead of Fifty, and a Schema That Survives Two Writers";

const COLOR_FAN = "#a9bdd6";
const COLOR_ROW = "#cbd5e1";
const COLOR_ROW_STROKE = "#a9bdd6";
const COLOR_BULK = "#1d4ed8";
const COLOR_BULK_GLOW = "#93c5fd";
const COLOR_TEXT = "#0f172a";
const COLOR_MUTED_TEXT = "#64748b";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const CALLER_X = 210;
const CALLER_Y = 380;
const ROW_X = 880;
const ROW_TOP = 210;
const ROW_COUNT = 50;
const ROW_SPACING = 6.6;

const rowY = (index) => ROW_TOP + index * ROW_SPACING;

/**
 * @returns {string}
 */
function renderDiagram() {
  const fan = Array.from({ length: ROW_COUNT }, (unused, index) => {
    const y = rowY(index);
    const midX = (CALLER_X + ROW_X) / 2;
    return `<path d="M ${CALLER_X + 14} ${CALLER_Y} C ${midX} ${CALLER_Y}, ${midX} ${y}, ${ROW_X - 12} ${y}" fill="none" stroke="${COLOR_FAN}" stroke-width="1" opacity="0.6"/>`;
  }).join("\n    ");

  const rows = Array.from({ length: ROW_COUNT }, (unused, index) => {
    const y = rowY(index);
    return `<rect x="${ROW_X}" y="${y - 1.6}" width="66" height="3.2" rx="1.6" fill="${COLOR_ROW}" stroke="${COLOR_ROW_STROKE}" stroke-width="0.6"/>`;
  }).join("\n    ");

  const bracketTop = rowY(0) - 10;
  const bracketBottom = rowY(ROW_COUNT - 1) + 10;
  const bracketX = ROW_X + 82;
  const bracket = `<path d="M ${bracketX} ${bracketTop} L ${bracketX + 12} ${bracketTop} L ${bracketX + 12} ${bracketBottom} L ${bracketX} ${bracketBottom}" fill="none" stroke="${COLOR_BULK}" stroke-width="3"/>`;

  const midY = (bracketTop + bracketBottom) / 2;
  const bulk = `<path d="M ${CALLER_X + 14} ${CALLER_Y} C 520 ${CALLER_Y}, 620 ${midY}, ${bracketX + 12} ${midY}" fill="none" stroke="${COLOR_BULK_GLOW}" stroke-width="14" opacity="0.55"/>
    <path d="M ${CALLER_X + 14} ${CALLER_Y} C 520 ${CALLER_Y}, 620 ${midY}, ${bracketX + 12} ${midY}" fill="none" stroke="${COLOR_BULK}" stroke-width="5"/>`;

  const caller = `<circle cx="${CALLER_X}" cy="${CALLER_Y}" r="15" fill="${COLOR_BULK}"/>`;

  const labels = `<text x="${MARGIN_X}" y="${CALLER_Y - 34}" font-family="${MONO}" font-size="17" fill="${COLOR_MUTED_TEXT}">50 queries</text>
    <text x="${MARGIN_X}" y="${CALLER_Y + 46}" font-family="${MONO}" font-size="18" font-weight="700" fill="${COLOR_BULK}">1 statement</text>
    <text x="${bracketX + 26}" y="${midY + 6}" font-family="${SANS}" font-size="18" font-weight="700" fill="${COLOR_TEXT}">the whole set</text>`;

  return `${fan}\n    ${rows}\n    ${bracket}\n    ${bulk}\n    ${caller}\n    ${labels}`;
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
  <g transform="translate(330, 120) scale(0.56)">
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
