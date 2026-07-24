#!/usr/bin/env node
// Bespoke cover/social images for the "Trusted Initial Loads" post — NOT
// a generic template. Replaces an earlier bar-chart-per-run comparison
// (six numeric labels plus a kicker and footer line — exactly the
// caption-strip pattern the blog-cover skill now warns against) with a
// single abstract diagram: two lanes from the same source data to the
// same fresh database. importGraph's lane passes through four checkpoint
// gates (schema, reference, cardinality, uniqueness — the validation
// trustedImportGraphStream is allowed to skip because the caller already
// guarantees it); trustedImportGraphStream's lane runs straight through.
// The only numbers left are the post's own real, measured aggregate
// speedup (200k nodes + 200k edges, three runs, 2.5-3x faster every time —
// see index.mdx), not a re-derivation of the removed bar chart.
//
// See #blog-art (scripts/lib/blog-art.mjs) for the shared
// canvas/logo/background/title primitives.
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

const SLUG = "trusted-bulk-loads";
const TITLE = "Trusted Initial Loads: Skipping Validation You Already Did";

const COLOR_MUTED_FILL = "#e2e8f0";
const COLOR_MUTED_STROKE = "#94a3b8";
const COLOR_BLUE = "#2563eb";
const COLOR_BLUE_DARK = "#1d4ed8";
const COLOR_TEXT_MUTED = "#64748b";

const SOURCE_X = 150;
const TARGET_X = 1050;
const LANE_CY = 360;
const LANE_TOP_Y = 250;
const LANE_BOTTOM_Y = 470;
const LANE_X_START = 250;
const LANE_X_END = 950;
const GATE_XS = [370, 530, 690, 850];

/**
 * A small fanned stack of cards — the source data, common to both lanes.
 * @returns {string}
 */
function renderSourceIcon() {
  const cardStyle = `fill="#ffffff" stroke="${COLOR_MUTED_STROKE}" stroke-width="2.5"`;
  return `<g>
    <rect x="${SOURCE_X - 22}" y="${LANE_CY - 8}" width="52" height="36" rx="7" ${cardStyle}/>
    <rect x="${SOURCE_X - 14}" y="${LANE_CY - 18}" width="52" height="36" rx="7" ${cardStyle}/>
    <rect x="${SOURCE_X - 6}" y="${LANE_CY - 28}" width="52" height="36" rx="7" fill="#ffffff" stroke="${COLOR_TEXT_MUTED}" stroke-width="2.5"/>
  </g>`;
}

/**
 * A simple cylinder — the fresh, dedicated database both lanes write into.
 * @returns {string}
 */
function renderTargetIcon() {
  const rx = 58;
  const ry = 16;
  const top = LANE_CY - 46;
  const bottom = LANE_CY + 46;
  return `<g>
    <ellipse cx="${TARGET_X}" cy="${bottom}" rx="${rx}" ry="${ry}" fill="${COLOR_BLUE_DARK}"/>
    <rect x="${TARGET_X - rx}" y="${top}" width="${rx * 2}" height="${bottom - top}" fill="${COLOR_BLUE}"/>
    <line x1="${TARGET_X - rx}" y1="${top}" x2="${TARGET_X - rx}" y2="${bottom}" stroke="${COLOR_BLUE_DARK}" stroke-width="2.5"/>
    <line x1="${TARGET_X + rx}" y1="${top}" x2="${TARGET_X + rx}" y2="${bottom}" stroke="${COLOR_BLUE_DARK}" stroke-width="2.5"/>
    <ellipse cx="${TARGET_X}" cy="${top}" rx="${rx}" ry="${ry}" fill="${COLOR_BLUE}" stroke="${COLOR_BLUE_DARK}" stroke-width="2.5"/>
  </g>`;
}

/**
 * A checkpoint gate on the validated lane: a small hexagon badge with a
 * checkmark, sitting on top of the lane line. Deliberately unlabeled —
 * four identical gates read as "checks happen here" without spelling out
 * which check is which.
 * @param {number} x
 * @returns {string}
 */
