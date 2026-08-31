#!/usr/bin/env node
// PATTERN: field with a lit path (see .claude/skills/blog-cover/SKILL.md).
//
// Cover/social images for the five-engine benchmark post. The post's whole
// point is that the answer flips depending on the workload: TypeGraph/SQLite
// wins every point read, and loses the LDBC graph algorithms to pgGraph and
// Neo4j's GDS plugin by three to four orders of magnitude. Both are true.
//
// So the picture is the flip. Two logarithmic tracks — point reads on top,
// graph algorithms below — with the five engines placed on each by measured
// time. TypeGraph is the lit mark; a line joins its two positions, running
// from the fast end of one track to the slow end of the other. The reader
// sees a single steep diagonal: same engine, opposite ends.
//
// This replaces a cover showing two static icons ("point reads" / "graph
// algorithms") side by side, which the 2026-08 review rejected as empty —
// it named the two workloads without saying anything about either.
//
// Positions are log10(time) mapped onto each track, from the post's own
// SF1 measurements.
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

const SLUG = "benchmarking-typegraph-neo4j-ladybugdb";
const TITLE =
  "TypeGraph vs. Neo4j vs. LadybugDB vs. pgGraph: Where Each Engine Actually Wins";

const COLOR_TRACK = "#cbd5e1";
const COLOR_RIVAL = "#94a3b8";
const COLOR_RIVAL_TEXT = "#64748b";
const COLOR_US = "#1d4ed8";
const COLOR_US_GLOW = "#93c5fd";
const COLOR_TEXT = "#0f172a";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const TRACK_LEFT = 215;
const TRACK_RIGHT = 1080;
const READS_Y = 275;
const ALGOS_Y = 470;

// Each track is its own log decade span, since the two workloads differ by
// orders of magnitude; a shared scale would collapse one of them to a point.
const READS_DECADES = { min: -2, max: 2 };
const ALGOS_DECADES = { min: 0, max: 4 };

/**
 * Measured times in milliseconds. `us` marks TypeGraph, the lit subject.
 */
const TRACKS = [
  {
    y: READS_Y,
    decades: READS_DECADES,
    label: "POINT READS",
    engines: [
      { name: "TypeGraph", ms: 0.024, us: true },
      { name: "LadybugDB", ms: 0.6 },
      { name: "pgGraph", ms: 2.4 },
      { name: "Neo4j", ms: 9 },
    ],
  },
  {
    y: ALGOS_Y,
    decades: ALGOS_DECADES,
    label: "GRAPH ALGORITHMS",
    engines: [
      { name: "Neo4j GDS", ms: 8 },
      { name: "pgGraph", ms: 14 },
      { name: "LadybugDB", ms: 900 },
      { name: "TypeGraph", ms: 7600, us: true },
    ],
  },
];

/**
 * @param {number} ms
 * @param {{ min: number; max: number }} decades
 * @returns {number}
 */
function trackX(ms, decades) {
  const position = (Math.log10(ms) - decades.min) / (decades.max - decades.min);
  const clamped = Math.min(1, Math.max(0, position));
  return TRACK_LEFT + clamped * (TRACK_RIGHT - TRACK_LEFT);
}

/**
 * Labels alternate above and below the track so neighbouring engines never
 * collide, whatever the measurements put next to each other.
 * @param {{ name: string; ms: number; us?: boolean }} engine
 * @param {number} index
 * @param {{ y: number; decades: { min: number; max: number } }} track
 * @returns {string}
 */
function renderEngine(engine, index, track) {
  const x = trackX(engine.ms, track.decades);
  // Alternate the other way on the lower track so no label lands on the
  // flip curve that crosses it.
  const above = track.y === READS_Y ? index % 2 === 0 : index % 2 === 1;
  const labelY = above ? track.y - 22 : track.y + 34;
  const color = engine.us ? COLOR_US : COLOR_RIVAL;
  const textColor = engine.us ? COLOR_US : COLOR_RIVAL_TEXT;
  const weight = engine.us ? "700" : "500";
  const glow =
    engine.us ?
      `<circle cx="${x.toFixed(1)}" cy="${track.y}" r="18" fill="${COLOR_US_GLOW}" opacity="0.55"/>`
    : "";

  return `${glow}<circle cx="${x.toFixed(1)}" cy="${track.y}" r="${engine.us ? 10 : 7}" fill="${color}" stroke="#ffffff" stroke-width="2"/>
    <text x="${x.toFixed(1)}" y="${labelY}" text-anchor="middle" font-family="${SANS}" font-size="16" font-weight="${weight}" fill="${textColor}">${escapeXml(engine.name)}</text>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const tracks = TRACKS.map((track) => {
    const engines = track.engines
      .map((engine, index) => renderEngine(engine, index, track))
      .join("\n    ");
    return `<line x1="${TRACK_LEFT}" y1="${track.y}" x2="${TRACK_RIGHT}" y2="${track.y}" stroke="${COLOR_TRACK}" stroke-width="3"/>
    <text x="${MARGIN_X}" y="${track.y + 6}" font-family="${SANS}" font-size="17" font-weight="700" fill="${COLOR_TEXT}">${escapeXml(track.label)}</text>
    ${engines}`;
  }).join("\n    ");

  const readsUs = TRACKS[0].engines.find((engine) => engine.us);
  const algosUs = TRACKS[1].engines.find((engine) => engine.us);
  const x1 = trackX(readsUs.ms, READS_DECADES);
  const x2 = trackX(algosUs.ms, ALGOS_DECADES);
  const flip = `<path d="M ${x1.toFixed(1)} ${READS_Y} C ${x1 + 260} ${READS_Y}, ${x2 - 260} ${ALGOS_Y}, ${x2.toFixed(1)} ${ALGOS_Y}" fill="none" stroke="${COLOR_US}" stroke-width="3" stroke-dasharray="7 6" opacity="0.75"/>`;

  const axis = `<text x="${TRACK_LEFT}" y="${ALGOS_Y + 76}" font-family="${MONO}" font-size="16" fill="${COLOR_RIVAL_TEXT}">faster</text>
    <text x="${TRACK_RIGHT}" y="${ALGOS_Y + 76}" text-anchor="end" font-family="${MONO}" font-size="16" fill="${COLOR_RIVAL_TEXT}">slower · log scale</text>
    <line x1="${TRACK_LEFT}" y1="${ALGOS_Y + 56}" x2="${TRACK_RIGHT}" y2="${ALGOS_Y + 56}" stroke="${COLOR_TRACK}" stroke-width="1.5" stroke-dasharray="4 5"/>`;

  return `${flip}\n    ${tracks}\n    ${axis}`;
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
  <g transform="translate(340, 120) scale(0.56)">
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
