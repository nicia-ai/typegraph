#!/usr/bin/env node
// Bespoke cover/social images for the "Type Safety, Tightened" post — NOT
// a generic template. Three small, unrelated fixes, so rather than three
// dense before/after code cards (the previous version — too much small
// text to read at a glance), each gets one purposeful icon plus a single
// short label: a brand tag surviving an arrow (branded ids surviving
// .select()), a circle-and-square pairing rejected with a red X
// (implies() endpoint validation), and an error card holding structured
// field chips instead of a bare "?" (typed error details).
//
// See #blog-art (scripts/lib/blog-art.mjs) for the shared
// canvas/logo/background/title primitives.
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

import process from "node:process";

import {
  CONTENT_SAFE_TOP,
  escapeXml,
  layoutTitle,
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

const COLOR_BLUE = "#2563eb";
const COLOR_BLUE_DARK = "#1e40af";
const COLOR_AMBER = "#f59e0b";
const COLOR_RED = "#dc2626";
const COLOR_TEXT_DARK = "#0f172a";
const COLOR_TEXT_MUTED = "#64748b";

const ICON_CY = 310;
const LABEL_Y = 435;
const COL_CENTERS = [260, 600, 940];

/**
 * Two id "chips" joined by an arrow, both carrying the same brand dot —
 * the id keeps its NodeId<N> brand across the arrow instead of losing it.
 * @param {number} cx
 * @param {number} cy
 * @returns {string}
 */
function renderBrandIcon(cx, cy) {
  const chipW = 100;
  const chipH = 68;
  const chipAX = cx - 130 - chipW / 2;
  const chipBX = cx + 80 - chipW / 2;
  const chipY = cy - chipH / 2;

  /**
   * @param {number} x
   * @returns {string}
   */
  const chip = (
    x,
  ) => `<rect x="${x}" y="${chipY}" width="${chipW}" height="${chipH}" rx="12" fill="#ffffff" stroke="${COLOR_BLUE}" stroke-width="3"/>
    <text x="${x + chipW / 2}" y="${cy + 7}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="21" font-weight="700" fill="${COLOR_BLUE}">id</text>
    <circle cx="${x + chipW - 10}" cy="${chipY + 10}" r="8" fill="${COLOR_AMBER}" stroke="#ffffff" stroke-width="2.5"/>`;

  const arrowY = cy;
  const arrowX1 = chipAX + chipW + 10;
  const arrowX2 = chipBX - 10;
  const arrow = `<line x1="${arrowX1}" y1="${arrowY}" x2="${arrowX2 - 9}" y2="${arrowY}" stroke="${COLOR_TEXT_MUTED}" stroke-width="3"/>
    <path d="M ${arrowX2 - 16} ${arrowY - 8} L ${arrowX2} ${arrowY} L ${arrowX2 - 16} ${arrowY + 8} Z" fill="${COLOR_TEXT_MUTED}"/>`;

  return `${chip(chipAX)}\n    ${arrow}\n    ${chip(chipBX)}`;
}

/**
 * A circle and a square (two incompatible node kinds) with their
 * connecting edge crossed out — implies() now rejects this pairing
 * instead of silently accepting it.
 * @param {number} cx
 * @param {number} cy
 * @returns {string}
 */
function renderMismatchIcon(cx, cy) {
  const r = 38;
  const sq = 74;
  const leftX = cx - 100;
  const rightX = cx + 100;
  const lineStartX = leftX + r + 6;
  const lineEndX = rightX - sq / 2 - 6;

  const circle = `<circle cx="${leftX}" cy="${cy}" r="${r}" fill="#ffffff" stroke="${COLOR_BLUE}" stroke-width="3.5"/>`;
  const square = `<rect x="${rightX - sq / 2}" y="${cy - sq / 2}" width="${sq}" height="${sq}" rx="14" fill="#ffffff" stroke="${COLOR_BLUE_DARK}" stroke-width="3.5"/>`;
  const line = `<line x1="${lineStartX}" y1="${cy}" x2="${lineEndX}" y2="${cy}" stroke="${COLOR_RED}" stroke-width="3" stroke-dasharray="8 6" opacity="0.85"/>`;
  const xSize = 15;
  const rejectX = `<g stroke="${COLOR_RED}" stroke-width="5" stroke-linecap="round">
    <line x1="${cx - xSize}" y1="${cy - xSize}" x2="${cx + xSize}" y2="${cy + xSize}"/>
    <line x1="${cx - xSize}" y1="${cy + xSize}" x2="${cx + xSize}" y2="${cy - xSize}"/>
  </g>`;

  return `${line}\n    ${circle}\n    ${square}\n    ${rejectX}`;
}

/**
 * An error card holding two structured field chips instead of a bare
 * unknown-shaped blob — every fixed-shape TypeGraphError subclass now
 * exports its own typed `details`.
 * @param {number} cx
 * @param {number} cy
 * @returns {string}
 */
function renderTypedErrorIcon(cx, cy) {
  const cardW = 172;
  const cardH = 112;
  const cardX = cx - cardW / 2;
  const cardY = cy - cardH / 2;

  const card = `<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="14" fill="#ffffff" stroke="${COLOR_RED}" stroke-width="3"/>`;
  const badge = `<circle cx="${cardX + 20}" cy="${cardY}" r="17" fill="${COLOR_RED}" stroke="#ffffff" stroke-width="3"/>
    <text x="${cardX + 20}" y="${cardY + 7}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="800" fill="#ffffff">!</text>`;

  const fieldY1 = cardY + 40;
  const fieldY2 = cardY + 72;
  const fieldX = cardX + 22;
  const field = (y, w) =>
    `<rect x="${fieldX}" y="${y}" width="${w}" height="18" rx="4" fill="${COLOR_BLUE}"/>`;

  return `${card}\n    ${field(fieldY1, cardW - 44)}\n    ${field(fieldY2, (cardW - 44) * 0.65)}\n    ${badge}`;
}

/**
 * @param {number} cx
 * @param {string[]} lines
 * @returns {string}
 */
function renderLabel(cx, lines) {
  return lines
    .map(
      (line, index) =>
        `<text x="${cx}" y="${LABEL_Y + index * 29}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700" fill="${COLOR_TEXT_DARK}">${escapeXml(line)}</text>`,
    )
    .join("\n    ");
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const brand = renderBrandIcon(COL_CENTERS[0], ICON_CY);
  const brandLabel = renderLabel(COL_CENTERS[0], [
    "Branded ids survive",
    "select() projections",
  ]);

  const mismatch = renderMismatchIcon(COL_CENTERS[1], ICON_CY);
  const mismatchLabel = renderLabel(COL_CENTERS[1], [
    "implies() checks",
    "its own endpoints",
  ]);

  const typedError = renderTypedErrorIcon(COL_CENTERS[2], ICON_CY);
  const typedErrorLabel = renderLabel(COL_CENTERS[2], [
    "Every error carries",
    "typed details",
  ]);

  return `<g>
    ${brand}
    ${brandLabel}
    ${mismatch}
    ${mismatchLabel}
    ${typedError}
    ${typedErrorLabel}
  </g>`;
}

/**
 * The content cover: three icons, no title text. Shown on the page itself
 * (blog index + post header).
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/**
 * The social/OG card: title on top, icons scaled down and centered below
 * it. Only used for og:image / twitter:image — never rendered on the
 * page.
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 1000);
  const titleMarkup = renderTitleLines(lines, fontSize, {
    x: 90,
    centerY: CONTENT_SAFE_TOP + 60,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(90, 184) scale(0.85)">
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
