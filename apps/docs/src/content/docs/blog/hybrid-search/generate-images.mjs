#!/usr/bin/env node
// Bespoke cover/social images for the "Hybrid Search" post — NOT a generic
// template. Diagrams the post's own worked example: a real
// `store.search.hybrid()` run (examples/15-fulltext-hybrid-search.ts) fusing
// vector and fulltext rankings with Reciprocal Rank Fusion. The three
// featured products and their exact vector/fulltext ranks and RRF scores
// are taken verbatim from that example's real output for the query
// "waterproof shell" — this is not illustrative data, it's what the query
// actually returned.
//
// The story the diagram tells: Arctic Shell is buried at vector rank #6
// (embeddings don't love it) but is fulltext's #1 pick — RRF still surfaces
// it at fused #2. That's the concrete case for hybrid over either signal
// alone.
//
// See ../runtime-schema-evolution/generate-images.mjs for the sibling
// bespoke script this one follows the pattern of, and #blog-art
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
  renderConnector,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "hybrid-search";
const TITLE = "Hybrid Search: The SKU Query Embeddings Always Get Wrong";

const COLOR_VECTOR = "#93c5fd";
const COLOR_FULLTEXT = "#2563eb";
const COLOR_TEXT_MUTED = "#64748b";
const COLOR_TEXT_DARK = "#0f172a";
const COLOR_CARD_FILL = "#2563eb";

// Real ranks and RRF scores from a live run of
// examples/15-fulltext-hybrid-search.ts, Part 6, query "waterproof shell".
/**
 * @typedef {{ name: string; vectorRank: number; fulltextRank: number | undefined; fusedRank: number; score: string }} FusedProduct
 */

/** @type {FusedProduct[]} */
const PRODUCTS = [
  {
    name: "Expedition Parka",
    vectorRank: 3,
    fulltextRank: 3,
    fusedRank: 1,
    score: "0.0357",
  },
  {
    name: "Arctic Shell",
    vectorRank: 6,
    fulltextRank: 1,
    fusedRank: 2,
    score: "0.0356",
  },
  {
    name: "Legacy Rain Shell",
    vectorRank: 5,
    fulltextRank: 2,
    fusedRank: 3,
    score: "0.0355",
  },
];

const VECTOR_LANE_X = 90;
const FULLTEXT_LANE_X = 1110;
const LANE_TOP_Y = 240;
const LANE_RANK_SPACING = 62;
const VECTOR_MAX_RANK = 6;
const FULLTEXT_MAX_RANK = 3;

const FUSED_CARD_X = 490;
const FUSED_CARD_W = 220;
const FUSED_CARD_H = 66;
const FUSED_CARD_Y = [252, 372, 492];

/**
 * @param {number} rank
 * @returns {number}
 */
function rankY(rank) {
  return LANE_TOP_Y + (rank - 1) * LANE_RANK_SPACING;
}

/**
 * A vertical rank scale: a thin line with tick marks, one per rank
 * position, so the reader can see where each product landed relative to
 * every other candidate — not just the three that made the cut.
 * @param {{ x: number; maxRank: number; label: string; align: "left" | "right" }} options
 * @returns {string}
 */
