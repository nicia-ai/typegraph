#!/usr/bin/env node
// PATTERN: streams converging on a record (see .claude/skills/blog-cover/SKILL.md).
//
// Cover/social images for "Graph Merge". Two independent feeds — an EHR
// branch and a claims branch — are folded back together, and the post's
// example resolves two patient pairs by two different mechanisms: one pair
// merges on similarity, one pair stays separate despite sharing a birth
// date block.
//
// The previous cover drew that as four boxes joined by short curves. It was
// a faithful diagram of the mechanism and the 2026-08 review still rejected
// it as static and empty: convergence with no travel is not convergence.
// Here each feed is a long run of records crossing most of the canvas, so
// the fold has distance to happen over, and the pair that refuses to merge
// peels off the bundle rather than sitting beside it.
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

const SLUG = "graph-merge";
const TITLE = "Graph Merge: Same Patient, Two Feeds, One Canonical Record";

const COLOR_STREAM_A = "#7dabe8";
const COLOR_STREAM_B = "#5b7fb5";
const COLOR_RECORD = "#cbd5e1";
const COLOR_MERGED = "#1d4ed8";
const COLOR_MERGED_GLOW = "#93c5fd";
const COLOR_DEAD = "#dc2626";
const COLOR_TEXT = "#0f172a";
const COLOR_MUTED_TEXT = "#64748b";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const STREAM_LEFT = 130;
const FOLD_X = 700;
const EHR_Y = 250;
const CLAIMS_Y = 470;
const MERGED_X = 790;
const MERGED_Y = 300;
const SPLIT_Y = 418;

const RECORDS_PER_STREAM = 9;

/**
 * @param {{ y: number; color: string; seed: number }} stream
 * @returns {string}
 */
function renderStream({ y, color, seed }) {
  const span = FOLD_X - STREAM_LEFT - 40;
  const dots = Array.from({ length: RECORDS_PER_STREAM }, (unused, index) => {
    const x = STREAM_LEFT + (index / (RECORDS_PER_STREAM - 1)) * span;
    const wobble = Math.sin(index * 1.7 + seed) * 11;
    return `<circle cx="${x.toFixed(1)}" cy="${(y + wobble).toFixed(1)}" r="7" fill="${COLOR_RECORD}" stroke="${color}" stroke-width="2.5"/>`;
  }).join("\n    ");

  return `<line x1="${STREAM_LEFT}" y1="${y}" x2="${FOLD_X - 40}" y2="${y}" stroke="${color}" stroke-width="2" opacity="0.4"/>
    ${dots}`;
}

/**
 * @param {{ x1: number; y1: number; x2: number; y2: number; color: string; width: number; dashed?: boolean }} curve
 * @returns {string}
 */
function renderFold({ x1, y1, x2, y2, color, width, dashed = false }) {
  const midX = (x1 + x2) / 2;
  const dash = dashed ? ' stroke-dasharray="7 6"' : "";
  return `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${width}"${dash} opacity="0.85"/>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const streams = `${renderStream({ y: EHR_Y, color: COLOR_STREAM_A, seed: 0.4 })}
    ${renderStream({ y: CLAIMS_Y, color: COLOR_STREAM_B, seed: 2.1 })}`;

  const streamLabels = `<text x="${STREAM_LEFT}" y="${EHR_Y - 34}" font-family="${SANS}" font-size="17" font-weight="700" fill="${COLOR_TEXT}">EHR BRANCH</text>
    <text x="${STREAM_LEFT}" y="${CLAIMS_Y + 46}" font-family="${SANS}" font-size="17" font-weight="700" fill="${COLOR_TEXT}">CLAIMS BRANCH</text>`;

  const folds = `${renderFold({ x1: FOLD_X - 40, y1: EHR_Y, x2: MERGED_X, y2: MERGED_Y + 22, color: COLOR_MERGED, width: 3.5 })}
    ${renderFold({ x1: FOLD_X - 40, y1: CLAIMS_Y, x2: MERGED_X, y2: MERGED_Y + 22, color: COLOR_MERGED, width: 3.5 })}
    ${renderFold({ x1: FOLD_X - 40, y1: EHR_Y + 14, x2: MERGED_X, y2: SPLIT_Y - 4, color: COLOR_DEAD, width: 2.5, dashed: true })}
    ${renderFold({ x1: FOLD_X - 40, y1: CLAIMS_Y - 14, x2: MERGED_X, y2: SPLIT_Y + 62, color: COLOR_DEAD, width: 2.5, dashed: true })}`;

  const merged = `<rect x="${MERGED_X - 6}" y="${MERGED_Y - 6}" width="272" height="68" rx="16" fill="${COLOR_MERGED_GLOW}" opacity="0.5"/>
    <rect x="${MERGED_X}" y="${MERGED_Y}" width="260" height="56" rx="10" fill="${COLOR_MERGED}"/>
    <text x="${MERGED_X + 130}" y="${MERGED_Y + 24}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="700" fill="#ffffff">Mohamed Ali</text>
    <text x="${MERGED_X + 130}" y="${MERGED_Y + 45}" text-anchor="middle" font-family="${MONO}" font-size="16" fill="#dbeafe">one canonical record</text>`;

  const split = `<rect x="${MERGED_X}" y="${SPLIT_Y - 28}" width="260" height="44" rx="10" fill="#ffffff" stroke="${COLOR_DEAD}" stroke-width="2" stroke-dasharray="6 5"/>
    <text x="${MERGED_X + 130}" y="${SPLIT_Y - 1}" text-anchor="middle" font-family="${SANS}" font-size="17" font-weight="600" fill="${COLOR_MUTED_TEXT}">Zoe Adams</text>
    <rect x="${MERGED_X}" y="${SPLIT_Y + 40}" width="260" height="44" rx="10" fill="#ffffff" stroke="${COLOR_DEAD}" stroke-width="2" stroke-dasharray="6 5"/>
    <text x="${MERGED_X + 130}" y="${SPLIT_Y + 67}" text-anchor="middle" font-family="${SANS}" font-size="17" font-weight="600" fill="${COLOR_MUTED_TEXT}">Quinn Webb</text>
    <text x="${MERGED_X + 130}" y="${SPLIT_Y + 112}" text-anchor="middle" font-family="${MONO}" font-size="16" font-weight="600" fill="${COLOR_DEAD}">similarity ~0 · stays split</text>`;

  return `${streams}\n    ${streamLabels}\n    ${folds}\n    ${merged}\n    ${split}`;
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
  <g transform="translate(350, 130) scale(0.55)">
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
