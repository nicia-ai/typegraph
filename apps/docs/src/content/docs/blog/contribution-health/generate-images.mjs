#!/usr/bin/env node
// PATTERN: cascade with a dead branch (see .claude/skills/blog-cover/SKILL.md),
// run as an escalation ladder.
//
// Cover/social images for "Probe, Repair, Rebuild". The post calls its own
// subject a ladder, and each rung costs more than the last: a read-only
// probe safe on a replica, a non-destructive repair for bookkeeping drift,
// and a scoped destructive rebuild for the one state repair cannot fix.
//
// So the picture descends. Three rungs step down and to the right, each
// carrying the set of damaged states it can resolve — the field is those
// states, and it shrinks as the ladder is walked. The last state, the
// dropped fulltext table that opens clean and fails at first search, sits
// alone on the bottom rung in accent: the one case that has to cost a
// rebuild.
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

const SLUG = "contribution-health";
const TITLE =
  "Probe, Repair, Rebuild: When the Search Index Isn't There Anymore";

const COLOR_STATE = "#cbd5e1";
const COLOR_STATE_STROKE = "#a9bdd6";
const COLOR_RUNG = "#6698d8";
const COLOR_RUNG_LAST = "#1d4ed8";
const COLOR_LAST_GLOW = "#93c5fd";
const COLOR_TEXT = "#0f172a";
const COLOR_MUTED_TEXT = "#64748b";
const COLOR_COST = "#b45309";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const RUNG_H = 54;

// Each rung resolves `states` of the damage it is handed, and the ladder
// descends because each costs more than the one above it.
const RUNGS = [
  {
    name: "probe",
    note: "read-only · safe on a replica",
    x: 130,
    y: 218,
    w: 330,
    states: 7,
    last: false,
  },
  {
    name: "repair",
    note: "non-destructive · bookkeeping drift",
    x: 330,
    y: 336,
    w: 360,
    states: 4,
    last: false,
  },
  {
    name: "rebuild",
    note: "destructive · scoped",
    x: 560,
    y: 454,
    w: 340,
    states: 1,
    last: true,
  },
];

/**
 * The damaged states each rung is still holding, drawn above it so the
 * shrinking count is the thing that reads first.
 * @param {{ x: number; y: number; states: number; last: boolean }} rung
 * @returns {string}
 */
function renderStates({ x, y, states, last }) {
  return Array.from({ length: states }, (unused, index) => {
    const cx = x + 30 + index * 40;
    const fill = last ? COLOR_RUNG_LAST : COLOR_STATE;
    const glow =
      last ?
        `<circle cx="${cx}" cy="${y - 34}" r="22" fill="${COLOR_LAST_GLOW}" opacity="0.55"/>`
      : "";
    return `${glow}<circle cx="${cx}" cy="${y - 34}" r="13" fill="${fill}" stroke="${last ? COLOR_RUNG_LAST : COLOR_STATE_STROKE}" stroke-width="2"/>`;
  }).join("\n    ");
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const steps = RUNGS.map((rung, index) => {
    const color = rung.last ? COLOR_RUNG_LAST : COLOR_RUNG;
    const drop =
      index < RUNGS.length - 1 ?
        `<path d="M ${rung.x + rung.w - 30} ${rung.y + RUNG_H} L ${rung.x + rung.w - 30} ${RUNGS[index + 1].y - 58} L ${RUNGS[index + 1].x + 30} ${RUNGS[index + 1].y - 58}" fill="none" stroke="${COLOR_COST}" stroke-width="3" stroke-dasharray="8 6"/>
    <polygon points="${RUNGS[index + 1].x + 30},${RUNGS[index + 1].y - 46} ${RUNGS[index + 1].x + 24},${RUNGS[index + 1].y - 60} ${RUNGS[index + 1].x + 36},${RUNGS[index + 1].y - 60}" fill="${COLOR_COST}"/>`
      : "";

    return `${renderStates(rung)}
    <rect x="${rung.x}" y="${rung.y}" width="${rung.w}" height="${RUNG_H}" rx="10" fill="#ffffff" stroke="${color}" stroke-width="3"/>
    <text x="${rung.x + 20}" y="${rung.y + 34}" font-family="${MONO}" font-size="20" font-weight="700" fill="${color}">${escapeXml(rung.name)}</text>
    <text x="${rung.x + rung.w + 18}" y="${rung.y + 34}" font-family="${SANS}" font-size="16" fill="${COLOR_MUTED_TEXT}">${escapeXml(rung.note)}</text>
    ${drop}`;
  }).join("\n    ");

  const costAxis = `<text x="${RUNGS[0].x + 300}" y="${RUNGS[0].y - 28}" font-family="${SANS}" font-size="17" font-weight="700" fill="${COLOR_TEXT}">damaged states still unresolved</text>
    <text x="${RUNGS[2].x}" y="${RUNGS[2].y + RUNG_H + 32}" font-family="${SANS}" font-size="17" font-weight="700" fill="${COLOR_COST}">each rung costs more than the one above</text>`;

  return `${costAxis}\n    ${steps}`;
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
  <g transform="translate(360, 135) scale(0.53)">
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