function renderRankScale({ x, maxRank, label, align }) {
  const bottomY = rankY(maxRank);
  const labelAnchor = align === "left" ? "start" : "end";
  const ticks = Array.from({ length: maxRank }, (_, index) => {
    const rank = index + 1;
    const y = rankY(rank);
    return `<line x1="${x - 8}" y1="${y}" x2="${x + 8}" y2="${y}" stroke="${COLOR_TEXT_MUTED}" stroke-width="2" opacity="0.5"/>`;
  }).join("\n    ");

  return `<line x1="${x}" y1="${LANE_TOP_Y}" x2="${x}" y2="${bottomY}" stroke="${COLOR_TEXT_MUTED}" stroke-width="2" opacity="0.35"/>
    ${ticks}
    <text x="${x}" y="${LANE_TOP_Y - 28}" text-anchor="${labelAnchor}" font-family="system-ui, -apple-system, sans-serif" font-size="17" font-weight="700" fill="${COLOR_TEXT_DARK}" letter-spacing="1">${escapeXml(label)}</text>
    <text x="${x}" y="${LANE_TOP_Y - 10}" text-anchor="${labelAnchor}" font-family="system-ui, -apple-system, sans-serif" font-size="13" fill="${COLOR_TEXT_MUTED}">rank 1 → ${maxRank}</text>`;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {string} rankLabel
 * @param {"left" | "right"} align
 * @returns {string}
 */
function renderRankDot(x, y, rankLabel, align) {
  const textX = align === "left" ? x + 16 : x - 16;
  const anchor = align === "left" ? "start" : "end";
  return `<circle cx="${x}" cy="${y}" r="7" fill="${COLOR_FULLTEXT}" stroke="#ffffff" stroke-width="2"/>
    <text x="${textX}" y="${y + 5}" text-anchor="${anchor}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15" font-weight="600" fill="${COLOR_TEXT_DARK}">${escapeXml(rankLabel)}</text>`;
}

/**
 * @param {FusedProduct} product
 * @param {number} cardY
 * @returns {string}
 */
function renderFusedCard(product, cardY) {
  const centerX = FUSED_CARD_X + FUSED_CARD_W / 2;
  const nameY = cardY + FUSED_CARD_H / 2 - 3;
  const scoreY = cardY + FUSED_CARD_H / 2 + 19;
  return `<rect x="${FUSED_CARD_X}" y="${cardY}" width="${FUSED_CARD_W}" height="${FUSED_CARD_H}" rx="10" fill="${COLOR_CARD_FILL}" stroke="${COLOR_FULLTEXT}" stroke-width="2"/>
    <text x="${FUSED_CARD_X - 14}" y="${cardY + FUSED_CARD_H / 2 + 6}" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="700" fill="${COLOR_TEXT_DARK}">#${product.fusedRank}</text>
    <text x="${centerX}" y="${nameY}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="700" fill="#ffffff">${escapeXml(product.name)}</text>
    <text x="${centerX}" y="${scoreY}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" fill="#dbeafe">rrf=${product.score}</text>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const kicker = `<text x="90" y="${LANE_TOP_Y - 70}" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="600" fill="${COLOR_TEXT_MUTED}">RRF fusion &#8212; query &quot;waterproof shell&quot;</text>`;

  const vectorScale = renderRankScale({
    x: VECTOR_LANE_X,
    maxRank: VECTOR_MAX_RANK,
    label: "VECTOR",
    align: "left",
  });
  const fulltextScale = renderRankScale({
    x: FULLTEXT_LANE_X,
    maxRank: FULLTEXT_MAX_RANK,
    label: "FULLTEXT",
    align: "right",
  });

  const dots = PRODUCTS.flatMap((product, index) => {
    const cardY = FUSED_CARD_Y[index];
    const cardCenterY = cardY + FUSED_CARD_H / 2;

    const vectorY = rankY(product.vectorRank);
    const fulltextY = rankY(product.fulltextRank ?? 0);

    return [
      renderRankDot(VECTOR_LANE_X, vectorY, `v#${product.vectorRank}`, "left"),
      renderRankDot(
        FULLTEXT_LANE_X,
        fulltextY,
        `f#${product.fulltextRank}`,
        "right",
      ),
      renderConnector({
        x1: VECTOR_LANE_X + 46,
        y1: vectorY,
        x2: FUSED_CARD_X,
        y2: cardCenterY,
        color: COLOR_VECTOR,
        opacity: 0.6,
      }),
      renderConnector({
        x1: FULLTEXT_LANE_X - 46,
        y1: fulltextY,
        x2: FUSED_CARD_X + FUSED_CARD_W,
        y2: cardCenterY,
        color: COLOR_FULLTEXT,
        opacity: 0.6,
      }),
    ];
  }).join("\n    ");

  const cards = PRODUCTS.map((product, index) =>
    renderFusedCard(product, FUSED_CARD_Y[index]),
  ).join("\n    ");

  const fusedLabel = `<text x="${FUSED_CARD_X + FUSED_CARD_W / 2}" y="${LANE_TOP_Y - 40}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="17" font-weight="700" fill="${COLOR_TEXT_DARK}" letter-spacing="1">RRF FUSED</text>`;

  const footerY = FUSED_CARD_Y[2] + FUSED_CARD_H + 56;
  const footer = `<text x="90" y="${footerY}" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="600" fill="${COLOR_TEXT_DARK}">buried at vector rank 6, fulltext's top pick, fused rank 2</text>`;

  return `<g>
    ${kicker}
    ${vectorScale}
    ${fulltextScale}
    ${fusedLabel}
    ${dots}
    ${cards}
    ${footer}
  </g>`;
}

/**
 * The content cover: the fusion diagram, no title text. Shown on the page
 * itself (blog index + post header).
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/**
 * The social/OG card: title on top (the diagram is too wide for a
 * side-by-side split like the schema-evolution card), fusion diagram
 * scaled down and centered below it. Only used for og:image /
 * twitter:image — never rendered on the page.
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 1000);
  const titleMarkup = renderTitleLines(lines, fontSize, {
    x: 90,
    centerY: CONTENT_SAFE_TOP + 80,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(240, 250) scale(0.6)">
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
