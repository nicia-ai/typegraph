#!/usr/bin/env node
// PATTERN: fan, run in reverse — many collapsing into one
// (see .claude/skills/blog-cover/SKILL.md).
//
// Cover/social images for "Introducing TypeGraph". The post's own one-line
// answer to "why build this" is: instead of stitching together a vector
// store, an ORM, and a graph database. So the picture is the stitching —
// three separate systems on the left, and the integration surface between
// them drawn as what it actually is, a field of glue nodes with lines
// crossing every which way — collapsing into one typed core.
//
// This replaces the generic seeded-graph fallback, an abstract scatter of
// dots that could have belonged to any post. It was rejected in the 2026-08
// review as not dynamic enough, and the fallback is now retired: an
// announcement post is still about a change, and a change can be drawn.
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

const SLUG = "introducing-typegraph";
const TITLE = "Introducing TypeGraph";

const COLOR_SYSTEM = "#ffffff";
const COLOR_SYSTEM_STROKE = "#94a3b8";
const COLOR_SYSTEM_TEXT = "#334155";
const COLOR_GLUE = "#cbd5e1";
const COLOR_GLUE_LINE = "#a9bdd6";
const COLOR_CORE = "#1d4ed8";
const COLOR_CORE_GLOW = "#93c5fd";
const COLOR_MUTED_TEXT = "#64748b";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const SYSTEM_X = 110;
const SYSTEM_W = 200;
const SYSTEM_H = 52;

const CORE_X = 855;
const CORE_Y = 330;
const CORE_W = 245;
const CORE_H = 70;

const SYSTEMS = [
  { label: "vector store", y: 230 },
  { label: "ORM", y: 355 },
  { label: "graph database", y: 480 },
];

// The glue layer: hand-placed so the crossings are visibly tangled rather
// than a tidy bipartite fan. These are the integration points you write and
// keep in sync when the three systems are separate.
const GLUE = [
  { x: 400, y: 215 },
  { x: 470, y: 285 },
  { x: 395, y: 345 },
  { x: 480, y: 415 },
  { x: 405, y: 480 },
  { x: 555, y: 245 },
  { x: 600, y: 330 },
  { x: 545, y: 400 },
  { x: 615, y: 465 },
  { x: 700, y: 285 },
  { x: 690, y: 385 },
  { x: 745, y: 340 },
];

// Which glue nodes each system wires into — deliberately overlapping, so
// the lines cross.
const WIRING = [
  [0, 1, 5, 6, 9],
  [1, 2, 3, 6, 7, 10],
  [3, 4, 7, 8, 10],
];

/**
 * @returns {string}
 */
function renderDiagram() {
  const tangle = WIRING.flatMap((targets, systemIndex) => {
    const system = SYSTEMS[systemIndex];
    const originX = SYSTEM_X + SYSTEM_W;
    const originY = system.y + SYSTEM_H / 2;
    return targets.map((target) => {
      const node = GLUE[target];
      return `<line x1="${originX}" y1="${originY}" x2="${node.x}" y2="${node.y}" stroke="${COLOR_GLUE_LINE}" stroke-width="1.5" opacity="0.75"/>`;
    });
  }).join("\n    ");

  const collapse = GLUE.map(
    (node) =>
      `<line x1="${node.x}" y1="${node.y}" x2="${CORE_X}" y2="${CORE_Y + CORE_H / 2}" stroke="${COLOR_GLUE_LINE}" stroke-width="1.5" opacity="0.45"/>`,
  ).join("\n    ");

  const glueNodes = GLUE.map(
    (node, index) =>
      `<circle cx="${node.x}" cy="${node.y}" r="${6 + (index % 3)}" fill="${COLOR_GLUE}" stroke="${COLOR_GLUE_LINE}" stroke-width="1.5"/>`,
  ).join("\n    ");

  const systems = SYSTEMS.map(
    (system) =>
      `<rect x="${SYSTEM_X}" y="${system.y}" width="${SYSTEM_W}" height="${SYSTEM_H}" rx="10" fill="${COLOR_SYSTEM}" stroke="${COLOR_SYSTEM_STROKE}" stroke-width="2.5"/>
    <text x="${SYSTEM_X + SYSTEM_W / 2}" y="${system.y + 33}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="600" fill="${COLOR_SYSTEM_TEXT}">${escapeXml(system.label)}</text>`,
  ).join("\n    ");

  const core = `<rect x="${CORE_X - 8}" y="${CORE_Y - 8}" width="${CORE_W + 16}" height="${CORE_H + 16}" rx="18" fill="${COLOR_CORE_GLOW}" opacity="0.5"/>
    <rect x="${CORE_X}" y="${CORE_Y}" width="${CORE_W}" height="${CORE_H}" rx="12" fill="${COLOR_CORE}"/>
    <text x="${CORE_X + CORE_W / 2}" y="${CORE_Y + 31}" text-anchor="middle" font-family="${SANS}" font-size="21" font-weight="700" fill="#ffffff">TypeGraph</text>
    <text x="${CORE_X + CORE_W / 2}" y="${CORE_Y + 54}" text-anchor="middle" font-family="${MONO}" font-size="16" fill="#dbeafe">one typed core</text>`;

  const glueLabel = `<text x="${GLUE[6].x - 30}" y="${CANVAS_HEIGHT - 92}" text-anchor="middle" font-family="${SANS}" font-size="17" font-weight="600" fill="${COLOR_MUTED_TEXT}">glue you write and keep in sync</text>`;

  return `${tangle}\n    ${collapse}\n    ${glueNodes}\n    ${systems}\n    ${core}\n    ${glueLabel}`;
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
  <g transform="translate(390, 135) scale(0.54)">
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
