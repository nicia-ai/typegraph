#!/usr/bin/env node
// PATTERN: 3 — Streams converging on a record
//
// Bespoke cover/social images for "One Statement Per Page". Ten long lanes,
// each ticking with the individual reads a page assembly used to issue (every
// tick is one round trip), sweep through S-curves into a single solid
// batchOnce() node, which emits ONE bold line ending in one dot: a single
// statement. Five lanes carry the read families the post covers; the rest
// are anonymous, because the page's reads are many and mostly alike.
//
// Field test: the lanes are the field (~140 ticks), the merge is the action.
// Label-deletion test: with every label removed you still see many separate
// sequences collapsing into one line, which is the post.
//
// Pattern choice: 3 rather than 2 (fan) because the direction of the story
// is convergence — many reads become one. The lanes are long (60 → 610 of a
// 1200px canvas) so the convergence has travel; the short version (a few
// boxes) is the named failure mode in the blog-cover skill. Adjacent covers:
// materializing-event-streams also uses pattern 3 but with two tracks and
// offsets; here it is ten tick-dense lanes and a single-statement output.
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

import process from "node:process";

import {
  CANVAS_HEIGHT,
  escapeXml,
  layoutTitle,
  MARGIN_X,
  parseOutDirArgument,
  renderConnector,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "one-statement-reads";
const TITLE = "Replacing the N+1 Loop With One Statement";

const COLOR_ACCENT = "#2563eb";
const COLOR_ACCENT_DEEP = "#1d4ed8";
const COLOR_ACCENT_SOFT = "#3b82f6";
const COLOR_LANE = "#cbd5e1";
const COLOR_LANE_NAMED = "#94a3b8";
const COLOR_TEXT_MUTED = "#64748b";

const LANE_X_START = 60;
const LANE_X_END = 610;
const TICK_X_START = 280;
const TICK_X_END = 590;
const TICK_COUNT = 13;
const LANE_TOP_Y = 208;
const LANE_PITCH = 33;
const NODE = { x: 750, y: 310, w: 180, h: 110 };
const OUTPUT_X_END = 1128;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const LANES = [
  { label: undefined },
  { label: "neighbors()" },
  { label: undefined },
  { label: "countNeighbors()" },
  { label: undefined },
  { label: "topPerPartition()" },
  { label: undefined },
  { label: "subgraph()" },
  { label: undefined },
  { label: "page()" },
];

/**
 * Deterministic jitter so the ticks look like real arrivals without a
 * random seed changing the committed PNGs between runs.
 * @param {number} lane
 * @param {number} tick
 * @returns {number}
 */
function jitter(lane, tick) {
  const value =
    Math.sin((lane + 1) * 12.9898 + (tick + 1) * 78.233) * 43_758.5453;
  return value - Math.floor(value) - 0.5;
}

/**
 * @param {number} lane
 * @returns {number}
 */
function laneY(lane) {
  return LANE_TOP_Y + lane * LANE_PITCH;
}

/**
 * @param {number} lane
 * @returns {string}
 */
function renderLane(lane) {
  const y = laneY(lane);
  const { label } = LANES[lane];
  const color = label === undefined ? COLOR_LANE : COLOR_LANE_NAMED;
  const step = (TICK_X_END - TICK_X_START) / (TICK_COUNT - 1);

  const ticks = Array.from({ length: TICK_COUNT }, (_, tick) => {
    const x = TICK_X_START + tick * step + jitter(lane, tick) * step * 0.55;
    return `<line x1="${x.toFixed(1)}" y1="${y - 7}" x2="${x.toFixed(1)}" y2="${y + 7}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
  }).join("\n    ");

  const labelMarkup =
    label === undefined ? "" : (
      `<text x="${LANE_X_START}" y="${y - 9}" font-family="${MONO}" font-size="16" fill="${COLOR_TEXT_MUTED}">${escapeXml(label)}</text>`
    );

  return `<line x1="${LANE_X_START}" y1="${y}" x2="${LANE_X_END}" y2="${y}" stroke="${color}" stroke-width="2" opacity="0.8"/>
    ${ticks}
    ${labelMarkup}`;
}

/**
 * @param {number} lane
 * @returns {string}
 */
function renderLaneConnector(lane) {
  const spread = 8;
  const anchorY =
    NODE.y + NODE.h / 2 + (lane - (LANES.length - 1) / 2) * spread;
  return renderConnector({
    x1: LANE_X_END,
    y1: laneY(lane),
    x2: NODE.x,
    y2: anchorY,
    color: LANES[lane].label === undefined ? COLOR_LANE : COLOR_LANE_NAMED,
    opacity: 0.9,
    strokeWidth: 2,
  });
}

/**
 * @returns {string}
 */
function renderMergeNode() {
  const centerY = NODE.y + NODE.h / 2;
  return `<rect x="${NODE.x}" y="${NODE.y}" width="${NODE.w}" height="${NODE.h}" rx="14" fill="${COLOR_ACCENT}" stroke="${COLOR_ACCENT_DEEP}" stroke-width="2"/>
    <text x="${NODE.x + NODE.w / 2}" y="${centerY + 8}" text-anchor="middle" font-family="${MONO}" font-size="22" font-weight="700" fill="#ffffff">batchOnce()</text>`;
}

/**
 * @returns {string}
 */
function renderOutput() {
  const y = NODE.y + NODE.h / 2;
  const startX = NODE.x + NODE.w;
  return `<line x1="${startX}" y1="${y}" x2="${OUTPUT_X_END}" y2="${y}" stroke="${COLOR_ACCENT_SOFT}" stroke-width="16" stroke-linecap="round" opacity="0.18"/>
    <line x1="${startX}" y1="${y}" x2="${OUTPUT_X_END}" y2="${y}" stroke="${COLOR_ACCENT}" stroke-width="6" stroke-linecap="round"/>
    <circle cx="${OUTPUT_X_END}" cy="${y}" r="13" fill="${COLOR_ACCENT}" stroke="#ffffff" stroke-width="3"/>
    <text x="${(startX + OUTPUT_X_END) / 2}" y="${y - 24}" text-anchor="middle" font-family="${MONO}" font-size="20" font-weight="700" fill="${COLOR_ACCENT_DEEP}">1 statement</text>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const lanes = LANES.map((_, lane) => renderLane(lane)).join("\n    ");
  const connectors = LANES.map((_, lane) => renderLaneConnector(lane)).join(
    "\n    ",
  );
  return `<g>
    ${connectors}
    ${lanes}
    ${renderMergeNode()}
    ${renderOutput()}
  </g>`;
}

/**
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/**
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 330);

  return svgDocument(`  ${renderIllustrationBackground()}
  ${renderLogoMark()}
  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif">
    ${renderTitleLines(lines, fontSize, { x: MARGIN_X, centerY: CANVAS_HEIGHT / 2 })}
  </g>
  <g transform="translate(410, 95) scale(0.66)">
    ${renderDiagram()}
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
