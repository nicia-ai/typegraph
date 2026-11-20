#!/usr/bin/env node
// Bespoke cover/social images for the "An Infinite Supply of Graph
// Databases" post — NOT a generic template. Draws the post's actual claim:
// one small graph definition (the GraphDO class) fanning out into a wide,
// scattered cluster of identical private graphs, most idle (muted, small)
// and a few materialized (blue, larger, glowing) — the shape of "naming is
// the provisioning step," not a Cloudflare logo or a literal Durable
// Object diagram. Positions are hand-placed, not generated, so the
// cluster reads as deliberate scatter rather than a grid or an algorithm.
//
// See ../graph-algorithms/generate-images.mjs for the sibling bespoke
// script this one borrows the glow-node technique from, and #blog-art
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

const SLUG = "infinite-graph-databases";
const TITLE = "An Infinite Supply of Graph Databases";

const COLOR_BLUE = "#2563eb";
const COLOR_BLUE_DARK = "#1d4ed8";
const COLOR_BLUE_GLOW = "#93c5fd";
const COLOR_MUTED_FILL = "#cbd5e1";
const COLOR_MUTED_STROKE = "#94a3b8";
const COLOR_TEXT_MUTED = "#64748b";

const SOURCE_X = 190;
const SOURCE_Y = 335;
const LABEL_Y = 470;

/**
 * @typedef {{ dx: number; dy: number }} Offset
 */

/** Equilateral-triangle node offsets, point-up, unit radius. */
/** @type {readonly Offset[]} */
const TRIANGLE_OFFSETS = [
  { dx: 0, dy: -1 },
  { dx: -0.87, dy: 0.5 },
  { dx: 0.87, dy: 0.5 },
];

/**
 * A tiny 3-node graph glyph: the same shape at every scale, so the source
 * definition and every minted instance are visibly "the same thing."
 * @param {{ cx: number; cy: number; scale: number; fill: string; stroke: string; glow?: boolean; opacity?: number }} options
 * @returns {string}
 */
function renderMiniGraph({
  cx,
  cy,
  scale,
  fill,
  stroke,
  glow = false,
  opacity = 1,
}) {
  const points = TRIANGLE_OFFSETS.map((offset) => ({
    x: cx + offset.dx * scale,
    y: cy + offset.dy * scale,
  }));
  const nodeR = scale * 0.32;

  const edges = points
    .map((point, index) => {
      const next = points[(index + 1) % points.length];
      return `<line x1="${point.x.toFixed(1)}" y1="${point.y.toFixed(1)}" x2="${next.x.toFixed(1)}" y2="${next.y.toFixed(1)}" stroke="${stroke}" stroke-width="${(scale * 0.09).toFixed(1)}"/>`;
    })
    .join("\n    ");

  const glowNodes =
    glow ?
      points
        .map(
          (point) =>
            `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${(nodeR * 2.1).toFixed(1)}" fill="${COLOR_BLUE_GLOW}" opacity="0.4"/>`,
        )
        .join("\n    ")
    : "";

  const nodes = points
    .map(
      (point) =>
        `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${nodeR.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`,
    )
    .join("\n    ");

  return `<g opacity="${opacity}">
    ${edges}
    ${glowNodes}
    ${nodes}
  </g>`;
}

/**
 * @typedef {{ x: number; y: number; active: boolean }} TenantInstance
 */

// Hand-placed scatter, not a grid or an algorithm — a loose cluster that
// reads as "many, unevenly spaced" the way real tenant traffic would be.
// Three are "active" (materialized, mid-request); the rest hibernate.
/** @type {readonly TenantInstance[]} */
const TENANTS = [
  { x: 690, y: 215, active: false },
  { x: 800, y: 195, active: false },
  { x: 905, y: 235, active: false },
  { x: 1015, y: 200, active: true },
  { x: 665, y: 320, active: false },
  { x: 775, y: 345, active: false },
  { x: 885, y: 310, active: false },
  { x: 995, y: 335, active: true },
  { x: 1080, y: 295, active: false },
  { x: 705, y: 425, active: false },
  { x: 815, y: 455, active: false },
  { x: 925, y: 415, active: false },
  { x: 1035, y: 450, active: true },
  { x: 855, y: 480, active: false },
];

/**
 * The soft wedge from the source glyph toward the cluster region — "one
 * thing becoming many," without drawing a separate line to all 14 nodes.
 * @returns {string}
 */
function renderBeam() {
  const startX = SOURCE_X + 34;
  const points = `${startX},${SOURCE_Y} 640,175 640,495`;
  return `<polygon points="${points}" fill="${COLOR_BLUE}" opacity="0.06"/>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const source = renderMiniGraph({
    cx: SOURCE_X,
    cy: SOURCE_Y,
    scale: 34,
    fill: COLOR_BLUE,
    stroke: COLOR_BLUE_DARK,
    glow: true,
  });
  const sourceLabel = `<text x="${SOURCE_X}" y="${LABEL_Y}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700" fill="${COLOR_BLUE_DARK}">one class</text>`;

  const tenants = TENANTS.map((tenant) =>
    renderMiniGraph({
      cx: tenant.x,
      cy: tenant.y,
      scale: tenant.active ? 20 : 15,
      fill: tenant.active ? COLOR_BLUE : COLOR_MUTED_FILL,
      stroke: tenant.active ? COLOR_BLUE_DARK : COLOR_MUTED_STROKE,
      glow: tenant.active,
      opacity: tenant.active ? 1 : 0.55,
    }),
  ).join("\n    ");
  const clusterLabel = `<text x="870" y="${LABEL_Y}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700" fill="${COLOR_TEXT_MUTED}">endless tenants</text>`;

  return `<g>
    ${renderBeam()}
    ${source}
    ${sourceLabel}
    ${tenants}
    ${clusterLabel}
  </g>`;
}

/**
 * The content cover: the fan-out diagram, no title text. Shown on the page
 * itself (blog index + post header).
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

  <g transform="translate(50, 235) scale(0.6)">
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
