#!/usr/bin/env node
// Bespoke cover/social images for the "Portable Stores" post — NOT a
// generic template. Two concentric-circle diagrams showing which layer is
// the PUBLIC TYPE SURFACE, not which layer runs first — Drizzle has always
// done the actual SQL work underneath in both versions; what changed in
// 0.38 is whether Drizzle's types leak into what a consumer's own
// type-checker has to resolve.
//
//   - 0.37: Drizzle is the outer, unavoidable layer — every Store<G>
//     carried Drizzle's types whether the caller ever touched them or not.
//   - 0.38: Store<G> is the outer, portable layer. Drizzle is still there
//     (the managed local factories use it internally — "declaration
//     isolation isn't installation isolation"), but it's now an inner,
//     dashed-outline detail you only see through the explicit
//     AdapterStore escape hatch.
//
// See ../graph-merge/generate-images.mjs for the sibling bespoke script
// this one follows the pattern of, and #blog-art
// (scripts/lib/blog-art.mjs) for the shared canvas/logo/background/title
// primitives.
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

const SLUG = "portable-stores";
const TITLE = "Portable Stores: Drizzle Becomes an Adapter, Not a Requirement";

const COLOR_BLUE = "#2563eb";
const COLOR_BLUE_DARK = "#1d4ed8";
const COLOR_AMBER = "#f59e0b";
const COLOR_AMBER_DARK = "#b45309";
const COLOR_TEXT_MUTED = "#64748b";

const CY = 320;
const OUTER_R = 120;
const RING_WIDTH = 18;
const LEFT_CX = 300;
const RIGHT_CX = 900;
const VERSION_LABEL_Y = CY - OUTER_R - 26;
const CAPTION_Y = CY + OUTER_R + 44;

/**
 * @returns {string}
 */
function renderBefore() {
  const outerRing = `<circle cx="${LEFT_CX}" cy="${CY}" r="${OUTER_R}" fill="none" stroke="${COLOR_AMBER}" stroke-width="${RING_WIDTH}" opacity="0.9"/>`;
  const innerCircle = `<circle cx="${LEFT_CX}" cy="${CY}" r="68" fill="${COLOR_BLUE}" stroke="${COLOR_BLUE_DARK}" stroke-width="2.5"/>
    <text x="${LEFT_CX}" y="${CY + 6}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="17" font-weight="700" fill="#ffffff">Store&lt;G&gt;</text>`;
  const outerLabel = `<text x="${LEFT_CX}" y="${VERSION_LABEL_Y}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="17" font-weight="700" fill="${COLOR_AMBER_DARK}">drizzle-orm</text>`;
  const caption = ["0.37 — every Store's types", "resolve through Drizzle"]
    .map(
      (line, index) =>
        `<text x="${LEFT_CX}" y="${CAPTION_Y + index * 24}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="600" fill="${COLOR_TEXT_MUTED}">${escapeXml(line)}</text>`,
    )
    .join("\n    ");

  return `${outerRing}\n    ${innerCircle}\n    ${outerLabel}\n    ${caption}`;
}

/**
 * @returns {string}
 */
function renderAfter() {
  const outerRing = `<circle cx="${RIGHT_CX}" cy="${CY}" r="${OUTER_R}" fill="none" stroke="${COLOR_BLUE}" stroke-width="${RING_WIDTH}" opacity="0.9"/>`;
  const innerCircle = `<circle cx="${RIGHT_CX}" cy="${CY}" r="44" fill="#fff7ed" stroke="${COLOR_AMBER}" stroke-width="2.5" stroke-dasharray="6 5"/>
    <text x="${RIGHT_CX}" y="${CY + 5}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" font-weight="700" fill="${COLOR_AMBER_DARK}">drizzle</text>`;
  const outerLabel = `<text x="${RIGHT_CX}" y="${VERSION_LABEL_Y}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="17" font-weight="700" fill="${COLOR_BLUE_DARK}">Store&lt;G&gt;</text>`;
  const caption = [
    "0.38 — Drizzle is an internal detail,",
    "reachable only via AdapterStore",
  ]
    .map(
      (line, index) =>
        `<text x="${RIGHT_CX}" y="${CAPTION_Y + index * 24}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="600" fill="${COLOR_TEXT_MUTED}">${escapeXml(line)}</text>`,
    )
    .join("\n    ");

  return `${outerRing}\n    ${innerCircle}\n    ${outerLabel}\n    ${caption}`;
}

/**
 * @returns {string}
 */
function renderArrow() {
  const y = CY;
  const x1 = LEFT_CX + OUTER_R + 26;
  const x2 = RIGHT_CX - OUTER_R - 26;
  return `<line x1="${x1}" y1="${y}" x2="${x2 - 10}" y2="${y}" stroke="${COLOR_TEXT_MUTED}" stroke-width="3"/>
    <path d="M ${x2 - 18} ${y - 9} L ${x2} ${y} L ${x2 - 18} ${y + 9} Z" fill="${COLOR_TEXT_MUTED}"/>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  return `<g>
    ${renderBefore()}
    ${renderArrow()}
    ${renderAfter()}
  </g>`;
}

/**
 * The content cover: the two concentric-circle diagrams, no title text.
 * Shown on the page itself (blog index + post header).
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
    centerY: CONTENT_SAFE_TOP + 60,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(50, 190) scale(0.72)">
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
