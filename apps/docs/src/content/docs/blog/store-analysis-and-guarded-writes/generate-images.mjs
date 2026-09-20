#!/usr/bin/env node
// Bespoke cover/social images for the "Look Before You Write" post.
//
// Pattern: 1, field with lit elements (a variant of the graph-algorithms
// "field with a lit path"). Reason for the variant: this post's subject is
// not a route through a field but a sweep that lights the exceptions in one,
// followed by a guarded write that lets one repair through and refuses
// another. graph-algorithms draws a network with a lit route; this draws
// the records themselves as a grid so the two covers do not read alike.
//
// The field is the post's real data shape: 243 Account records in
// validateStore() page order, three scan pages of 100, 100 and 43 records
// (the counts under each band are the post's real `scannedCount` values).
// The last three records are the seeded legacy rows: the first two are the
// rows the tightened schema rejects (red rings), the third carries an
// undeclared `salesforceId` and is NOT reported (dashed ring). The two red
// rows are pulled to the right, where a compareAndSet guard closes around
// each: the first applies (check, `true`), the second finds the row already
// changed and is refused (struck out, `false`).
//
// Field test: there is a population for the sweep to act on. Label-deletion
// test: without any text, three swept bands of dots, two rings pulled out
// of the last band, one guarded repair landing and one refused.
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

import process from "node:process";

