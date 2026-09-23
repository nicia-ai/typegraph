#!/usr/bin/env node
// Bespoke cover/social images for the "Graph Algorithms" post — NOT a
// generic template. The full real citation DAG from
// examples/32-graph-analytics.ts (the same 18 papers, 37 real citation
// edges used throughout the post) laid out by citation depth — backprop
// (1986) at depth 0, each paper one layer past the deepest paper it
// cites, LLaMA (2023) at depth 8 — rendered as a faint background network.
// One real route is lit up on top of it: weightedShortestPath's
// convex-cost path from "Attention Is All You Need" back to backprop
// (transformer → dropout → alexnet → lenet → backprop, the actual 4-hop
// route the post's example produces), thick and blue against the thin
// gray backdrop of every other paper and citation.
//
// This replaces an earlier two-row "shortestPath vs weightedShortestPath"
// box diagram — real information, but static and text-heavy. Showing the
// one meaningful path lit up inside the real, full network it was found
// in is both more abstract (most of the canvas is unlabeled texture) and
// more concrete (every dot and line is a real paper and a real citation,
// not decoration).
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

const SLUG = "graph-algorithms";
const TITLE = "The Cheapest Citation Lineage Isn't the Shortest One";

const COLOR_EDGE = "#94a3b8";
const COLOR_NODE_FILL = "#cbd5e1";
const COLOR_NODE_STROKE = "#94a3b8";
const COLOR_PATH = "#2563eb";
const COLOR_PATH_GLOW = "#93c5fd";
const COLOR_PATH_STROKE = "#1d4ed8";
const COLOR_TEXT_DARK = "#0f172a";

/**
 * @typedef {{ x: number; y: number }} Point
 */

// Real (x, y) layout for all 18 papers in examples/32-graph-analytics.ts,
// positioned by citation depth (0 = backprop, cited by nothing; each other
// paper is one layer past the deepest paper it cites). x follows depth
// left-to-right; y is hand-spread within each depth to keep the
// highlighted path's five nodes on a clean diagonal.
/** @type {Record<string, Point>} */
const NODES = {
  backprop: { x: 90, y: 450 },
  word2vec: { x: 217, y: 220 },
  lenet: { x: 217, y: 400 },
  adam: { x: 217, y: 520 },
  alexnet: { x: 345, y: 350 },
  seq2seq: { x: 345, y: 180 },
  dropout: { x: 472, y: 300 },
  vgg: { x: 472, y: 480 },
  transformer: { x: 600, y: 250 },
  resnet: { x: 600, y: 450 },
  bert: { x: 727, y: 220 },
  moco: { x: 727, y: 470 },
  gpt2: { x: 855, y: 200 },
  simclr: { x: 855, y: 360 },
  vit: { x: 855, y: 520 },
  cot: { x: 982, y: 250 },
  clip: { x: 982, y: 470 },
  llama: { x: 1110, y: 360 },
};

// All 37 real citation edges from the example's PAPERS seed data.
/** @type {Array<[string, string]>} */
const EDGES = [
  ["lenet", "backprop"],
  ["word2vec", "backprop"],
  ["alexnet", "lenet"],
  ["alexnet", "backprop"],
  ["dropout", "alexnet"],
  ["dropout", "backprop"],
  ["adam", "backprop"],
  ["vgg", "alexnet"],
  ["resnet", "alexnet"],
  ["resnet", "vgg"],
  ["resnet", "dropout"],
  ["seq2seq", "backprop"],
  ["seq2seq", "word2vec"],
  ["transformer", "seq2seq"],
  ["transformer", "adam"],
  ["transformer", "dropout"],
  ["transformer", "word2vec"],
  ["bert", "transformer"],
  ["bert", "word2vec"],
  ["gpt2", "transformer"],
  ["gpt2", "bert"],
  ["moco", "resnet"],
  ["simclr", "resnet"],
  ["simclr", "moco"],
  ["simclr", "dropout"],
  ["vit", "transformer"],
  ["vit", "resnet"],
  ["vit", "bert"],
  ["clip", "vit"],
  ["clip", "simclr"],
  ["clip", "bert"],
  ["clip", "gpt2"],
  ["cot", "gpt2"],
  ["cot", "bert"],
  ["llama", "transformer"],
  ["llama", "gpt2"],
  ["llama", "cot"],
];

// weightedShortestPath's real convex-cost route: 4 hops, totalWeight=353 —
// more hops than shortestPath's 2-hop route, but lower total cost.
const HIGHLIGHT_PATH = [
  "transformer",
  "dropout",
  "alexnet",
  "lenet",
  "backprop",
];

const NODE_R = 9;
const PATH_NODE_R = 15;

/**
 * @returns {string}
 */
function renderBackgroundEdges() {
  return EDGES.map(([from, to]) => {
    const a = NODES[from];
    const b = NODES[to];
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${COLOR_EDGE}" stroke-width="1.5" opacity="0.32"/>`;
  }).join("\n    ");
}

/**
 * @returns {string}
 */
function renderBackgroundNodes() {
  const highlighted = new Set(HIGHLIGHT_PATH);
  return Object.entries(NODES)
    .filter(([key]) => !highlighted.has(key))
    .map(
      ([, { x, y }]) =>
        `<circle cx="${x}" cy="${y}" r="${NODE_R}" fill="${COLOR_NODE_FILL}" stroke="${COLOR_NODE_STROKE}" stroke-width="1.5" opacity="0.75"/>`,
    )
    .join("\n    ");
}

/**
 * The lit path: a soft wide glow underneath a solid thick line, so it
 * reads as illuminated against the thin gray backdrop rather than just a
 * thicker version of the same line.
 * @returns {string}
 */
function renderHighlightPath() {
  const points = HIGHLIGHT_PATH.map((key) => NODES[key]);
  const pathD = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");

  const glow = `<path d="${pathD}" fill="none" stroke="${COLOR_PATH_GLOW}" stroke-width="14" stroke-linejoin="round" stroke-linecap="round" opacity="0.45"/>`;
  const solid = `<path d="${pathD}" fill="none" stroke="${COLOR_PATH}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;

  return `${glow}\n    ${solid}`;
}

/**
 * @returns {string}
 */
function renderHighlightNodes() {
  return HIGHLIGHT_PATH.map((key) => {
    const { x, y } = NODES[key];
    const isEndpoint = key === "transformer" || key === "backprop";
    const labelY = y - PATH_NODE_R - 14;
    const label = `<text x="${x}" y="${labelY}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="16" font-weight="700" fill="${COLOR_TEXT_DARK}">${escapeXml(key)}</text>`;
    const node = `<circle cx="${x}" cy="${y}" r="${PATH_NODE_R}" fill="${COLOR_PATH}" stroke="${COLOR_PATH_STROKE}" stroke-width="${isEndpoint ? 3.5 : 2.5}"/>`;
    return `${node}\n    ${label}`;
  }).join("\n    ");
}

/**
 * @returns {string}
 */
function renderDiagram() {
  return `<g>
    ${renderBackgroundEdges()}
    ${renderBackgroundNodes()}
    ${renderHighlightPath()}
    ${renderHighlightNodes()}
  </g>`;
}

/**
 * The content cover: the full citation network with one path lit up, no
 * title text. Shown on the page itself (blog index + post header).
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/**
 * The social/OG card: title on top, network scaled down and centered
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

  <g transform="translate(60, 175) scale(0.62)">
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
