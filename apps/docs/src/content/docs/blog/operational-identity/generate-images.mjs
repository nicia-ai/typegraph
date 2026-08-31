#!/usr/bin/env node
// PATTERN: field with a lit path (see .claude/skills/blog-cover/SKILL.md).
//
// Cover/social images for "Operational Identity". Two facts from the post
// have to sit in one picture: nodes that share an id fold together on sight,
// and a contradiction is refused twice — once by application validation and
// again by a constraint the database itself enforces.
//
// The previous cover drew those as two separate diagrams stacked one above
// the other, and the 2026-08 review called it exactly that: an odd split
// that reads as two pictures sharing a frame. Here there is one picture. The
// automatic folds are the field — many small pairs closing across the whole
// canvas — and the refused pair is the subject, drawn large in the middle
// with both barriers standing between its halves.
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
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "operational-identity";
const TITLE =
  "Operational Identity: Two Systems, One Customer, Zero Silent Contradictions";

const COLOR_PAIR = "#9db8dd";
const COLOR_PAIR_LINK = "#6698d8";
const COLOR_NODE = "#ffffff";
const COLOR_NODE_STROKE = "#94a3b8";
const COLOR_NODE_TEXT = "#334155";
const COLOR_REFUSE = "#dc2626";
const COLOR_MUTED_TEXT = "#64748b";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// Pairs that fold automatically because both sides share an id. They occupy
// the bands above and below the refused pair, so the subject keeps a clear
// middle to stand in.
const FOLDED_PAIRS = [
  { x: 130, y: 212 },
  { x: 320, y: 245 },
  { x: 520, y: 205 },
  { x: 700, y: 250 },
  { x: 890, y: 212 },
  { x: 175, y: 300 },
  { x: 960, y: 305 },
  { x: 140, y: 468 },
  { x: 340, y: 505 },
  { x: 545, y: 470 },
  { x: 735, y: 508 },
  { x: 930, y: 470 },
];

const PAIR_GAP = 46;

const NODE_W = 205;
const NODE_H = 54;
const NODE_Y = 356;
const LEFT_NODE_X = 155;
const RIGHT_NODE_X = 840;

const BARRIER_TOP = 318;
const BARRIER_BOTTOM = 448;
const BARRIER_ONE_X = 468;
const BARRIER_TWO_X = 622;

/**
 * @returns {string}
 */
function renderFoldedField() {
  return FOLDED_PAIRS.map(
    (pair) =>
      `<line x1="${pair.x}" y1="${pair.y}" x2="${pair.x + PAIR_GAP}" y2="${pair.y}" stroke="${COLOR_PAIR_LINK}" stroke-width="2.5" opacity="0.85"/>
    <circle cx="${pair.x}" cy="${pair.y}" r="8" fill="${COLOR_PAIR}" stroke="#ffffff" stroke-width="2"/>
    <circle cx="${pair.x + PAIR_GAP}" cy="${pair.y}" r="8" fill="${COLOR_PAIR}" stroke="#ffffff" stroke-width="2"/>`,
  ).join("\n    ");
}

/**
 * @param {{ x: number; label: string; id: string }} node
 * @returns {string}
 */
function renderNode({ x, label, id }) {
  return `<rect x="${x}" y="${NODE_Y}" width="${NODE_W}" height="${NODE_H}" rx="10" fill="${COLOR_NODE}" stroke="${COLOR_NODE_STROKE}" stroke-width="2.5"/>
    <text x="${x + NODE_W / 2}" y="${NODE_Y + 24}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="600" fill="${COLOR_NODE_TEXT}">${escapeXml(label)}</text>
    <text x="${x + NODE_W / 2}" y="${NODE_Y + 44}" text-anchor="middle" font-family="${MONO}" font-size="15" fill="${COLOR_MUTED_TEXT}">${escapeXml(id)}</text>`;
}

/**
 * @param {{ x: number; label: string; labelY: number }} barrier
 * @returns {string}
 */
function renderBarrier({ x, label, labelY }) {
  return `<rect x="${x - 5}" y="${BARRIER_TOP}" width="10" height="${BARRIER_BOTTOM - BARRIER_TOP}" rx="5" fill="${COLOR_REFUSE}"/>
    <line x1="${x}" y1="${BARRIER_BOTTOM}" x2="${x}" y2="${labelY - 15}" stroke="${COLOR_REFUSE}" stroke-width="1.5" opacity="0.5"/>
    <text x="${x}" y="${labelY}" text-anchor="middle" font-family="${SANS}" font-size="16" font-weight="600" fill="${COLOR_REFUSE}">${escapeXml(label)}</text>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const attempt = `<line x1="${LEFT_NODE_X + NODE_W}" y1="${NODE_Y + NODE_H / 2}" x2="${RIGHT_NODE_X}" y2="${NODE_Y + NODE_H / 2}" stroke="${COLOR_REFUSE}" stroke-width="2.5" stroke-dasharray="8 6" opacity="0.65"/>`;

  const barriers = `${renderBarrier({ x: BARRIER_ONE_X, label: "application", labelY: BARRIER_BOTTOM + 30 })}
    ${renderBarrier({ x: BARRIER_TWO_X, label: "CHECK constraint", labelY: BARRIER_BOTTOM + 62 })}`;

  const refusedLabel = `<text x="${(BARRIER_ONE_X + BARRIER_TWO_X) / 2}" y="${BARRIER_TOP - 18}" text-anchor="middle" font-family="${SANS}" font-size="19" font-weight="700" fill="${COLOR_REFUSE}">refused twice</text>`;

  const foldLabel = `<text x="${MARGIN_X}" y="${CANVAS_HEIGHT - 42}" font-family="${SANS}" font-size="17" font-weight="600" fill="${COLOR_MUTED_TEXT}">shared id · folds on sight</text>`;

  return `${renderFoldedField()}
    ${attempt}
    ${renderNode({ x: LEFT_NODE_X, label: "Person", id: "person-119" })}
    ${renderNode({ x: RIGHT_NODE_X, label: "CaseSubject", id: "case-77" })}
    ${barriers}
    ${refusedLabel}
    ${foldLabel}`;
}

/**
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}
  ${renderLogoMark()}
  ${renderDiagram()}`);
}

/**
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 300);

  return svgDocument(`  ${renderIllustrationBackground()}
  ${renderLogoMark()}
  ${renderTitleLines(lines, fontSize, { x: MARGIN_X, centerY: CANVAS_HEIGHT / 2 })}
  <g transform="translate(360, 140) scale(0.53)">
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
