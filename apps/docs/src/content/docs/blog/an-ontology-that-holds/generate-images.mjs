#!/usr/bin/env node
// PATTERN: field with a lit path (see .claude/skills/blog-cover/SKILL.md)
//
// Bespoke cover/social images for "An Ontology That Holds". The field is a
// dependency graph laid out left to right, every edge pointing from a
// document to one it depends on, so the whole field is acyclic. One chain
// through it is lit: the witness path an `acyclic: true` refusal reports
// (`EdgeAcyclicityError.details.witness`). The proposed edge that would run
// from the end of that chain back to its start is drawn red and dashed,
// arcing over the field, and stopped by a refusal mark before it lands, so
// the picture is a relation refusing to close a loop.
//
// The field is generated from a fixed seed (background, not subject); the
// lit chain and the refused arc are placed by hand.
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

import process from "node:process";

import {
  CANVAS_HEIGHT,
  layoutTitle,
  MARGIN_X,
  parseOutDirArgument,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "an-ontology-that-holds";
const TITLE = "An Ontology That Holds";

const COLOR_EDGE = "#94a3b8";
const COLOR_NODE_FILL = "#cbd5e1";
const COLOR_NODE_STROKE = "#94a3b8";
const COLOR_PATH = "#2563eb";
const COLOR_PATH_GLOW = "#93c5fd";
const COLOR_PATH_STROKE = "#1d4ed8";
const COLOR_REFUSED = "#dc2626";

const COLUMN_COUNT = 8;
const ROWS_PER_COLUMN = 6;
const FIELD_LEFT = 120;
const FIELD_RIGHT = 1080;
const FIELD_TOP = 250;
const FIELD_BOTTOM = 540;
const NODE_R = 8;
const PATH_NODE_R = 14;

/**
 * @typedef {{ x: number; y: number }} Point
 * @typedef {{ id: string; column: number } & Point} FieldNode
 */

/**
 * Deterministic linear congruential generator, so the field never changes.
 * @param {number} seed
 * @returns {() => number}
 */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

/** The lit chain: column index and y for each node, start to end. */
const LIT_CHAIN = [
  { column: 1, y: 430 },
  { column: 2, y: 360 },
  { column: 3, y: 410 },
  { column: 4, y: 330 },
  { column: 5, y: 390 },
  { column: 6, y: 320 },
];

/**
 * @param {number} column
 * @returns {number}
 */
function columnX(column) {
  return (
    FIELD_LEFT + ((FIELD_RIGHT - FIELD_LEFT) * column) / (COLUMN_COUNT - 1)
  );
}

/** @returns {{ nodes: FieldNode[]; edges: Array<[FieldNode, FieldNode]> }} */
function buildField() {
  const random = seededRandom(637);
  /** @type {FieldNode[]} */
  const nodes = [];
  const rowGap = (FIELD_BOTTOM - FIELD_TOP) / (ROWS_PER_COLUMN - 1);
  for (let column = 0; column < COLUMN_COUNT; column += 1) {
    const lit = LIT_CHAIN.find((link) => link.column === column);
    if (lit !== undefined) {
      nodes.push({ id: `lit-${column}`, column, x: columnX(column), y: lit.y });
    }
    for (let row = 0; row < ROWS_PER_COLUMN; row += 1) {
      const y = FIELD_TOP + row * rowGap + (random() - 0.5) * rowGap * 0.9;
      // Leave room for the lit node in its column.
      if (lit !== undefined && Math.abs(y - lit.y) < 45) continue;
      nodes.push({
        id: `f${column}-${row}`,
        column,
        x: columnX(column) + (random() - 0.5) * 70,
        y,
      });
    }
  }
  const litIds = new Set(LIT_CHAIN.map((link) => `lit-${link.column}`));
  /** @type {Array<[FieldNode, FieldNode]>} */
  const edges = [];
  for (const node of nodes) {
    if (node.column === 0) continue;
    // Every edge points at a node in an earlier column, so the field is a
    // DAG; the lit chain's own edges are drawn separately.
    const earlier = nodes.filter(
      (candidate) =>
        candidate.column < node.column &&
        candidate.column >= node.column - 2 &&
        Math.abs(candidate.y - node.y) < 170 &&
        !(litIds.has(node.id) && litIds.has(candidate.id)),
    );
    const count = 1 + Math.floor(random() * 2);
    for (let index = 0; index < count && earlier.length > 0; index += 1) {
      const [target] = earlier.splice(Math.floor(random() * earlier.length), 1);
      edges.push([node, target]);
    }
  }
  return { nodes, edges };
}

const FIELD = buildField();
/** @type {Point[]} */
const CHAIN = LIT_CHAIN.map((link) => ({ x: columnX(link.column), y: link.y }));

function renderField() {
  const edges = FIELD.edges
    .map(
      ([from, to]) =>
        `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${COLOR_EDGE}" stroke-width="1.5" opacity="0.32"/>`,
    )
    .join("\n    ");
  const nodes = FIELD.nodes
    .filter((node) => !node.id.startsWith("lit-"))
    .map(
      (node) =>
        `<circle cx="${node.x}" cy="${node.y}" r="${NODE_R}" fill="${COLOR_NODE_FILL}" stroke="${COLOR_NODE_STROKE}" stroke-width="1.5" opacity="0.75"/>`,
    )
    .join("\n    ");
  return `${edges}\n    ${nodes}`;
}

function renderChain() {
  const pathD = CHAIN.map(
    (point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`,
  ).join(" ");
  const glow = `<path d="${pathD}" fill="none" stroke="${COLOR_PATH_GLOW}" stroke-width="14" stroke-linejoin="round" stroke-linecap="round" opacity="0.45"/>`;
  const solid = `<path d="${pathD}" fill="none" stroke="${COLOR_PATH}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;
  const nodes = CHAIN.map(
    (point, index) =>
      `<circle cx="${point.x}" cy="${point.y}" r="${PATH_NODE_R}" fill="${COLOR_PATH}" stroke="${COLOR_PATH_STROKE}" stroke-width="${index === 0 || index === CHAIN.length - 1 ? 3.5 : 2.5}"/>`,
  ).join("\n    ");
  return `${glow}\n    ${solid}\n    ${nodes}`;
}

/**
 * The proposed closing edge: from the chain's last node back toward its
 * first, arcing above the field. It stops short of the first node at a
 * refusal mark.
 */
function renderRefusedEdge() {
  const start = CHAIN.at(-1);
  const end = CHAIN[0];
  if (start === undefined) return "";
  const apexY = 205;
  const controlX = (start.x + end.x) / 2;
  // Quadratic curve from the last node up over the field toward the first.
  const curve = `M ${start.x} ${start.y - PATH_NODE_R} Q ${controlX} ${apexY - 95} ${end.x + 12} ${end.y - PATH_NODE_R - 36}`;
  const markX = end.x + 12;
  const markY = end.y - PATH_NODE_R - 36;
  const arc = `<path d="${curve}" fill="none" stroke="${COLOR_REFUSED}" stroke-width="4" stroke-dasharray="12 9" stroke-linecap="round"/>`;
  const stop = `<g transform="translate(${markX}, ${markY})">
      <circle r="17" fill="#ffffff" stroke="${COLOR_REFUSED}" stroke-width="4"/>
      <line x1="-7" y1="-7" x2="7" y2="7" stroke="${COLOR_REFUSED}" stroke-width="4" stroke-linecap="round"/>
      <line x1="7" y1="-7" x2="-7" y2="7" stroke="${COLOR_REFUSED}" stroke-width="4" stroke-linecap="round"/>
    </g>`;
  return `${arc}\n    ${stop}`;
}

function renderDiagram() {
  return `<g>
    ${renderField()}
    ${renderChain()}
    ${renderRefusedEdge()}
  </g>`;
}

function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 300);

  return svgDocument(`  ${renderIllustrationBackground()}
  ${renderLogoMark()}
  ${renderTitleLines(lines, fontSize, { x: MARGIN_X, centerY: CANVAS_HEIGHT / 2 })}
  <g transform="translate(420, 153) scale(0.66)">
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
