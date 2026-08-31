#!/usr/bin/env node
// PATTERN: field with a lit path (see .claude/skills/blog-cover/SKILL.md).
//
// Cover/social images for "Rows That Exist at No Point in Time". The post's
// subject is a coordinate that does not exist: `asOf(t)` needs
// `valid_from <= t < valid_to`, so a row whose bounds run backwards is
// readable at no `t` at all.
//
// The field is a set of validity windows on one time axis; the lit subject
// is the `asOf(t)` scan line moving across them, marking every window it
// falls inside. One row runs backwards — its arrow travels right to left
// down the time axis — and it takes no mark, because no position of the
// scan line can give it one. That is the whole bug, drawn.
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

const SLUG = "validity-window-repair";
const TITLE = "Rows That Exist at No Point in Time";

const COLOR_WINDOW = "#9db8dd";
const COLOR_WINDOW_LIVE = "#1d4ed8";
const COLOR_SCAN = "#1d4ed8";
const COLOR_SCAN_GLOW = "#93c5fd";
const COLOR_BROKEN = "#dc2626";
const COLOR_AXIS = "#cbd5e1";
const COLOR_TEXT = "#0f172a";
const COLOR_MUTED_TEXT = "#64748b";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const SCAN_X = 620;
const AXIS_Y = 512;
const AXIS_LEFT = 150;
const AXIS_RIGHT = 1075;
const BAR_HEIGHT = 22;

// Validity windows on the shared time axis. The fourth row is the defect:
// its bounds are the wrong way round, so it contains no coordinate.
const WINDOWS = [
  { y: 232, from: 260, to: 780 },
  { y: 288, from: 420, to: 915 },
  { y: 344, from: 180, to: 528 },
  { y: 400, from: 880, to: 645, inverted: true },
  { y: 456, from: 540, to: 1010 },
];

/**
 * @param {{ y: number; from: number; to: number; inverted?: boolean }} window
 * @returns {string}
 */
function renderWindow({ y, from, to, inverted }) {
  if (inverted) {
    // Drawn as the bounds actually sit: valid_from on the right, valid_to on
    // the left, so the window's own arrow runs backwards down the axis.
    return `<line x1="${from}" y1="${y + BAR_HEIGHT / 2}" x2="${to + 16}" y2="${y + BAR_HEIGHT / 2}" stroke="${COLOR_BROKEN}" stroke-width="3" stroke-dasharray="7 6"/>
    <polygon points="${to},${y + BAR_HEIGHT / 2} ${to + 16},${y + 1} ${to + 16},${y + BAR_HEIGHT - 1}" fill="${COLOR_BROKEN}"/>
    <circle cx="${from}" cy="${y + BAR_HEIGHT / 2}" r="6" fill="${COLOR_BROKEN}"/>
    <text x="${to - 14}" y="${y + BAR_HEIGHT - 4}" text-anchor="end" font-family="${MONO}" font-size="16" font-weight="600" fill="${COLOR_BROKEN}">valid_to</text>
    <text x="${from + 14}" y="${y + BAR_HEIGHT - 4}" font-family="${MONO}" font-size="16" font-weight="600" fill="${COLOR_BROKEN}">valid_from</text>`;
  }

  const live = SCAN_X > from && SCAN_X < to;
  const color = live ? COLOR_WINDOW_LIVE : COLOR_WINDOW;
  const mark =
    live ?
      `<circle cx="${SCAN_X}" cy="${y + BAR_HEIGHT / 2}" r="9" fill="#ffffff" stroke="${COLOR_SCAN}" stroke-width="3.5"/>`
    : "";

  return `<rect x="${from}" y="${y}" width="${to - from}" height="${BAR_HEIGHT}" rx="11" fill="${color}"/>
    ${mark}`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const axis = `<line x1="${AXIS_LEFT}" y1="${AXIS_Y}" x2="${AXIS_RIGHT}" y2="${AXIS_Y}" stroke="${COLOR_AXIS}" stroke-width="2.5"/>
    <text x="${AXIS_RIGHT}" y="${AXIS_Y + 28}" text-anchor="end" font-family="${MONO}" font-size="16" fill="${COLOR_MUTED_TEXT}">valid time</text>`;

  const scan = `<line x1="${SCAN_X}" y1="205" x2="${SCAN_X}" y2="${AXIS_Y + 10}" stroke="${COLOR_SCAN_GLOW}" stroke-width="12" opacity="0.55"/>
    <line x1="${SCAN_X}" y1="205" x2="${SCAN_X}" y2="${AXIS_Y + 10}" stroke="${COLOR_SCAN}" stroke-width="3"/>
    <text x="${SCAN_X}" y="196" text-anchor="middle" font-family="${MONO}" font-size="19" font-weight="700" fill="${COLOR_SCAN}">asOf(t)</text>`;

  const windows = WINDOWS.map((window) => renderWindow(window)).join("\n    ");

  const broken = WINDOWS.find((window) => window.inverted);
  const callout = `<text x="${AXIS_LEFT}" y="${broken.y + BAR_HEIGHT - 4}" font-family="${SANS}" font-size="17" font-weight="700" fill="${COLOR_BROKEN}">readable at no t</text>`;

  const note = `<text x="${AXIS_LEFT}" y="${AXIS_Y + 34}" font-family="${MONO}" font-size="17" fill="${COLOR_TEXT}">valid_from &lt;= t &lt; valid_to</text>`;

  return `${axis}\n    ${scan}\n    ${windows}\n    ${callout}\n    ${note}`;
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
  <g transform="translate(370, 130) scale(0.54)">
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
