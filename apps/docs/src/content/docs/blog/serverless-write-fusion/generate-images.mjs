#!/usr/bin/env node
// PATTERN: round-trip ladder (see .claude/skills/blog-cover/SKILL.md).
//
// Cover/social images for "One Exchange Instead of Six". The post's subject
// is latency spent on the wire, so the picture is the wire: two rails, the
// worker and the database, with the five sequential exchanges a managed
// write used to cost drawn as a muted ladder between them — each request
// with its own return trip, so the back-and-forth is visible as texture
// rather than asserted in a caption. The single fused statement is drawn
// once, in accent, across the top of the same rails.
//
// The bracket names the link latency as assumed, not measured: what this
// release measures is the number of submissions crossing the transport
// boundary, and the millisecond figures in the post are arithmetic over that
// count.
//
// This replaces a three-card stat grid ("5-6 requests -> 1 request",
// "83% fewer") that the 2026-08 cover review rejected: the numbers were
// real, but a numeral inside a rounded rectangle is not a picture of that
// numeral. Here the reader counts the muted rungs and sees the one blue
// line, and the ratio lands before any label is read.
//
// The five exchanges are the real ones the post enumerates: begin, the
// schema-fence probe, the duplicate check, the insert, and the commit.
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

const SLUG = "serverless-write-fusion";
const TITLE =
  "One Exchange Instead of Six: Fusing Writes for Serverless Drivers";

const COLOR_RAIL = "#cbd5e1";
const COLOR_MUTED = "#94a3b8";
const COLOR_MUTED_TEXT = "#64748b";
const COLOR_ACCENT = "#1d4ed8";
const COLOR_TEXT = "#0f172a";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const LEFT_RAIL = 265;
const RIGHT_RAIL = 815;
const RAIL_TOP = 232;
const RAIL_BOTTOM = 552;

const FUSED_Y = 262;
const LADDER_TOP = 330;
const ROW_STRIDE = 50;
const RETURN_OFFSET = 15;

// The five sequential exchanges a single managed write used to cost.
const EXCHANGES = [
  "begin",
  "schema-fence probe",
  "duplicate check",
  "insert",
  "commit",
];

/**
 * @param {{ y: number; toRight: boolean; color: string; width: number; dashed?: boolean }} arrow
 * @returns {string}
 */
function renderArrow({ y, toRight, color, width, dashed = false }) {
  const from = toRight ? LEFT_RAIL : RIGHT_RAIL;
  const to = toRight ? RIGHT_RAIL : LEFT_RAIL;
  const tip = toRight ? to - 1 : to + 1;
  const back = toRight ? tip - 11 : tip + 11;
  const dash = dashed ? ' stroke-dasharray="5 5"' : "";

  return `<line x1="${from}" y1="${y}" x2="${back}" y2="${y}" stroke="${color}" stroke-width="${width}"${dash}/>
    <polygon points="${tip},${y} ${back},${y - 5.5} ${back},${y + 5.5}" fill="${color}"/>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const rails = `<line x1="${LEFT_RAIL}" y1="${RAIL_TOP}" x2="${LEFT_RAIL}" y2="${RAIL_BOTTOM}" stroke="${COLOR_RAIL}" stroke-width="3"/>
    <line x1="${RIGHT_RAIL}" y1="${RAIL_TOP}" x2="${RIGHT_RAIL}" y2="${RAIL_BOTTOM}" stroke="${COLOR_RAIL}" stroke-width="3"/>
    <text x="${LEFT_RAIL}" y="${RAIL_TOP - 16}" font-size="17" font-family="${SANS}" font-weight="600" fill="${COLOR_TEXT}" text-anchor="middle">Worker</text>
    <text x="${RIGHT_RAIL}" y="${RAIL_TOP - 16}" font-size="17" font-family="${SANS}" font-weight="600" fill="${COLOR_TEXT}" text-anchor="middle">Neon · D1 · libSQL</text>`;

  const fused = `<g>
    ${renderArrow({ y: FUSED_Y, toRight: true, color: COLOR_ACCENT, width: 4 })}
    <text x="${(LEFT_RAIL + RIGHT_RAIL) / 2}" y="${FUSED_Y - 12}" font-size="17" font-family="${MONO}" font-weight="600" fill="${COLOR_ACCENT}" text-anchor="middle">one fused statement</text>
    <text x="${RIGHT_RAIL + 26}" y="${FUSED_Y + 6}" font-size="18" font-family="${SANS}" font-weight="700" fill="${COLOR_ACCENT}">1 round trip</text>
  </g>`;

  const ladder = EXCHANGES.map((label, index) => {
    const y = LADDER_TOP + index * ROW_STRIDE;
    return `<g>
    ${renderArrow({ y, toRight: true, color: COLOR_MUTED, width: 2.5 })}
    ${renderArrow({ y: y + RETURN_OFFSET, toRight: false, color: COLOR_MUTED, width: 1.5, dashed: true })}
    <text x="${(LEFT_RAIL + RIGHT_RAIL) / 2}" y="${y - 8}" font-size="16" font-family="${MONO}" fill="${COLOR_MUTED_TEXT}" text-anchor="middle">${escapeXml(label)}</text>
  </g>`;
  }).join("\n  ");

  const ladderBottom =
    LADDER_TOP + (EXCHANGES.length - 1) * ROW_STRIDE + RETURN_OFFSET;
  const bracket = `<path d="M ${RIGHT_RAIL + 20} ${LADDER_TOP - 10} L ${RIGHT_RAIL + 30} ${LADDER_TOP - 10} L ${RIGHT_RAIL + 30} ${ladderBottom + 10} L ${RIGHT_RAIL + 20} ${ladderBottom + 10}" fill="none" stroke="${COLOR_MUTED}" stroke-width="2"/>
    <text x="${RIGHT_RAIL + 42}" y="${(LADDER_TOP + ladderBottom) / 2 - 4}" font-size="18" font-family="${SANS}" font-weight="600" fill="${COLOR_MUTED_TEXT}">5–6 round trips</text>
    <text x="${RIGHT_RAIL + 42}" y="${(LADDER_TOP + ladderBottom) / 2 + 20}" font-size="17" font-family="${MONO}" fill="${COLOR_MUTED_TEXT}">assumed 45ms link</text>`;

  return `${rails}\n  ${ladder}\n  ${bracket}\n  ${fused}`;
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
  const { lines, fontSize } = layoutTitle(TITLE, 310);

  return svgDocument(`  ${renderIllustrationBackground()}
  ${renderLogoMark()}
  ${renderTitleLines(lines, fontSize, { x: MARGIN_X, centerY: CANVAS_HEIGHT / 2 })}
  <g transform="translate(300, 60) scale(0.62)">
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
