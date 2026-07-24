#!/usr/bin/env node
// Bespoke cover/social images for the "TypeGraph vs. Neo4j vs. LadybugDB
// vs. pgGraph" post — NOT a generic template. Replaces an earlier
// two-column ranked-numbers diagram (query latency vs. bulk-load time,
// four rows each) with two abstract query shapes side by side: a direct
// point lookup (concentric rings collapsing on a single hit — the shape
// of IS1-IS7, which TypeGraph/SQLite wins by construction) and a small
// traversed graph (a lit path through part of a node cluster — the shape
// of GA_WCC/GA_BFS/GA_SSSP/IC13, which the native-CSR engines win). The
// post's finding is literally "different query shapes, different
// winners," so the diagram draws the two shapes rather than another
// leaderboard of numbers.
//
// See ../graph-algorithms/generate-images.mjs for the sibling bespoke
// script this one borrows the glow-path technique from, and #blog-art
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

const SLUG = "benchmarking-typegraph-neo4j-ladybugdb";
const TITLE =
  "TypeGraph vs. Neo4j vs. LadybugDB vs. pgGraph: Where Each Engine Actually Wins";

const COLOR_BLUE = "#2563eb";
const COLOR_BLUE_DARK = "#1d4ed8";
const COLOR_AMBER = "#f59e0b";
const COLOR_AMBER_DARK = "#b45309";
const COLOR_AMBER_GLOW = "#fcd34d";
const COLOR_MUTED_FILL = "#cbd5e1";
const COLOR_MUTED_STROKE = "#94a3b8";
const COLOR_TEXT_MUTED = "#64748b";

const POINT_CX = 300;
const GRAPH_CX = 900;
const CENTER_Y = 335;
const DIVIDER_X = 600;
const LABEL_Y = 470;

/**
 * The point-read side: concentric rings collapsing on a single solid hit,
 * with a short arrow feeding straight into it — one lookup, no traversal.
 * @returns {string}
 */
function renderPointRead() {
  const rings = [72, 50, 30]
    .map((r, index) => {
      const opacity = 0.15 + index * 0.12;
      return `<circle cx="${POINT_CX}" cy="${CENTER_Y}" r="${r}" fill="none" stroke="${COLOR_BLUE}" stroke-width="3" opacity="${opacity.toFixed(2)}"/>`;
    })
    .join("\n    ");

  const arrow = `<line x1="150" y1="${CENTER_Y}" x2="222" y2="${CENTER_Y}" stroke="${COLOR_TEXT_MUTED}" stroke-width="3"/>
    <path d="M 214 ${CENTER_Y - 8} L 228 ${CENTER_Y} L 214 ${CENTER_Y + 8} Z" fill="${COLOR_TEXT_MUTED}"/>`;

  const core = `<circle cx="${POINT_CX}" cy="${CENTER_Y}" r="20" fill="${COLOR_BLUE}" stroke="${COLOR_BLUE_DARK}" stroke-width="3"/>`;

  const label = `<text x="${POINT_CX}" y="${LABEL_Y}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="21" font-weight="700" fill="${COLOR_BLUE_DARK}">point reads</text>`;

  return `${rings}\n    ${arrow}\n    ${core}\n    ${label}`;
}

// A small invented 8-node ring cluster (not real benchmark data — this is
// a shape, not a dataset) with two short chords for texture. Positions are
// an octagon around GRAPH_CX/CENTER_Y at radius 90.
const GRAPH_R = 90;
const GRAPH_NODE_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

/**
 * @param {number} angleDegrees
 * @returns {{ x: number; y: number }}
 */
function graphNodePoint(angleDegrees) {
  const radians = (angleDegrees * Math.PI) / 180;
  return {
    x: GRAPH_CX + GRAPH_R * Math.cos(radians),
    y: CENTER_Y - GRAPH_R * Math.sin(radians),
  };
}

const GRAPH_NODES = GRAPH_NODE_ANGLES.map((angle) => graphNodePoint(angle));
const GRAPH_RING_EDGES = GRAPH_NODE_ANGLES.map((_, index) => [
  index,
  (index + 1) % GRAPH_NODE_ANGLES.length,
]);
const GRAPH_CHORDS = [
  [0, 2],
  [4, 6],
];
// The lit traversal: four consecutive hops around part of the ring.
const HIGHLIGHT_INDICES = [5, 4, 3, 2, 1];

/**
 * The graph-algorithm side: a small node cluster with one path lit up
 * across part of it — the shape of a multi-hop traversal.
 * @returns {string}
 */
function renderGraphAlgorithm() {
  const backgroundEdges = [...GRAPH_RING_EDGES, ...GRAPH_CHORDS]
    .map(([fromIndex, toIndex]) => {
      const from = GRAPH_NODES[fromIndex];
      const to = GRAPH_NODES[toIndex];
      return `<line x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${to.x.toFixed(1)}" y2="${to.y.toFixed(1)}" stroke="${COLOR_MUTED_STROKE}" stroke-width="1.5" opacity="0.5"/>`;
    })
    .join("\n    ");

  const highlighted = new Set(HIGHLIGHT_INDICES);
  const backgroundNodes = GRAPH_NODES.filter(
    (_, index) => !highlighted.has(index),
  )
    .map(
      (node) =>
        `<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="7" fill="${COLOR_MUTED_FILL}" stroke="${COLOR_MUTED_STROKE}" stroke-width="1.5"/>`,
    )
    .join("\n    ");

  const pathPoints = HIGHLIGHT_INDICES.map((index) => GRAPH_NODES[index]);
  const pathD = pathPoints
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    )
    .join(" ");
  const glow = `<path d="${pathD}" fill="none" stroke="${COLOR_AMBER_GLOW}" stroke-width="12" stroke-linejoin="round" stroke-linecap="round" opacity="0.55"/>`;
  const solid = `<path d="${pathD}" fill="none" stroke="${COLOR_AMBER}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;

  const highlightNodes = HIGHLIGHT_INDICES.map(
    (index) =>
      `<circle cx="${GRAPH_NODES[index].x.toFixed(1)}" cy="${GRAPH_NODES[index].y.toFixed(1)}" r="10" fill="${COLOR_AMBER}" stroke="${COLOR_AMBER_DARK}" stroke-width="2.5"/>`,
  ).join("\n    ");

  const label = `<text x="${GRAPH_CX}" y="${LABEL_Y}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="21" font-weight="700" fill="${COLOR_AMBER_DARK}">graph algorithms</text>`;

  return `${backgroundEdges}\n    ${backgroundNodes}\n    ${glow}\n    ${solid}\n    ${highlightNodes}\n    ${label}`;
}

/**
 * @returns {string}
 */
function renderDivider() {
  return `<line x1="${DIVIDER_X}" y1="215" x2="${DIVIDER_X}" y2="500" stroke="${COLOR_MUTED_STROKE}" stroke-width="2" stroke-dasharray="2 10" stroke-linecap="round" opacity="0.6"/>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  return `<g>
    ${renderPointRead()}
    ${renderDivider()}
    ${renderGraphAlgorithm()}
  </g>`;
}

/**
 * The content cover: the two query shapes side by side, no title text.
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
    centerY: CONTENT_SAFE_TOP + 70,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(60, 220) scale(0.62)">
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
