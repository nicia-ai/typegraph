#!/usr/bin/env node
// Bespoke cover/social images for the "Declared, Not Inferred" post — NOT a
// generic template.
//
// Pattern: 1 — field with a lit path (see the blog-cover skill). Chosen over
// the suggested containment inversion because portable-stores is already two
// big rings swapping places, and this post's subject is not a nesting
// relationship changing: it is a route through decision sites.
//
// The field is real. TypeGraph's own lint ban (DIALECT_SEAM_RESTRICTIONS in
// packages/typegraph/eslint.config.mjs — `x === "sqlite" | "postgres"` and
// `case "sqlite" | "postgres"`) was run as an ESLint rule over the library's
// src/ at two tags. Each column below is one file that contained such a
// branch; each fork mark is one site:
//
//   0.56.0 — 14 files, 38 sites: [7, 4, 4, 4, 3, 2, 2, 2, 2, 2, 2, 2, 1, 1]
//   0.57.0 —  7 files, 16 sites: [4, 3, 2, 2, 2, 2, 1]
//
// Every one of the 16 that remain is a named, permanent exemption
// (DIALECT_LITERAL_EXEMPTIONS) — provisioning, migration, the fence's one
// owner, dialect-specific error classification.
//
// The lit route is a third engine. In 0.56 it reaches a fork that only has
// two arms (sqlite, postgres) and dies there. In 0.57 it carries its own
// declaration, so it clears the exempt sites and arrives.
//
// Label-deletion test: with every label removed, the top field is a crowd of
// forks with a route ending in a red cross; the bottom field is a thin
// crowd the route arcs over and lands past. Field test: 38 and 16 real sites.
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

const SLUG = "backend-boundary";
const TITLE = "Declared, Not Inferred: What a Backend Has to Tell TypeGraph";

const COLOR_FORK = "#94a3b8";
const COLOR_ROUTE = "#2563eb";
const COLOR_ROUTE_DARK = "#1d4ed8";
const COLOR_ROUTE_GLOW = "#93c5fd";
const COLOR_DEAD = "#dc2626";
const COLOR_TEXT_DARK = "#0f172a";
const COLOR_TEXT_MUTED = "#64748b";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Sites per file that contained a dialect branch, largest first. */
const SITES_AT_0_56 = [7, 4, 4, 4, 3, 2, 2, 2, 2, 2, 2, 2, 1, 1];
const SITES_AT_0_57 = [4, 3, 2, 2, 2, 2, 1];

const COLUMN_X0 = 198;
const COLUMN_PITCH = 68;
const FORK_PITCH = 25;
const FORK_HALF_WIDTH = 8;
const FORK_STEM = 14;
const FORK_ARM = 9;

const NODE_X = 112;
const GOAL_X = 1092;
const TOP_BASELINE = 372;
const BOTTOM_BASELINE = 546;
const TOP_ROUTE_Y = 346;
const BOTTOM_ROUTE_Y = 430;
const BOTTOM_START_Y = 526;
const DEAD_COLUMN = 2;

/**
 * One fork mark: a stem splitting into two arms — a branch that knows exactly
 * two answers.
 * @param {number} x
 * @param {number} y
 * @param {string} color
 * @returns {string}
 */
function renderFork(x, y, color) {
  const split = y - FORK_STEM / 2;
  return `<path d="M ${x} ${y + FORK_STEM / 2} L ${x} ${split} M ${x} ${split} L ${x - FORK_HALF_WIDTH} ${split - FORK_ARM} M ${x} ${split} L ${x + FORK_HALF_WIDTH} ${split - FORK_ARM}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>`;
}

/**
 * @param {readonly number[]} sites
 * @param {number} baseline
 * @param {string} color
 * @returns {string}
 */
function renderColumns(sites, baseline, color) {
  return sites
    .map((count, column) => {
      const x = COLUMN_X0 + column * COLUMN_PITCH;
      return Array.from({ length: count }, (_, level) =>
        renderFork(x, baseline - 6 - level * FORK_PITCH, color),
      ).join("\n    ");
    })
    .join("\n    ");
}

/**
 * @param {number} x
 * @param {number} y
 * @param {string} fill
 * @param {string} stroke
 * @returns {string}
 */
