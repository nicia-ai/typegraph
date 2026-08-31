#!/usr/bin/env node
// PATTERN: field with a lit path (see .claude/skills/blog-cover/SKILL.md).
//
// Cover/social images for "Bring Your Own Backend". An engine declares what
// it cannot do, and TypeGraph turns that declaration into one of two
// outcomes: a fallback that returns the same answer a slower way, or a typed
// refusal at construction.
//
// "The same answer a slower way" is a shape, so it is drawn as one: the
// fallback path leaves the gate, swings a long way out, and lands on the
// very same result node the direct paths reach. Length is the only
// difference between them, which is exactly the claim. The refused
// capability gets no path at all — it stops at a bar well short of the
// result, because that call never constructs.
//
// The two named capabilities are the post's own examples: no recursive CTEs
// (fallback) and no advisory locks (refusal).
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

const SLUG = "backend-capabilities";
const TITLE = "Bring Your Own Backend: Declaring What Your Engine Can't Do";

const COLOR_OP = "#cbd5e1";
const COLOR_OP_STROKE = "#a9bdd6";
const COLOR_DIRECT = "#1d4ed8";
const COLOR_FALLBACK = "#d97706";
const COLOR_REFUSED = "#dc2626";
const COLOR_GATE = "#94a3b8";
const COLOR_RESULT_GLOW = "#93c5fd";
const COLOR_TEXT = "#0f172a";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const GATE_X = 430;
const GATE_TOP = 218;
const GATE_BOTTOM = 532;
const RESULT_X = 975;
const RESULT_Y = 372;

// Operations arriving at the gate: the quiet majority that every engine can
// run directly.
const DIRECT_Y = [232, 274, 316, 400, 442];

/**
 * @returns {string}
 */
function renderDiagram() {
  const field = DIRECT_Y.flatMap((y, rowIndex) =>
    Array.from({ length: 3 }, (unused, index) => {
      const x = 150 + index * 62 + (rowIndex % 2) * 26;
      return `<circle cx="${x}" cy="${y}" r="${6 + (index % 2)}" fill="${COLOR_OP}" stroke="${COLOR_OP_STROKE}" stroke-width="1.5"/>
    <line x1="${x + 8}" y1="${y}" x2="${GATE_X - 6}" y2="${y}" stroke="${COLOR_OP_STROKE}" stroke-width="1.5" opacity="0.55"/>`;
    }),
  ).join("\n    ");

  const direct = DIRECT_Y.map(
    (y) =>
      `<path d="M ${GATE_X + 6} ${y} C ${GATE_X + 220} ${y}, ${RESULT_X - 220} ${RESULT_Y}, ${RESULT_X - 34} ${RESULT_Y}" fill="none" stroke="${COLOR_DIRECT}" stroke-width="2.5" opacity="0.85"/>`,
  ).join("\n    ");

  // The long way round: out to the top of the canvas and back down onto the
  // same result the direct paths land on.
  const fallback = `<path d="M ${GATE_X + 6} 370 C 520 190, 760 175, ${RESULT_X - 34} ${RESULT_Y - 12}" fill="none" stroke="${COLOR_FALLBACK}" stroke-width="4" stroke-dasharray="10 7"/>
    <polygon points="${RESULT_X - 20},${RESULT_Y - 10} ${RESULT_X - 38},${RESULT_Y - 22} ${RESULT_X - 38},${RESULT_Y - 2}" fill="${COLOR_FALLBACK}"/>
    <text x="775" y="212" text-anchor="middle" font-family="${MONO}" font-size="17" font-weight="700" fill="${COLOR_FALLBACK}">no recursive CTEs · slower path</text>`;

  const refusedStopX = 720;
  const refusedY = 508;
  const refused = `<line x1="${GATE_X + 6}" y1="${refusedY}" x2="${refusedStopX - 10}" y2="${refusedY}" stroke="${COLOR_REFUSED}" stroke-width="3.5"/>
    <rect x="${refusedStopX}" y="${refusedY - 24}" width="10" height="48" rx="5" fill="${COLOR_REFUSED}"/>
    <text x="${refusedStopX + 26}" y="${refusedY + 6}" font-family="${MONO}" font-size="17" font-weight="700" fill="${COLOR_REFUSED}">refused at construction</text>
    <text x="${GATE_X + 12}" y="${refusedY - 16}" font-family="${MONO}" font-size="16" fill="${COLOR_REFUSED}">no advisory locks</text>`;

  const gate = `<line x1="${GATE_X}" y1="${GATE_TOP}" x2="${GATE_X}" y2="${GATE_BOTTOM}" stroke="${COLOR_GATE}" stroke-width="3" stroke-dasharray="8 6"/>
    <text x="${GATE_X}" y="${GATE_TOP - 16}" text-anchor="middle" font-family="${SANS}" font-size="17" font-weight="700" fill="${COLOR_TEXT}">declared capabilities</text>`;

  const result = `<circle cx="${RESULT_X}" cy="${RESULT_Y}" r="46" fill="${COLOR_RESULT_GLOW}" opacity="0.5"/>
    <circle cx="${RESULT_X}" cy="${RESULT_Y}" r="30" fill="${COLOR_DIRECT}"/>
    <text x="${RESULT_X}" y="${RESULT_Y + 66}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="700" fill="${COLOR_TEXT}">the same answer</text>`;

  return `${field}\n    ${direct}\n    ${fallback}\n    ${refused}\n    ${gate}\n    ${result}`;
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
  <g transform="translate(360, 120) scale(0.54)">
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