import {
  CONTENT_SAFE_TOP,
  layoutTitle,
  parseOutDirArgument,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "store-analysis-and-guarded-writes";
const TITLE = "Look Before You Write: Store Analysis and Guarded Writes";

const COLOR_DOT = "#cbd5e1";
const COLOR_DOT_STROKE = "#94a3b8";
const COLOR_BAND_FILL = "#dbeafe";
const COLOR_BAND_STROKE = "#93c5fd";
const COLOR_ACCENT = "#2563eb";
const COLOR_ACCENT_DARK = "#1d4ed8";
const COLOR_ACCENT_GLOW = "#93c5fd";
const COLOR_BAD = "#dc2626";
const COLOR_BAD_FILL = "#fee2e2";
const COLOR_TEXT_MUTED = "#64748b";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const ROWS_PER_COLUMN = 10;
const DOT_RADIUS = 6.5;
const COLUMN_PITCH = 24;
const ROW_PITCH = 31;
const FIELD_LEFT = 84;
const FIELD_TOP = 222;
const BAND_GAP = 18;
const BAND_PADDING = 14;

// validateStore() pages of 100, 100 and 43 records over 243 accounts.
const PAGES = [
  { records: 100, columns: 10 },
  { records: 100, columns: 10 },
  { records: 43, columns: 5 },
];

/**
 * @typedef {{ x: number; y: number }} Point
 * @typedef {{ x: number; y: number; width: number; height: number; records: number }} Band
 */

/**
 * Lays the records out column by column inside each page band, in the order
 * validateStore() scans them.
 * @returns {{ bands: Band[]; dots: Point[] }}
 */
function layoutField() {
  /** @type {Band[]} */
  const bands = [];
  /** @type {Point[]} */
  const dots = [];
  let cursorX = FIELD_LEFT;

  for (const page of PAGES) {
    const width = (page.columns - 1) * COLUMN_PITCH;
    bands.push({
      x: cursorX - BAND_PADDING,
      y: FIELD_TOP - BAND_PADDING,
      width: width + BAND_PADDING * 2,
      height: (ROWS_PER_COLUMN - 1) * ROW_PITCH + BAND_PADDING * 2,
      records: page.records,
    });
    for (let index = 0; index < page.records; index += 1) {
      dots.push({
        x: cursorX + Math.floor(index / ROWS_PER_COLUMN) * COLUMN_PITCH,
        y: FIELD_TOP + (index % ROWS_PER_COLUMN) * ROW_PITCH,
      });
    }
    cursorX += width + BAND_PADDING * 2 + BAND_GAP;
  }
  return { bands, dots };
}

const FIELD = layoutField();
const LEGACY_REJECTED_A = FIELD.dots[240];
const LEGACY_REJECTED_B = FIELD.dots[241];
const LEGACY_UNDECLARED = FIELD.dots[242];

// The pulled-out rows and their guards, to the right of the field with room
// for the pull lines to read.
const FIELD_RIGHT_EDGE = FIELD.bands.at(-1).x + FIELD.bands.at(-1).width;
const PULL_LINE_SPAN = 92;
const GUARD_LEFT = FIELD_RIGHT_EDGE + PULL_LINE_SPAN;
const GUARD_WIDTH = 128;
const GUARD_HEIGHT = 96;
const ROW_A_Y = 272;
const ROW_B_Y = 442;
const OUTCOME_X = GUARD_LEFT + GUARD_WIDTH + 130;
const OUTCOME_LABEL_DROP = 64;

/**
 * @returns {string}
 */
function renderBands() {
  return FIELD.bands
    .map((band) => {
      const label = `<text x="${band.x + band.width / 2}" y="${band.y + band.height + 26}" text-anchor="middle" font-family="${MONO}" font-size="18" font-weight="700" fill="${COLOR_TEXT_MUTED}">${band.records}</text>`;
      return `<rect x="${band.x}" y="${band.y}" width="${band.width}" height="${band.height}" rx="14" fill="${COLOR_BAND_FILL}" fill-opacity="0.55" stroke="${COLOR_BAND_STROKE}" stroke-width="1.5"/>
    ${label}`;
    })
    .join("\n    ");
}

/**
 * Every record except the three special rows.
 * @returns {string}
 */
function renderPlainDots() {
  const special = new Set([
    LEGACY_REJECTED_A,
    LEGACY_REJECTED_B,
    LEGACY_UNDECLARED,
  ]);
  return FIELD.dots
    .filter((dot) => !special.has(dot))
    .map(
      (dot) =>
        `<circle cx="${dot.x}" cy="${dot.y}" r="${DOT_RADIUS}" fill="${COLOR_DOT}" stroke="${COLOR_DOT_STROKE}" stroke-width="1.2"/>`,
    )
    .join("\n    ");
}

/**
 * @param {Point} dot
 * @returns {string}
 */
function renderRejectedDot(dot) {
  return `<circle cx="${dot.x}" cy="${dot.y}" r="${DOT_RADIUS + 6}" fill="${COLOR_BAD_FILL}" stroke="${COLOR_BAD}" stroke-width="2.5"/>
    <circle cx="${dot.x}" cy="${dot.y}" r="${DOT_RADIUS}" fill="${COLOR_BAD}"/>`;
}

/**
 * The row with an undeclared property: odd, but healthy, so it is ringed with
 * a dashed neutral line rather than flagged.
 * @returns {string}
 */
function renderUndeclaredDot() {
  const { x, y } = LEGACY_UNDECLARED;
  return `<circle cx="${x}" cy="${y}" r="${DOT_RADIUS + 6}" fill="none" stroke="${COLOR_DOT_STROKE}" stroke-width="2" stroke-dasharray="4 4"/>
    <circle cx="${x}" cy="${y}" r="${DOT_RADIUS}" fill="${COLOR_DOT}" stroke="${COLOR_DOT_STROKE}" stroke-width="1.2"/>`;
}

/**
 * A curve from a rejected dot in the field to the guard that closes around
 * its pulled-out copy.
 * @param {Point} from
 * @param {number} toY
 * @returns {string}
 */
function renderPullLine(from, toY) {
  const startX = from.x + DOT_RADIUS + 9;
  const endX = GUARD_LEFT;
  const midX = (startX + endX) / 2;
  return `<path d="M ${startX} ${from.y} C ${midX} ${from.y}, ${midX} ${toY}, ${endX} ${toY}" fill="none" stroke="${COLOR_BAD}" stroke-width="2.5" stroke-dasharray="1 6" stroke-linecap="round" opacity="0.85"/>`;
}

/**
 * The pulled-out row: a large red record inside the guard bracket.
 * @param {number} centerY
 * @param {string} guardStroke
 * @param {string} guardDash
 * @returns {string}
 */
function renderGuardedRow(centerY, guardStroke, guardDash) {
  const recordX = GUARD_LEFT + GUARD_WIDTH / 2;
  return `<rect x="${GUARD_LEFT}" y="${centerY - GUARD_HEIGHT / 2}" width="${GUARD_WIDTH}" height="${GUARD_HEIGHT}" rx="18" fill="#ffffff" fill-opacity="0.85" stroke="${guardStroke}" stroke-width="4"${guardDash}/>
    <circle cx="${recordX}" cy="${centerY}" r="26" fill="${COLOR_BAD_FILL}" stroke="${COLOR_BAD}" stroke-width="3.5"/>
    <circle cx="${recordX}" cy="${centerY}" r="10" fill="${COLOR_BAD}"/>`;
}

/**
 * The guard passes: an arrow through the bracket into a record that has
 * turned blue and carries a check.
 * @returns {string}
 */
function renderAppliedOutcome() {
  const startX = GUARD_LEFT + GUARD_WIDTH + 6;
  const endX = OUTCOME_X - 40;
  return `<path d="M ${startX} ${ROW_A_Y} L ${endX} ${ROW_A_Y}" fill="none" stroke="${COLOR_ACCENT}" stroke-width="5" stroke-linecap="round"/>
    <path d="M ${endX - 14} ${ROW_A_Y - 12} L ${endX} ${ROW_A_Y} L ${endX - 14} ${ROW_A_Y + 12}" fill="none" stroke="${COLOR_ACCENT}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${OUTCOME_X}" cy="${ROW_A_Y}" r="40" fill="${COLOR_ACCENT_GLOW}" opacity="0.45"/>
    <circle cx="${OUTCOME_X}" cy="${ROW_A_Y}" r="30" fill="${COLOR_ACCENT}" stroke="${COLOR_ACCENT_DARK}" stroke-width="3.5"/>
    <path d="M ${OUTCOME_X - 13} ${ROW_A_Y + 1} L ${OUTCOME_X - 3} ${ROW_A_Y + 11} L ${OUTCOME_X + 14} ${ROW_A_Y - 10}" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="${OUTCOME_X}" y="${ROW_A_Y + OUTCOME_LABEL_DROP}" text-anchor="middle" font-family="${MONO}" font-size="20" font-weight="700" fill="${COLOR_ACCENT_DARK}">true</text>`;
}

/**
 * The guard holds: a dashed arrow runs to the bracket's far side and ends in
 * a red X, and the row behind the bracket is unchanged.
 * @returns {string}
 */
function renderRefusedOutcome() {
  const startX = GUARD_LEFT + GUARD_WIDTH + 6;
  const endX = OUTCOME_X - 40;
  const arm = 17;
  return `<path d="M ${startX} ${ROW_B_Y} L ${endX} ${ROW_B_Y}" fill="none" stroke="${COLOR_BAD}" stroke-width="5" stroke-linecap="round" stroke-dasharray="11 9"/>
    <circle cx="${OUTCOME_X}" cy="${ROW_B_Y}" r="30" fill="${COLOR_BAD_FILL}" stroke="${COLOR_BAD}" stroke-width="3.5"/>
    <path d="M ${OUTCOME_X - arm} ${ROW_B_Y - arm} L ${OUTCOME_X + arm} ${ROW_B_Y + arm} M ${OUTCOME_X + arm} ${ROW_B_Y - arm} L ${OUTCOME_X - arm} ${ROW_B_Y + arm}" fill="none" stroke="${COLOR_BAD}" stroke-width="6" stroke-linecap="round"/>
    <text x="${OUTCOME_X}" y="${ROW_B_Y + OUTCOME_LABEL_DROP}" text-anchor="middle" font-family="${MONO}" font-size="20" font-weight="700" fill="${COLOR_BAD}">false</text>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  return `<g>
    ${renderBands()}
    ${renderPlainDots()}
    ${renderUndeclaredDot()}
    ${renderPullLine(LEGACY_REJECTED_A, ROW_A_Y)}
    ${renderPullLine(LEGACY_REJECTED_B, ROW_B_Y)}
    ${renderRejectedDot(LEGACY_REJECTED_A)}
    ${renderRejectedDot(LEGACY_REJECTED_B)}
    ${renderGuardedRow(ROW_A_Y, COLOR_ACCENT, "")}
    ${renderAppliedOutcome()}
    ${renderGuardedRow(ROW_B_Y, COLOR_BAD, ' stroke-dasharray="12 7"')}
    ${renderRefusedOutcome()}
  </g>`;
}

/**
 * The content cover: no title text, shown on the page itself.
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/**
 * The social/OG card: title on top, the diagram scaled below it. Only used
 * for og:image / twitter:image, never rendered on the page.
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 1000);
  const titleMarkup = renderTitleLines(lines, fontSize, {
    x: 90,
    centerY: CONTENT_SAFE_TOP + 60,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(70, 128) scale(0.86)">
    ${renderDiagram()}
  </g>

  ${renderLogoMark()}

  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif">
    ${titleMarkup}
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