function renderEngineNode(x, y, fill, stroke) {
  return `<circle cx="${x}" cy="${y}" r="15" fill="${fill}" stroke="${stroke}" stroke-width="3"/>`;
}

/**
 * The 0.56 field: the third engine's route runs into the forks and ends at
 * one that has no arm for it.
 * @returns {string}
 */
function renderBefore() {
  const deadX = COLUMN_X0 + DEAD_COLUMN * COLUMN_PITCH - 22;
  const crossSize = 9;
  const route = `M ${NODE_X + 15} ${TOP_ROUTE_Y} L ${deadX} ${TOP_ROUTE_Y}`;
  return `<g>
    ${renderColumns(SITES_AT_0_56, TOP_BASELINE, COLOR_FORK)}
    <path d="${route}" fill="none" stroke="${COLOR_ROUTE}" stroke-width="5" stroke-linecap="round"/>
    ${renderEngineNode(NODE_X, TOP_ROUTE_Y, COLOR_ROUTE, COLOR_ROUTE_DARK)}
    <path d="M ${deadX - crossSize} ${TOP_ROUTE_Y - crossSize} L ${deadX + crossSize} ${TOP_ROUTE_Y + crossSize} M ${deadX + crossSize} ${TOP_ROUTE_Y - crossSize} L ${deadX - crossSize} ${TOP_ROUTE_Y + crossSize}" stroke="${COLOR_DEAD}" stroke-width="4.5" stroke-linecap="round"/>
    <text x="1110" y="222" text-anchor="end" font-family="${MONO}" font-size="19" font-weight="700" fill="${COLOR_TEXT_MUTED}">0.56 · 38 dialect branches</text>
  </g>`;
}

/**
 * The 0.57 field: the same route carries its own declaration, arcs over the
 * seven named exemptions, and arrives.
 * @returns {string}
 */
function renderAfter() {
  const climbEnd = COLUMN_X0 - 22;
  const settle = COLUMN_X0 + SITES_AT_0_57.length * COLUMN_PITCH;
  const route = `M ${NODE_X + 15} ${BOTTOM_START_Y} C ${climbEnd - 20} ${BOTTOM_START_Y}, ${climbEnd - 30} ${BOTTOM_ROUTE_Y}, ${climbEnd} ${BOTTOM_ROUTE_Y} L ${settle} ${BOTTOM_ROUTE_Y} L ${GOAL_X - 15} ${BOTTOM_ROUTE_Y}`;
  return `<g>
    ${renderColumns(SITES_AT_0_57, BOTTOM_BASELINE, COLOR_FORK)}
    <path d="${route}" fill="none" stroke="${COLOR_ROUTE_GLOW}" stroke-width="16" stroke-linecap="round" opacity="0.55"/>
    <path d="${route}" fill="none" stroke="${COLOR_ROUTE}" stroke-width="5" stroke-linecap="round"/>
    ${renderEngineNode(NODE_X, BOTTOM_START_Y, COLOR_ROUTE, COLOR_ROUTE_DARK)}
    ${renderEngineNode(GOAL_X, BOTTOM_ROUTE_Y, "#ffffff", COLOR_ROUTE_DARK)}
    <circle cx="${GOAL_X}" cy="${BOTTOM_ROUTE_Y}" r="6" fill="${COLOR_ROUTE}"/>
    <text x="1110" y="${BOTTOM_ROUTE_Y + 50}" text-anchor="end" font-family="${MONO}" font-size="19" font-weight="700" fill="${COLOR_TEXT_DARK}">0.57 · 16, all named exemptions</text>
  </g>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  return `<g>
    ${renderBefore()}
    ${renderAfter()}
  </g>`;
}

/**
 * The content cover: both fields, no title text. Shown on the page itself
 * (blog index + post header).
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/**
 * The social/OG card: title in the clear left column, the same diagram
 * scaled into the right portion. Only used for og:image / twitter:image.
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 300);
  const titleMarkup = renderTitleLines(lines, fontSize, {
    x: MARGIN_X,
    centerY: CANVAS_HEIGHT / 2,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(350, 70) scale(0.66)">
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
