#!/usr/bin/env node
// Bespoke cover/social images for the "Bring Your Own Database" post (originally drawn for "Portable Stores") — NOT a
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
// The inversion is the whole picture, so it is drawn as hard as it can be:
// the blue core grows from a small disc to the outer ring while the amber
// ring collapses to a dot, and two arcs cross in the gap — amber running
// outside-to-centre, blue centre-to-outside. The explanatory captions that
// used to sit under each circle are gone; they said in words what the
// geometry already says, and they were the first thing to become
// illegible when the cover was scaled down.
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
  layoutTitle,
  parseOutDirArgument,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "bring-your-own-database";
const TITLE = "Bring Your Own Database";

const COLOR_BLUE = "#2563eb";
const COLOR_BLUE_DARK = "#1d4ed8";
const COLOR_AMBER = "#f59e0b";
const COLOR_AMBER_DARK = "#b45309";

const CY = 390;
const OUTER_R = 148;
const RING_WIDTH = 26;
const LEFT_CX = 300;
const RIGHT_CX = 900;
const LABEL_Y = CY - OUTER_R - 34;

// The inner disc sizes carry the inversion, so they are deliberately far
// apart: what is a small core on the left becomes the whole outer ring on
// the right, and what was the ring shrinks to this dot.
const BEFORE_CORE_R = 56;
const AFTER_CORE_R = 32;

/**
 * @returns {string}
 */
function renderBefore() {
  const outerRing = `<circle cx="${LEFT_CX}" cy="${CY}" r="${OUTER_R}" fill="none" stroke="${COLOR_AMBER}" stroke-width="${RING_WIDTH}" opacity="0.9"/>`;
  const innerCircle = `<circle cx="${LEFT_CX}" cy="${CY}" r="${BEFORE_CORE_R}" fill="${COLOR_BLUE}" stroke="${COLOR_BLUE_DARK}" stroke-width="2.5"/>
    <text x="${LEFT_CX}" y="${CY + 6}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="16" font-weight="700" fill="#ffffff">Store&lt;G&gt;</text>`;
  const outerLabel = `<text x="${LEFT_CX}" y="${LABEL_Y}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="19" font-weight="700" fill="${COLOR_AMBER_DARK}">0.37 · drizzle-orm</text>`;

  return `${outerRing}\n    ${innerCircle}\n    ${outerLabel}`;
}

/**
 * @returns {string}
 */
function renderAfter() {
  const outerRing = `<circle cx="${RIGHT_CX}" cy="${CY}" r="${OUTER_R}" fill="none" stroke="${COLOR_BLUE}" stroke-width="${RING_WIDTH}" opacity="0.9"/>`;
  const innerCircle = `<circle cx="${RIGHT_CX}" cy="${CY}" r="${AFTER_CORE_R}" fill="#fff7ed" stroke="${COLOR_AMBER}" stroke-width="2.5" stroke-dasharray="6 5"/>`;
  const innerLabel = `<text x="${RIGHT_CX}" y="${CY + AFTER_CORE_R + 26}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="16" font-weight="700" fill="${COLOR_AMBER_DARK}">drizzle</text>`;
  const outerLabel = `<text x="${RIGHT_CX}" y="${LABEL_Y}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="19" font-weight="700" fill="${COLOR_BLUE_DARK}">0.38 · Store&lt;G&gt;</text>`;

  return `${outerRing}\n    ${innerCircle}\n    ${innerLabel}\n    ${outerLabel}`;
}

/**
 * @returns {string}
 */
function renderSwap() {
  const x1 = LEFT_CX + OUTER_R + 14;
  const x2 = RIGHT_CX - OUTER_R - 14;
  const high = CY - 52;
  const low = CY + 52;

  // Amber runs outside-to-centre, blue centre-to-outside; they cross at the
  // midpoint, and that crossing is the inversion the post is about.
  const amber = `<path d="M ${x1} ${high} C ${x1 + 110} ${high - 14}, ${x2 - 110} ${low + 14}, ${x2 - 14} ${low}" fill="none" stroke="${COLOR_AMBER}" stroke-width="3.5" opacity="0.9"/>
    <path d="M ${x2 - 20} ${low - 10} L ${x2} ${low + 2} L ${x2 - 22} ${low + 10} Z" fill="${COLOR_AMBER}"/>`;
  const blue = `<path d="M ${x1} ${low} C ${x1 + 110} ${low + 14}, ${x2 - 110} ${high - 14}, ${x2 - 14} ${high}" fill="none" stroke="${COLOR_BLUE}" stroke-width="3.5" opacity="0.9"/>
    <path d="M ${x2 - 22} ${high - 10} L ${x2} ${high - 2} L ${x2 - 20} ${high + 10} Z" fill="${COLOR_BLUE}"/>`;

  return `${amber}\n    ${blue}`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  return `<g>
    ${renderBefore()}
    ${renderSwap()}
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
