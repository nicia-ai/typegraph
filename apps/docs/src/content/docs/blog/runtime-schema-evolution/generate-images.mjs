#!/usr/bin/env node
// PATTERN: fan (see .claude/skills/blog-cover/SKILL.md) — run over time, as
// accretion rather than one-to-many.
//
// Cover/social images for "Runtime Schema Evolution". The post's demo grows
// a clinical-research graph in three stages while it runs, and the third
// stage introduces a kind nobody designed for. The previous cover drew that
// as three identical boxes labelled STAGE 1 / STAGE 2 / STAGE 3 — the word
// "evolution" appeared, but nothing in the picture evolved, and the 2026-08
// review rejected it for exactly that.
//
// Here the graph itself grows across the canvas: each stage carries forward
// everything before it and adds its own instances, so the population
// visibly multiplies left to right. The third kind arrives in accent with a
// burst, because it is the one the schema did not have a slot for.
//
// The three kinds and the two relations between them are the real ones from
// the post's demo.
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

const SLUG = "runtime-schema-evolution";
const TITLE =
  "Runtime Schema Evolution: An Agent, a Clinical Trial, and a Retraction";

const COLOR_INSTANCE = "#cbd5e1";
const COLOR_INSTANCE_MID = "#a9bdd6";
const COLOR_KIND = "#ffffff";
const COLOR_KIND_STROKE = "#94a3b8";
const COLOR_KIND_TEXT = "#334155";
const COLOR_NEW = "#1d4ed8";
const COLOR_NEW_GLOW = "#93c5fd";
const COLOR_EDGE = "#94a3b8";
const COLOR_MUTED_TEXT = "#64748b";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const KIND_Y = 250;
const KIND_H = 46;
const CLOUD_TOP = 340;

/**
 * The three kinds the demo grows, in the order it grows them. `instances`
 * is how many rows of that kind exist by the end of that stage — the count
 * is what makes the growth visible, so the clouds are drawn to scale.
 */
const STAGES = [
  { kind: "ClinicalTrial", x: 150, w: 185, instances: 5, designed: true },
  { kind: "Publication", x: 470, w: 170, instances: 13, designed: true },
  { kind: "PublicationEvent", x: 790, w: 245, instances: 26, designed: false },
];

const RELATIONS = [
  { from: 1, to: 0, label: "referencesTrial" },
  { from: 2, to: 1, label: "correctsPublication" },
];

/**
 * Deterministic scatter for a stage's instance cloud — a fixed pseudo-random
 * walk, so the layout is stable across regenerations but not a visible grid.
 * @param {number} count
 * @param {number} seed
 * @returns {readonly { dx: number; dy: number; r: number }[]}
 */
function cloud(count, seed) {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  return Array.from({ length: count }, () => ({
    dx: (next() - 0.5) * 210,
    dy: next() * 165,
    r: 5 + next() * 4,
  }));
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const clouds = STAGES.map((stage, index) => {
    const centerX = stage.x + stage.w / 2;
    const fill = stage.designed ? COLOR_INSTANCE : COLOR_NEW;
    const opacity = stage.designed ? 1 : 0.75;
    return cloud(stage.instances, 7 + index * 31)
      .map(
        (dot) =>
          `<circle cx="${(centerX + dot.dx).toFixed(1)}" cy="${(CLOUD_TOP + dot.dy).toFixed(1)}" r="${dot.r.toFixed(1)}" fill="${index === 1 ? COLOR_INSTANCE_MID : fill}" opacity="${opacity}"/>`,
      )
      .join("\n    ");
  }).join("\n    ");

  const edges = RELATIONS.map((relation) => {
    const from = STAGES[relation.from];
    const to = STAGES[relation.to];
    const x1 = from.x;
    const x2 = to.x + to.w;
    const midX = (x1 + x2) / 2;
    return `<line x1="${x1}" y1="${KIND_Y + KIND_H / 2}" x2="${x2}" y2="${KIND_Y + KIND_H / 2}" stroke="${COLOR_EDGE}" stroke-width="2.5"/>
    <polygon points="${x2 + 1},${KIND_Y + KIND_H / 2} ${x2 + 12},${KIND_Y + KIND_H / 2 - 5.5} ${x2 + 12},${KIND_Y + KIND_H / 2 + 5.5}" fill="${COLOR_EDGE}"/>
    <text x="${midX}" y="${KIND_Y - 14}" text-anchor="middle" font-family="${MONO}" font-size="15" fill="${COLOR_MUTED_TEXT}">${escapeXml(relation.label)}</text>`;
  }).join("\n    ");

  const kinds = STAGES.map((stage) => {
    const fill = stage.designed ? COLOR_KIND : COLOR_NEW;
    const stroke = stage.designed ? COLOR_KIND_STROKE : COLOR_NEW;
    const textColor = stage.designed ? COLOR_KIND_TEXT : "#ffffff";
    const glow =
      stage.designed ? "" : (
        `<rect x="${stage.x - 7}" y="${KIND_Y - 7}" width="${stage.w + 14}" height="${KIND_H + 14}" rx="16" fill="${COLOR_NEW_GLOW}" opacity="0.5"/>\n    `
      );
    return `${glow}<rect x="${stage.x}" y="${KIND_Y}" width="${stage.w}" height="${KIND_H}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>
    <text x="${stage.x + stage.w / 2}" y="${KIND_Y + 30}" text-anchor="middle" font-family="${MONO}" font-size="18" font-weight="600" fill="${textColor}">${escapeXml(stage.kind)}</text>`;
  }).join("\n    ");

  const newKind = STAGES[2];
  const callout = `<text x="${newKind.x + newKind.w / 2}" y="${KIND_Y - 26}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="700" fill="${COLOR_NEW}">no one designed this kind</text>`;

  const counts = STAGES.map((stage) => {
    const centerX = stage.x + stage.w / 2;
    const color = stage.designed ? COLOR_MUTED_TEXT : COLOR_NEW;
    return `<text x="${centerX}" y="${CLOUD_TOP + 205}" text-anchor="middle" font-family="${MONO}" font-size="17" font-weight="600" fill="${color}">${stage.instances} rows</text>`;
  }).join("\n    ");

  return `${clouds}\n    ${edges}\n    ${kinds}\n    ${callout}\n    ${counts}`;
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
  <g transform="translate(330, 120) scale(0.58)">
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
