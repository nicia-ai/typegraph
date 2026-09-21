#!/usr/bin/env node
// PATTERN: cascade with a dead branch
//
// Bespoke cover/social images for the "Durable Merge Review" post — NOT a
// generic template. Diagrams the post's own worked example (Example 27):
// a Candidate write set feeds two things — a Review + Approval record
// persisted into the target, and an Original execution Plan. Persisting the
// review is itself a write, and that write is what kills the Original Plan:
// the dead branch runs straight down from "Review + Approval" into
// "Original Plan" and out to "StaleMergePlanError", dashed red, badged. The
// live branch keeps going from "Review + Approval" to "Fresh Plan ->
// Applied", solid blue. Same structure, two states at once — the retraction
// cascade this pattern is named for, applied to a plan instead of a fact.
//
// Sized for legibility at typical display width (the blog content column is
// ~700-900px, well under the 1200px canvas): large monospace node labels,
// thick strokes, dark text/borders on the light illustration background.
//
// See #blog-art (scripts/lib/blog-art.mjs) for the shared
// canvas/logo/background/title primitives.
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

const SLUG = "durable-merge-review";
const TITLE = "Durable Merge Review: The Plan Expires, the Approval Doesn't";

const COLOR_LIVE_STROKE = "#2563eb";
const COLOR_LIVE_FILL = "#ffffff";
const COLOR_SOURCE_FILL = "#2563eb";
const COLOR_DEAD = "#dc2626";
const COLOR_TEXT = "#0f172a";
const COLOR_TEXT_MUTED = "#64748b";

/**
 * @typedef {{ x: number; y: number; w: number; h: number; label: string; live: boolean; role: "source" | "fact" | "decision"; badge?: boolean }} DiagramNode
 */

const ROW1_Y = 190;
const ROW2_Y = 430;
const NODE_H = 72;

/** @type {DiagramNode} */
const candidate = {
  x: 90,
  y: ROW1_Y,
  w: 180,
  h: NODE_H,
  label: "Candidate",
  live: true,
  role: "source",
};
/** @type {DiagramNode} */
const reviewApproval = {
  x: 420,
  y: ROW1_Y,
  w: 280,
  h: NODE_H,
  label: "Review + Approval",
  live: true,
  role: "fact",
};
/** @type {DiagramNode} */
const freshPlanApplied = {
  x: 850,
  y: ROW1_Y,
  w: 260,
  h: NODE_H,
  label: "Fresh Plan → Applied",
  live: true,
  role: "decision",
};
/** @type {DiagramNode} */
const originalPlan = {
  x: 420,
  y: ROW2_Y,
  w: 220,
  h: NODE_H,
  label: "Original Plan",
  live: false,
  role: "fact",
};
/** @type {DiagramNode} */
const staleError = {
  x: 850,
  y: ROW2_Y,
  w: 260,
  h: NODE_H,
  label: "StaleMergePlanError",
  live: false,
  role: "decision",
  badge: true,
};

/**
 * @param {DiagramNode} box
 * @returns {{ x: number; y: number }}
 */
function bottomAnchor(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h };
}

/**
 * @param {DiagramNode} box
 * @returns {{ x: number; y: number }}
 */
function topAnchor(box) {
  return { x: box.x + box.w / 2, y: box.y };
}

/**
 * @param {{ x: number; y: number }} start
 * @param {{ x: number; y: number }} end
 * @param {boolean} live
 * @returns {string}
 */
function renderCurve(start, end, live) {
  const midX = (start.x + end.x) / 2;
  const stroke = live ? COLOR_LIVE_STROKE : COLOR_DEAD;
  const dash = live ? "" : ' stroke-dasharray="8 6"';
  const opacity = live ? 0.9 : 0.8;
  return `<path d="M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}" fill="none" stroke="${stroke}" stroke-width="3"${dash} opacity="${opacity}" marker-end="url(#arrow-${live ? "live" : "dead"})"/>`;
}

/**
 * The vertical kill line: persisting the review reaches straight down and
 * staples the original plan, badged where it lands.
 * @returns {string}
 */
function renderKillLine() {
  const start = bottomAnchor(reviewApproval);
  const end = topAnchor(originalPlan);
  const midY = (start.y + end.y) / 2;
  const line = `<path d="M ${start.x} ${start.y} L ${end.x} ${end.y}" fill="none" stroke="${COLOR_DEAD}" stroke-width="3" stroke-dasharray="8 6" opacity="0.8" marker-end="url(#arrow-dead)"/>`;
  const badge = `<g transform="translate(${start.x}, ${midY})">
    <circle r="17" fill="#fef2f2" stroke="${COLOR_DEAD}" stroke-width="2.5"/>
    <path d="M -7 -7 L 7 7 M 7 -7 L -7 7" stroke="${COLOR_DEAD}" stroke-width="2.5" stroke-linecap="round"/>
  </g>`;
  return `${line}\n    ${badge}`;
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
  const label = escapeXml(node.label);

  const badge =
    node.badge ?
      `<g transform="translate(${node.x + node.w}, ${node.y})">
      <circle r="16" fill="#fef2f2" stroke="${COLOR_DEAD}" stroke-width="2.5"/>
      <path d="M -7 -7 L 7 7 M 7 -7 L -7 7" stroke="${COLOR_DEAD}" stroke-width="2.5" stroke-linecap="round"/>
    </g>`
    : "";

  return `<g opacity="${opacity}">
    <rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="2.5"${dash}/>
    <text x="${centerX}" y="${textY}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="21" font-weight="600" fill="${textColor}">${label}</text>
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
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${COLOR_DEAD}" opacity="0.8"/>
    </marker>`;

  const edgeMarkup = [
    renderCurve(rightAnchor(candidate), leftAnchor(reviewApproval), true),
    renderCurve(rightAnchor(candidate), leftAnchor(originalPlan), true),
    renderCurve(
      rightAnchor(reviewApproval),
      leftAnchor(freshPlanApplied),
      true,
    ),
    renderCurve(rightAnchor(originalPlan), leftAnchor(staleError), false),
    renderKillLine(),
  ].join("\n    ");

  const nodeMarkup = [
    candidate,
    reviewApproval,
    freshPlanApplied,
    originalPlan,
    staleError,
  ]
    .map((node) => renderNode(node))
    .join("\n    ");

  const captions = [
    renderCaption(
      "still current → applies",
      freshPlanApplied.x,
      freshPlanApplied.y + freshPlanApplied.h + 30,
      COLOR_TEXT_MUTED,
    ),
    renderCaption(
      "review write → stale",
      staleError.x,
      staleError.y + staleError.h + 30,
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
 * The content cover: the review/plan cascade, no title text. Shown on the
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