function renderGate(x) {
  const r = 15;
  const points = Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index - Math.PI / 2;
    return `${x + r * Math.cos(angle)},${LANE_TOP_Y + r * Math.sin(angle)}`;
  }).join(" ");
  return `<g>
    <polygon points="${points}" fill="${COLOR_MUTED_FILL}" stroke="${COLOR_MUTED_STROKE}" stroke-width="2.5"/>
    <path d="M ${x - 6} ${LANE_TOP_Y} L ${x - 2} ${LANE_TOP_Y + 5} L ${x + 7} ${LANE_TOP_Y - 6}" fill="none" stroke="${COLOR_TEXT_MUTED}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`;
}

/**
 * @param {{ x1: number; y1: number; x2: number; y2: number; color: string }} options
 * @returns {string}
 */
function renderForkLine({ x1, y1, x2, y2, color }) {
  return `<path d="M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2.5"/>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const forkOutX = SOURCE_X + 60;
  const forkInX = TARGET_X - 74;

  const forkOutTop = renderForkLine({
    x1: forkOutX,
    y1: LANE_CY,
    x2: LANE_X_START,
    y2: LANE_TOP_Y,
    color: COLOR_MUTED_STROKE,
  });
  const forkOutBottom = renderForkLine({
    x1: forkOutX,
    y1: LANE_CY,
    x2: LANE_X_START,
    y2: LANE_BOTTOM_Y,
    color: COLOR_BLUE,
  });
  const forkInTop = renderForkLine({
    x1: LANE_X_END,
    y1: LANE_TOP_Y,
    x2: forkInX,
    y2: LANE_CY,
    color: COLOR_MUTED_STROKE,
  });
  const forkInBottom = renderForkLine({
    x1: LANE_X_END,
    y1: LANE_BOTTOM_Y,
    x2: forkInX,
    y2: LANE_CY,
    color: COLOR_BLUE,
  });

  const laneTop = `<line x1="${LANE_X_START}" y1="${LANE_TOP_Y}" x2="${LANE_X_END}" y2="${LANE_TOP_Y}" stroke="${COLOR_MUTED_STROKE}" stroke-width="3" stroke-dasharray="2 8" stroke-linecap="round"/>`;
  const laneBottom = `<line x1="${LANE_X_START}" y1="${LANE_BOTTOM_Y}" x2="${LANE_X_END}" y2="${LANE_BOTTOM_Y}" stroke="${COLOR_BLUE}" stroke-width="5" stroke-linecap="round"/>`;

  const gates = GATE_XS.map((x) => renderGate(x)).join("\n    ");

  const topLabel = `<text x="${LANE_X_START}" y="${LANE_TOP_Y - 30}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="700" fill="${COLOR_TEXT_MUTED}">importGraph</text>`;
  const bottomLabel = `<text x="${LANE_X_START}" y="${LANE_BOTTOM_Y - 30}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="700" fill="${COLOR_BLUE_DARK}">trustedImportGraphStream</text>`;
  const speedupTag = `<text x="${LANE_X_END}" y="${LANE_BOTTOM_Y + 34}" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="17" font-weight="600" fill="${COLOR_BLUE_DARK}">2.5&#8211;3&#215; faster, every run</text>`;

  return `<g>
    ${renderSourceIcon()}
    ${forkOutTop}
    ${forkOutBottom}
    ${laneTop}
    ${laneBottom}
    ${gates}
    ${forkInTop}
    ${forkInBottom}
    ${renderTargetIcon()}
    ${topLabel}
    ${bottomLabel}
    ${speedupTag}
  </g>`;
}

/**
 * The content cover: the two-lane diagram, no title text. Shown on the
 * page itself (blog index + post header).
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/**
 * The social/OG card: title on top, diagram scaled down and centered
 * below it. Only used for og:image / twitter:image — never rendered on
 * the page.
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 1000);
  const titleMarkup = renderTitleLines(lines, fontSize, {
    x: 90,
    centerY: CONTENT_SAFE_TOP + 70,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(70, 235) scale(0.62)">
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
