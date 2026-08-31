#!/usr/bin/env node
// PATTERN: cascade with a dead branch (see .claude/skills/blog-cover/SKILL.md),
// run as a gate rather than a tree.
//
// Cover/social images for "Type Safety, Tightened". The post ships three
// unrelated fixes, and the thread joining them is stated in its own last
// line: catch more mistakes at compile time, not runtime. So the picture is
// that boundary — a fence with a field of operations running at it. Almost
// everything was already stopped there; the three the post fixes used to
// pass straight through into runtime, and their old escape routes are drawn
// as fading dashed trails past the fence.
//
// This replaces a row of three unrelated glyphs with captions underneath —
// the icon-row failure — which the 2026-08 review scrapped, and which also
// shipped at 2400x1260 while every other cover is 1200x630.
//
// The three named escapes are the post's real ones: a branded id widening
// to string through select(), implies() accepting structurally incompatible
// endpoints, and error details typed as Record<string, unknown>.
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

import process from "node:process";

import {
  CANVAS_HEIGHT,
  escapeXml,
  layoutTitle,
  MARGIN_X,
  parseOutDirArgument,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "type-safety-sweep";
const TITLE =
  "Type Safety, Tightened: Branded IDs, Validated Relations, Typed Errors";

const COLOR_OP = "#cbd5e1";
const COLOR_OP_STROKE = "#a9bdd6";
const COLOR_FENCE = "#1d4ed8";
const COLOR_FENCE_GLOW = "#93c5fd";
const COLOR_ESCAPE = "#dc2626";
const COLOR_TEXT = "#0f172a";
const COLOR_MUTED_TEXT = "#64748b";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const FENCE_X = 690;
const FENCE_TOP = 228;
const FENCE_BOTTOM = 545;
const FIELD_LEFT = 130;

// The three mistakes that used to reach runtime, at the y they strike the
// fence. Spread across the fence's height so each caption has its own band.
const ESCAPES = [
  { y: 265, label: "NodeId<N> through select()" },
  { y: 375, label: "implies() endpoint check" },
  { y: 485, label: "typed error details" },
];

const CAUGHT_ROWS = [235, 300, 340, 410, 445, 515];

/**
 * Operations already stopped at the boundary: the quiet majority that makes
 * the three escapes legible as exceptions rather than as the whole picture.
 * @returns {string}
 */
function renderCaughtField() {
  return CAUGHT_ROWS.map((y, rowIndex) => {
    const count = 4 + (rowIndex % 3);
    return Array.from({ length: count }, (unused, index) => {
      const x = FIELD_LEFT + 40 + index * 118 + (rowIndex % 2) * 46;
      const r = 6 + ((rowIndex + index) % 3);
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${COLOR_OP}" stroke="${COLOR_OP_STROKE}" stroke-width="1.5"/>
    <line x1="${x + r}" y1="${y}" x2="${FENCE_X - 6}" y2="${y}" stroke="${COLOR_OP_STROKE}" stroke-width="1.5" opacity="0.5"/>`;
    }).join("\n    ");
  }).join("\n    ");
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const fence = `<rect x="${FENCE_X - 9}" y="${FENCE_TOP - 9}" width="18" height="${FENCE_BOTTOM - FENCE_TOP + 18}" rx="9" fill="${COLOR_FENCE_GLOW}" opacity="0.55"/>
    <rect x="${FENCE_X - 4}" y="${FENCE_TOP}" width="8" height="${FENCE_BOTTOM - FENCE_TOP}" rx="4" fill="${COLOR_FENCE}"/>
    <text x="${FENCE_X}" y="${FENCE_TOP - 24}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="700" fill="${COLOR_FENCE}">compile time</text>
    <text x="${FENCE_X + 250}" y="${FENCE_TOP - 24}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="700" fill="${COLOR_MUTED_TEXT}">runtime</text>`;

  const escapes = ESCAPES.map((escape) => {
    const trailEnd = FENCE_X + 300;
    return `<line x1="${FIELD_LEFT + 285}" y1="${escape.y}" x2="${FENCE_X - 6}" y2="${escape.y}" stroke="${COLOR_ESCAPE}" stroke-width="2.5"/>
    <line x1="${FENCE_X + 6}" y1="${escape.y}" x2="${trailEnd}" y2="${escape.y}" stroke="${COLOR_ESCAPE}" stroke-width="2" stroke-dasharray="6 7" opacity="0.32"/>
    <circle cx="${FENCE_X}" cy="${escape.y}" r="11" fill="#ffffff" stroke="${COLOR_ESCAPE}" stroke-width="3"/>
    <line x1="${FENCE_X - 5}" y1="${escape.y - 5}" x2="${FENCE_X + 5}" y2="${escape.y + 5}" stroke="${COLOR_ESCAPE}" stroke-width="2.5"/>
    <line x1="${FENCE_X + 5}" y1="${escape.y - 5}" x2="${FENCE_X - 5}" y2="${escape.y + 5}" stroke="${COLOR_ESCAPE}" stroke-width="2.5"/>
    <text x="${FIELD_LEFT}" y="${escape.y + 6}" font-family="${MONO}" font-size="17" font-weight="600" fill="${COLOR_TEXT}">${escapeXml(escape.label)}</text>`;
  }).join("\n    ");

  const note = `<text x="${FENCE_X + 30}" y="${FENCE_BOTTOM + 4}" font-family="${SANS}" font-size="17" font-weight="600" fill="${COLOR_MUTED_TEXT}">three routes that no longer reach it</text>`;

  return `${renderCaughtField()}\n    ${escapes}\n    ${fence}\n    ${note}`;
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
