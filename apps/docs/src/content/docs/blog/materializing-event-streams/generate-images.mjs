#!/usr/bin/env node
// Bespoke cover/social images for the "Materializing Event Streams" post —
// NOT a generic template. Diagrams the post's own worked example
// (agent-stream-graph's examples/agents.ts): two independent bots
// (sales-bot, support-bot) each durably stream observations about the same
// real-world person into their own per-agent belief graph. sales-bot
// "crashes" after offset 002 and resumes without duplicating the edge it
// had already written; both beliefs merge into one canonical graph via
// mergeIncremental, which flags the property disagreements instead of
// picking one silently.
//
// Structurally a sibling of ../graph-merge/generate-images.mjs (two
// sources converging on one canonical card), but the offset-tick stream
// tracks and the crash/resume marker are specific to this post's actual
// subject: durable, resumable stream consumption, not a one-shot branch
// merge.
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
  renderConnector,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "materializing-event-streams";
const TITLE =
  "Materializing Event Streams: Two Bots, One Jane Doe, Zero Duplicates";

const COLOR_SALES = "#3b82f6";
const COLOR_SUPPORT = "#1e40af";
const COLOR_CRASH = "#dc2626";
const COLOR_CANONICAL_FILL = "#2563eb";
const COLOR_CANONICAL_STROKE = "#1d4ed8";
const COLOR_TEXT_MUTED = "#64748b";
const COLOR_TEXT_DARK = "#0f172a";

const TRACK_X_START = 90;
const TRACK_X_END = 660;
const SALES_Y = 250;
const SUPPORT_Y = 480;
const CANONICAL_X = 830;
const CANONICAL_W = 280;
const CANONICAL_H = 140;
const CANONICAL_Y = (SALES_Y + SUPPORT_Y) / 2 - CANONICAL_H / 2;

/**
 * @param {number} index
 * @param {number} count
 * @returns {number}
 */
function tickX(index, count) {
  return TRACK_X_START + (index * (TRACK_X_END - TRACK_X_START)) / (count - 1);
}

/**
 * @param {{ y: number; label: string; color: string; offsets: string[]; crashAfter: number | undefined }} options
 * @returns {string}
 */
function renderTrack({ y, label, color, offsets, crashAfter }) {
  const line = `<line x1="${TRACK_X_START}" y1="${y}" x2="${TRACK_X_END}" y2="${y}" stroke="${color}" stroke-width="2.5" opacity="0.6"/>`;
  const labelMarkup = `<text x="${TRACK_X_START}" y="${y - 22}" text-anchor="start" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="700" fill="${COLOR_TEXT_DARK}" letter-spacing="1">${escapeXml(label)}</text>`;

  const dots = offsets
    .map((offset, index) => {
      const x = tickX(index, offsets.length);
      const isCrash = crashAfter === index;
      const dot = `<circle cx="${x}" cy="${y}" r="7" fill="${color}" stroke="#ffffff" stroke-width="2"/>
    <text x="${x}" y="${y + 26}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15" fill="${COLOR_TEXT_MUTED}">${escapeXml(offset)}</text>`;
      if (!isCrash) return dot;
      const crashX = (x + tickX(index + 1, offsets.length)) / 2;
      return `${dot}
    <text x="${crashX}" y="${y - 14}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="20">&#9889;</text>
    <text x="${crashX}" y="${y + 42}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="700" fill="${COLOR_CRASH}">crash</text>`;
    })
    .join("\n    ");

  return `${line}
    ${labelMarkup}
    ${dots}`;
}

/**
 * @returns {string}
 */
function renderCanonicalCard() {
  const centerX = CANONICAL_X + CANONICAL_W / 2;
  return `<rect x="${CANONICAL_X}" y="${CANONICAL_Y}" width="${CANONICAL_W}" height="${CANONICAL_H}" rx="12" fill="${COLOR_CANONICAL_FILL}" stroke="${COLOR_CANONICAL_STROKE}" stroke-width="2"/>
    <text x="${centerX}" y="${CANONICAL_Y - 18}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="700" fill="${COLOR_TEXT_DARK}" letter-spacing="1">CANONICAL</text>
    <text x="${centerX}" y="${CANONICAL_Y + 40}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="700" fill="#ffffff">Jane Doe</text>
    <text x="${centerX}" y="${CANONICAL_Y + 64}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="16" fill="#dbeafe">VP Eng &amp; Product</text>
    <text x="${centerX}" y="${CANONICAL_Y + 88}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15" fill="#dbeafe">2 companies</text>
    <text x="${centerX}" y="${CANONICAL_Y + 112}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15" fill="#fca5a5">4 conflicts flagged</text>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const salesTrack = renderTrack({
    y: SALES_Y,
    label: "SALES-BOT",
    color: COLOR_SALES,
    offsets: ["001", "002", "003", "004"],
    crashAfter: 1,
  });
  const supportTrack = renderTrack({
    y: SUPPORT_Y,
    label: "SUPPORT-BOT",
    color: COLOR_SUPPORT,
    offsets: ["001", "002", "003", "004", "005"],
    crashAfter: undefined,
  });

  const salesConnector = renderConnector({
    x1: TRACK_X_END,
    y1: SALES_Y,
    x2: CANONICAL_X,
    y2: CANONICAL_Y + CANONICAL_H * 0.3,
    color: COLOR_SALES,
  });
  const supportConnector = renderConnector({
    x1: TRACK_X_END,
    y1: SUPPORT_Y,
    x2: CANONICAL_X,
    y2: CANONICAL_Y + CANONICAL_H * 0.7,
    color: COLOR_SUPPORT,
  });

  return `<g>
    ${salesConnector}
    ${supportConnector}
    ${salesTrack}
    ${supportTrack}
    ${renderCanonicalCard()}
  </g>`;
}

/**
 * The content cover: the stream diagram, no title text. Shown on the page
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

  <g transform="translate(160, 230) scale(0.58)">
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
