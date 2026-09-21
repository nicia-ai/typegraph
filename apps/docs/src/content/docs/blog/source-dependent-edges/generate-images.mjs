#!/usr/bin/env node
// PATTERN: field with a lit path
//
// Bespoke cover/social images for the "Source-Dependent Targets" post — NOT
// a generic template. The field is the naive Cartesian product a Cartesian
// `to: [Department, Course]` would allow: 3 Employees and 3 Students
// (upper- and lower-left) each faintly wired to all 3 Departments and all 3
// Courses (upper- and lower-right) — 36 thin, mostly-diagonal gray lines,
// every combination, crossing everywhere. On top of that mess sit two clean,
// perfectly horizontal, glowing blue ladders — Employee_i -> Department_i
// and Student_i -> Course_i, the only pairs a source-dependent `to` map
// actually declares — plus two of the faint diagonal lines picked out in
// dashed red with an X badge: the specific cross-pairs (Employee -> Course,
// Student -> Department) EndpointPairError rejects.
//
// The horizontal-vs-diagonal contrast IS the point: order sitting inside
// noise. No per-node labels (matching graph-algorithms' restraint) — the
// two clean ladders standing out against the crosshatched field, plus the
// two dashed red X's, carry the story without text.
//
// See #blog-art (scripts/lib/blog-art.mjs) for the shared
// canvas/logo/background/title primitives.
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

const SLUG = "source-dependent-edges";
const TITLE =
  "Source-Dependent Targets: One Edge Kind, Two Destinations, Zero Cross-Pairs";

const COLOR_FIELD = "#94a3b8";
const COLOR_NODE_FILL = "#cbd5e1";
const COLOR_NODE_STROKE = "#94a3b8";
const COLOR_LANE = "#2563eb";
const COLOR_LANE_GLOW = "#93c5fd";
const COLOR_DEAD = "#dc2626";

/**
 * @typedef {{ x: number; y: number }} Point
 */

/** @type {Point[]} */
const EMPLOYEES = [
  { x: 170, y: 210 },
  { x: 170, y: 288 },
  { x: 170, y: 366 },
];
/** @type {Point[]} */
const DEPARTMENTS = [
  { x: 980, y: 210 },
  { x: 980, y: 288 },
  { x: 980, y: 366 },
];
/** @type {Point[]} */
const STUDENTS = [
  { x: 170, y: 420 },
  { x: 170, y: 480 },
  { x: 170, y: 540 },
];
/** @type {Point[]} */
const COURSES = [
  { x: 980, y: 420 },
  { x: 980, y: 480 },
  { x: 980, y: 540 },
];

const SOURCES = [...EMPLOYEES, ...STUDENTS];
const TARGETS = [...DEPARTMENTS, ...COURSES];

// The two rejected cross-pairs called out explicitly: an Employee reaching a
// Course, a Student reaching a Department.
const DEAD_PAIRS = [
  { from: EMPLOYEES[0], to: COURSES[0] },
  { from: STUDENTS[0], to: DEPARTMENTS[0] },
];

const NODE_R = 9;

/**
 * The naive Cartesian field: every source wired to every target, faint gray,
 * mostly diagonal since only the same-index pairs share a y. This is what an
 * array-valued `to: [Department, Course]` would allow — the noise the two
 * clean horizontal ladders stand out against.
 * @returns {string}
 */
function renderField() {
  return SOURCES.flatMap((from) =>
    TARGETS.map(
      (to) =>
        `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${COLOR_FIELD}" stroke-width="1.25" opacity="0.22"/>`,
    ),
  ).join("\n    ");
}

/**
 * One rung of a lit ladder: a single glow-underlit horizontal line from one
 * source to its correlated target, the same treatment graph-algorithms uses
 * for its highlighted path.
 * @param {Point} from
 * @param {Point} to
 * @returns {string}
 */
function renderLitRung(from, to) {
  const glow = `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${COLOR_LANE_GLOW}" stroke-width="9" stroke-linecap="round" opacity="0.55"/>`;
  const solid = `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${COLOR_LANE}" stroke-width="3" stroke-linecap="round"/>`;
  return `${glow}\n    ${solid}`;
}

/**
 * @param {Point[]} from
 * @param {Point[]} to
 * @returns {string}
 */
function renderLadder(from, to) {
  return from.map((a, index) => renderLitRung(a, to[index])).join("\n    ");
}

/**
 * @param {Point[]} points
 * @returns {string}
 */
function renderNodes(points) {
  return points
    .map(
      ({ x, y }) =>
        `<circle cx="${x}" cy="${y}" r="${NODE_R}" fill="${COLOR_NODE_FILL}" stroke="${COLOR_NODE_STROKE}" stroke-width="1.75"/>`,
    )
    .join("\n    ");
}

/**
 * A rejected cross-pair: a thin dashed red diagonal plus a small X badge at
 * its midpoint, toned down (thin stroke, small badge) so it reads as an
 * annotation on the field rather than competing with the ladders.
 * @param {{ from: Point; to: Point }} pair
 * @returns {string}
 */
function renderDeadPair({ from, to }) {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const line = `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${COLOR_DEAD}" stroke-width="2" stroke-dasharray="8 7" opacity="0.65"/>`;
  const badge = `<g transform="translate(${midX}, ${midY})">
    <circle r="11" fill="#fef2f2" stroke="${COLOR_DEAD}" stroke-width="2"/>
    <path d="M -5 -5 L 5 5 M 5 -5 L -5 5" stroke="${COLOR_DEAD}" stroke-width="2" stroke-linecap="round"/>
  </g>`;
  return `${line}\n    ${badge}`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  return `<g>
    ${renderField()}
    ${DEAD_PAIRS.map((pair) => renderDeadPair(pair)).join("\n    ")}
    ${renderLadder(EMPLOYEES, DEPARTMENTS)}
    ${renderLadder(STUDENTS, COURSES)}
    ${renderNodes(SOURCES)}
    ${renderNodes(TARGETS)}
  </g>`;
}

/**
 * The content cover: the field and its two lit ladders, no title text.
 * Shown on the page itself (blog index + post header).
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/**
 * The social/OG card: title on the left, the field scaled down into the
 * right portion. Only used for og:image / twitter:image — never rendered on
 * the page.
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 320);
  const contentCenterY = CONTENT_SAFE_TOP + (630 - CONTENT_SAFE_TOP) / 2;
  const titleMarkup = renderTitleLines(lines, fontSize, {
    x: 90,
    centerY: contentCenterY,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(420, 153) scale(0.66)">
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
