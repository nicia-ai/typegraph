#!/usr/bin/env node
// Bespoke cover/social images for the "Bitemporal Recorded Time and
// Provenance Retraction" post — NOT a generic template. Diagrams the post's
// own worked example (see the "What this enables" section): a vuln feed
// gets retracted, one flag survives because a second source also confirmed
// it, the other flag dies because the feed was its only support.
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

const SLUG = "truth-maintenance-for-agent-memory";
const TITLE = "Agent Memory That Knows Why It Believes Things";

const COLOR_LIVE_STROKE = "#2563eb";
const COLOR_LIVE_FILL = "#ffffff";
const COLOR_SOURCE_FILL = "#2563eb";
const COLOR_DEAD = "#dc2626";
const COLOR_TEXT = "#0f172a";
const COLOR_TEXT_MUTED = "#64748b";

/**
 * @typedef {{ x: number; y: number; w: number; h: number; lines: string[]; live: boolean; role: "source" | "fact" | "decision" }} DiagramNode
 * @typedef {{ from: DiagramNode; to: DiagramNode; live: boolean }} DiagramEdge
 */

const ROW1_Y = 190;
const ROW2_Y = 430;
const NODE_H = 72;

const sastRun = {
  x: 90,
  y: ROW1_Y,
  w: 170,
  h: NODE_H,
  lines: ["SASTRun"],
  live: true,
  role: /** @type {const} */ ("source"),
};
const vulnFeed = {
  x: 90,
  y: 310,
  w: 170,
  h: NODE_H,
  lines: ["VulnFeed"],
  live: false,
  role: /** @type {const} */ ("source"),
};
const vuln14 = {
  x: 460,
  y: ROW1_Y,
  w: 260,
  h: NODE_H,
  lines: ["Vulnerable(svc-14)"],
  live: true,
  role: /** @type {const} */ ("fact"),
};
const vuln22 = {
  x: 460,
  y: ROW2_Y,
  w: 260,
  h: NODE_H,
  lines: ["Vulnerable(svc-22)"],
  live: false,
  role: /** @type {const} */ ("fact"),
};
const block14 = {
  x: 830,
  y: ROW1_Y,
  w: 270,
  h: NODE_H,
  lines: ["BlockDeploy(svc-14)"],
  live: true,
  role: /** @type {const} */ ("decision"),
};
const block22 = {
  x: 830,
  y: ROW2_Y,
  w: 270,
  h: NODE_H,
  lines: ["BlockDeploy(svc-22)"],
  live: false,
  role: /** @type {const} */ ("decision"),
};

/** @type {DiagramEdge[]} */
const edges = [
  { from: sastRun, to: vuln14, live: true },
  { from: vulnFeed, to: vuln14, live: true },
  { from: vuln14, to: block14, live: true },
  { from: vulnFeed, to: vuln22, live: false },
  { from: vuln22, to: block22, live: false },
];

/**
 * @param {DiagramEdge} edge
 * @returns {string}
 */
function renderEdge(edge) {
  const start = rightAnchor(edge.from);
  const end = leftAnchor(edge.to);
  const midX = (start.x + end.x) / 2;
  const stroke = edge.live ? COLOR_LIVE_STROKE : COLOR_DEAD;
  const dash = edge.live ? "" : ' stroke-dasharray="8 6"';
  const opacity = edge.live ? 0.9 : 0.75;
  return `<path d="M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}" fill="none" stroke="${stroke}" stroke-width="3"${dash} opacity="${opacity}" marker-end="url(#arrow-${edge.live ? "live" : "dead"})"/>`;
}

/**
 * @param {DiagramNode} node
 * @returns {string}
 */
function renderNode(node) {
  const stroke = node.live ? COLOR_LIVE_STROKE : COLOR_DEAD;
  const fill =
    node.role === "source" && node.live ? COLOR_SOURCE_FILL : COLOR_LIVE_FILL;
  const opacity = node.live ? 1 : 0.85;
  const dash = node.live ? "" : ' stroke-dasharray="6 5"';
  const textColor =
    node.live && node.role === "source" ? "#ffffff"
    : node.live ? COLOR_TEXT
    : COLOR_TEXT_MUTED;
  const centerX = node.x + node.w / 2;
  const textY = node.y + node.h / 2 + 7;
  const label = escapeXml(node.lines[0]);

  const badge =
    node.role === "source" && !node.live ?
      `<g transform="translate(${node.x + node.w}, ${node.y})">
      <circle r="16" fill="#fef2f2" stroke="${COLOR_DEAD}" stroke-width="2.5"/>
      <path d="M -7 -7 L 7 7 M 7 -7 L -7 7" stroke="${COLOR_DEAD}" stroke-width="2.5" stroke-linecap="round"/>
    </g>`
    : "";

  return `<g opacity="${opacity}">
    <rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="2.5"${dash}/>
    <text x="${centerX}" y="${textY}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="600" fill="${textColor}">${label}</text>
  </g>
  ${badge}`;
}

/**
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {string} color
 * @returns {string}
 */
function renderCaption(text, x, y, color) {
  return `<text x="${x}" y="${y}" font-family="system-ui, -apple-system, sans-serif" font-size="19" font-weight="600" fill="${color}">${escapeXml(text)}</text>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const arrowDefs = `<marker id="arrow-live" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${COLOR_LIVE_STROKE}" opacity="0.9"/>
    </marker>
    <marker id="arrow-dead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${COLOR_DEAD}" opacity="0.75"/>
    </marker>`;

  const edgeMarkup = edges.map((edge) => renderEdge(edge)).join("\n    ");
  const nodeMarkup = [vulnFeed, sastRun, vuln14, vuln22, block14, block22]
    .map((node) => renderNode(node))
    .join("\n    ");

  const captions = [
    renderCaption(
      "two sources → stays blocked",
      block14.x,
      block14.y + block14.h + 30,
      COLOR_TEXT_MUTED,
    ),
    renderCaption(
      "feed retracted → unblocks",
      block22.x,
      block22.y + block22.h + 30,
      COLOR_DEAD,
    ),
  ].join("\n    ");

  return `<defs>
    ${arrowDefs}
  </defs>
  <g>
    ${edgeMarkup}
    ${nodeMarkup}
  </g>
  <g>
    ${captions}
  </g>`;
}

/**
 * The content cover: the retraction diagram, no title text. Shown on the
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
