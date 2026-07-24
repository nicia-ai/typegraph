#!/usr/bin/env node
// Bespoke cover/social images for the "Runtime Schema Evolution" post — NOT
// a generic template. Diagrams the post's own worked example: the
// pdlug/typegraph-clinical-demo three-stage run, where an agent proposes a
// new node/edge kind after each stage of a real clinical-research corpus
// arrives, and the payoff query walks all three kinds even though none of
// them existed when the demo started.
//
// This is deliberately hand-laid-out rather than generated from a generic
// node/edge algorithm — the whole point is that the illustration should be
// literally true to the post's content, not an abstract decoration. Reach
// for a bespoke script like this one when a post has a concrete example
// worth diagramming; see scripts/generate-blog-images.mjs (imported as
// "#generic-blog-image") for the generic fallback used when it doesn't.
//
// Sized for legibility at typical display width (the blog content column is
// ~700-900px, well under the 1200px canvas) rather than at native size:
// large monospace node labels, thick strokes, dark text/borders on the
// light illustration background (see #blog-art, i.e.
// scripts/lib/blog-art.mjs), laid out to stay clear of the logo in the
// top-left corner.
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

import process from "node:process";

import {
  CANVAS_HEIGHT,
  CONTENT_SAFE_TOP,
  escapeXml,
  layoutTitle,
  leftAnchor,
  parseOutDirArgument,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  rightAnchor,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "runtime-schema-evolution";
const TITLE =
  "Runtime Schema Evolution: An Agent, a Clinical Trial, and a Retraction";

const COLOR_STROKE = "#2563eb";
const COLOR_FILL = "#2563eb";
const COLOR_TEXT_MUTED = "#64748b";
const COLOR_ACCENT_TEXT = "#0f172a";

/**
 * @typedef {{ x: number; y: number; w: number; h: number; label: string; stage: string }} StageNode
 * @typedef {{ from: StageNode; to: StageNode; label: string }} StageEdge
 */

const ROW_Y = 300;
const NODE_H = 76;

/** @type {StageNode} */
const trial = {
  x: 90,
  y: ROW_Y,
  w: 220,
  h: NODE_H,
  label: "ClinicalTrial",
  stage: "STAGE 1 · registration",
};
/** @type {StageNode} */
const publication = {
  x: 500,
  y: ROW_Y,
  w: 190,
  h: NODE_H,
  label: "Publication",
  stage: "STAGE 2 · publication",
};
/** @type {StageNode} */
const publicationEvent = {
  x: 910,
  y: ROW_Y,
  w: 225,
  h: NODE_H,
  label: "PublicationEvent",
  stage: "STAGE 3 · retraction",
};

/** @type {StageEdge[]} */
const edges = [
  { from: publication, to: trial, label: "referencesTrial" },
  { from: publicationEvent, to: publication, label: "correctsPublication" },
];

/**
 * Edges point backward (right-to-left) — that's the real query direction
 * from the demo: PublicationEvent --correctsPublication--> Publication
 * --referencesTrial--> ClinicalTrial. Each new kind points at what it's
 * about, which arrived in an earlier stage.
 * @param {StageEdge} edge
 * @returns {string}
 */
function renderEdge(edge) {
  const start = leftAnchor(edge.from);
  const end = rightAnchor(edge.to);
  const midX = (start.x + end.x) / 2;
  const labelX = (start.x + end.x) / 2;
  const labelY = start.y - 16;
  return `<path d="M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}" fill="none" stroke="${COLOR_STROKE}" stroke-width="3" opacity="0.85" marker-end="url(#arrow-stage)"/>
    <text x="${labelX}" y="${labelY}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="16" font-weight="600" fill="${COLOR_TEXT_MUTED}">${escapeXml(edge.label)}</text>`;
}

/**
 * @param {StageNode} node
 * @returns {string}
 */
function renderNode(node) {
  const centerX = node.x + node.w / 2;
  const textY = node.y + node.h / 2 + 7;
  const stageY = node.y + node.h + 32;

  return `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="12" fill="${COLOR_FILL}" stroke="${COLOR_STROKE}" stroke-width="2.5"/>
    <text x="${centerX}" y="${textY}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="600" fill="#ffffff">${escapeXml(node.label)}</text>
    <text x="${centerX}" y="${stageY}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="600" fill="${COLOR_TEXT_MUTED}">${escapeXml(node.stage)}</text>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const arrowDefs = `<marker id="arrow-stage" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${COLOR_STROKE}" opacity="0.85"/>
    </marker>`;

  const edgeMarkup = edges.map((edge) => renderEdge(edge)).join("\n    ");
  const nodeMarkup = [trial, publication, publicationEvent]
    .map((node) => renderNode(node))
    .join("\n    ");

  const retryRightX = publicationEvent.x + publicationEvent.w;
  const retryLabel = `<text x="${retryRightX}" y="${publicationEvent.y - 20}" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="600" fill="${COLOR_TEXT_MUTED}">smoke test failed once, agent repaired</text>`;

  const footerY = ROW_Y + NODE_H + 90;
  const footer = `<text x="90" y="${footerY}" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="600" fill="${COLOR_ACCENT_TEXT}">none of these three kinds existed when the demo started</text>`;

  return `<defs>
    ${arrowDefs}
  </defs>
  <g>
    ${edgeMarkup}
    ${nodeMarkup}
  </g>
  <g>
    ${retryLabel}
    ${footer}
  </g>`;
}

/**
 * The content cover: the schema-growth diagram, no title text. Shown on the
 * page itself (blog index + post header).
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/**
 * The social/OG card: the diagram scaled into the right portion of the
 * canvas, with the title set in the clear left column. Only used for
 * og:image / twitter:image — never rendered on the page.
 * @returns {string}
 */
function generateSocialSvg() {
  const contentCenterY =
    CONTENT_SAFE_TOP + (CANVAS_HEIGHT - CONTENT_SAFE_TOP) / 2;
  const { lines, fontSize } = layoutTitle(TITLE, 320);
  const titleMarkup = renderTitleLines(lines, fontSize, {
    x: 90,
    centerY: contentCenterY,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(420, 250) scale(0.6)">
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
