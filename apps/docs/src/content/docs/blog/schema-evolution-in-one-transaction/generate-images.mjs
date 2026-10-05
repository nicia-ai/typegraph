#!/usr/bin/env node
// PATTERN: 4. Cascade with a dead branch (see .claude/skills/blog-cover/SKILL.md)
//
// Cover/social images for "Schema Evolution in One Transaction". One `plan`
// origin fans into two lanes with the same structure: the schema version, the
// field of Retraction rows it made room for, the recorded revision, and the
// ledger row. The upper lane commits. In the lower lane the LAST step — the
// ledger row — fails, and the failure travels back along a rollback arc,
// taking every earlier step down with it: dashed, greyed, struck through.
//
// The post's claim is that these steps share one fate. The dead lane is the
// same structure as the live one on purpose; the only difference is that the
// last node failed and the rest went with it.
//
// Field test: the twenty-row cluster gives the cascade something to act on.
// Label-deletion test: with all text removed you still see two identical
// chains, one solid blue and one dashed red, a red ✕ at the end of the dead
// one, and an arc carrying the failure back to the origin.
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

const SLUG = "schema-evolution-in-one-transaction";
const TITLE = "Schema Changes That Roll Back With Everything Else";

const COLOR_LIVE_STROKE = "#2563eb";
const COLOR_LIVE_ROW = "#3b82f6";
const COLOR_FILL = "#ffffff";
const COLOR_ORIGIN_FILL = "#2563eb";
const COLOR_DEAD = "#dc2626";
const COLOR_DEAD_FILL = "#fef2f2";
const COLOR_TEXT = "#0f172a";
const COLOR_TEXT_MUTED = "#64748b";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "system-ui, -apple-system, sans-serif";

const NODE_H = 64;
const LIVE_LANE_Y = 250;
const DEAD_LANE_Y = 430;
const ROW_SIZE = 16;
const ROW_GAP = 6;
const ROW_COLUMNS = 5;
const ROW_LINES = 4;
const ROW_CLUSTER_WIDTH = ROW_COLUMNS * ROW_SIZE + (ROW_COLUMNS - 1) * ROW_GAP;
const ROW_CLUSTER_HEIGHT = ROW_LINES * ROW_SIZE + (ROW_LINES - 1) * ROW_GAP;

/**
 * @typedef {{ x: number; y: number; w: number; h: number }} Box
 */

const origin = { x: 60, y: 308, w: 140, h: NODE_H };

/**
 * One lane's four steps, centred on `laneY`.
 * @param {number} laneY
 */
function laneSteps(laneY) {
  const y = laneY - NODE_H / 2;
  return {
    schema: { x: 290, y, w: 170, h: NODE_H, label: "schema v2" },
    rows: {
      x: 535,
      y: laneY - ROW_CLUSTER_HEIGHT / 2,
      w: ROW_CLUSTER_WIDTH,
      h: ROW_CLUSTER_HEIGHT,
    },
    recorded: { x: 720, y, w: 190, h: NODE_H, label: "recorded r2" },
    ledger: { x: 985, y, w: 160, h: NODE_H, label: "ledger row" },
  };
}

const live = laneSteps(LIVE_LANE_Y);
const dead = laneSteps(DEAD_LANE_Y);

/**
 * @param {Box} from
 * @param {Box} to
 * @param {boolean} isLive
 * @returns {string}
 */
function renderLink(from, to, isLive) {
  const start = rightAnchor(from);
  const end = leftAnchor(to);
  const midX = (start.x + end.x) / 2;
  const stroke = isLive ? COLOR_LIVE_STROKE : COLOR_DEAD;
  const dash = isLive ? "" : ' stroke-dasharray="8 6"';
  const opacity = isLive ? 0.9 : 0.6;
  return `<path d="M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}" fill="none" stroke="${stroke}" stroke-width="3"${dash} opacity="${opacity}" marker-end="url(#arrow-${isLive ? "live" : "dead"})"/>`;
}

/**
 * @param {Box & { label: string }} node
 * @param {"live" | "dead" | "failed"} state
 * @returns {string}
 */
function renderStep(node, state) {
  const centerX = node.x + node.w / 2;
  const textY = node.y + node.h / 2 + 7;
  const label = escapeXml(node.label);
  if (state === "live") {
    return `<g>
    <rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="12" fill="${COLOR_FILL}" stroke="${COLOR_LIVE_STROKE}" stroke-width="2.5"/>
    <text x="${centerX}" y="${textY}" text-anchor="middle" font-family="${MONO}" font-size="22" font-weight="600" fill="${COLOR_TEXT}">${label}</text>
  </g>`;
  }
  const strikeHalfWidth = label.length * 6.6;
  const strike = `<path d="M ${centerX - strikeHalfWidth} ${textY - 7} L ${centerX + strikeHalfWidth} ${textY - 7}" stroke="${COLOR_DEAD}" stroke-width="2.5" opacity="0.75"/>`;
  if (state === "dead") {
    return `<g opacity="0.85">
    <rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="12" fill="${COLOR_FILL}" stroke="${COLOR_DEAD}" stroke-width="2.5" stroke-dasharray="6 5"/>
    <text x="${centerX}" y="${textY}" text-anchor="middle" font-family="${MONO}" font-size="22" font-weight="600" fill="${COLOR_TEXT_MUTED}">${label}</text>
    ${strike}
  </g>`;
  }
  return `<g>
    <rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="12" fill="${COLOR_DEAD_FILL}" stroke="${COLOR_DEAD}" stroke-width="3.5"/>
    <text x="${centerX}" y="${textY}" text-anchor="middle" font-family="${MONO}" font-size="22" font-weight="600" fill="${COLOR_TEXT}">${label}</text>
  </g>
  <g transform="translate(${node.x + node.w}, ${node.y})">
    <circle r="20" fill="#ffffff" stroke="${COLOR_DEAD}" stroke-width="3.5"/>
    <path d="M -8 -8 L 8 8 M 8 -8 L -8 8" stroke="${COLOR_DEAD}" stroke-width="3.5" stroke-linecap="round"/>
  </g>`;
}

/**
 * The field: the Retraction rows the schema change made room for.
 * @param {Box} cluster
 * @param {boolean} isLive
 * @returns {string}
 */
function renderRows(cluster, isLive) {
  const squares = [];
  for (let row = 0; row < ROW_LINES; row += 1) {
    for (let column = 0; column < ROW_COLUMNS; column += 1) {
      const x = cluster.x + column * (ROW_SIZE + ROW_GAP);
      const y = cluster.y + row * (ROW_SIZE + ROW_GAP);
      squares.push(
        isLive ?
          `<rect x="${x}" y="${y}" width="${ROW_SIZE}" height="${ROW_SIZE}" rx="4" fill="${COLOR_LIVE_ROW}" opacity="${0.55 + 0.05 * ((row + column) % 4)}"/>`
        : `<rect x="${x}" y="${y}" width="${ROW_SIZE}" height="${ROW_SIZE}" rx="4" fill="none" stroke="${COLOR_DEAD}" stroke-width="2" stroke-dasharray="4 4" opacity="0.6"/>`,
      );
    }
  }
  return squares.join("\n    ");
}

/**
 * @returns {string}
 */
function renderOrigin() {
  const centerX = origin.x + origin.w / 2;
  const textY = origin.y + origin.h / 2 + 7;
  return `<g>
    <rect x="${origin.x}" y="${origin.y}" width="${origin.w}" height="${origin.h}" rx="12" fill="${COLOR_ORIGIN_FILL}" stroke="${COLOR_LIVE_STROKE}" stroke-width="2.5"/>
    <text x="${centerX}" y="${textY}" text-anchor="middle" font-family="${MONO}" font-size="22" font-weight="600" fill="#ffffff">plan</text>
  </g>`;
}

/**
 * The failure travelling back: from the failed ledger row, under every
 * earlier step, to the origin.
 * @returns {string}
 */
function renderRollbackArc() {
  const startX = dead.ledger.x + dead.ledger.w / 2;
  const startY = dead.ledger.y + dead.ledger.h;
  const endX = origin.x + origin.w / 2;
  const endY = origin.y + origin.h + 4;
  return `<path d="M ${startX} ${startY + 4} C ${startX} 548, ${endX} 548, ${endX} ${endY}" fill="none" stroke="${COLOR_DEAD}" stroke-width="3" stroke-dasharray="10 7" opacity="0.85" marker-end="url(#arrow-dead)"/>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const defs = `<defs>
    <marker id="arrow-live" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${COLOR_LIVE_STROKE}" opacity="0.9"/>
    </marker>
    <marker id="arrow-dead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${COLOR_DEAD}" opacity="0.85"/>
    </marker>
  </defs>`;

  const links = [
    renderLink(origin, live.schema, true),
    renderLink(live.schema, live.rows, true),
    renderLink(live.rows, live.recorded, true),
    renderLink(live.recorded, live.ledger, true),
    renderLink(origin, dead.schema, false),
    renderLink(dead.schema, dead.rows, false),
    renderLink(dead.rows, dead.recorded, false),
    renderLink(dead.recorded, dead.ledger, false),
  ].join("\n    ");

  const steps = [
    renderStep(live.schema, "live"),
    renderStep(live.recorded, "live"),
    renderStep(live.ledger, "live"),
    renderStep(dead.schema, "dead"),
    renderStep(dead.recorded, "dead"),
    renderStep(dead.ledger, "failed"),
  ].join("\n  ");

  const rowsLabel = `<text x="${live.rows.x + live.rows.w / 2}" y="${live.rows.y + live.rows.h + 28}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="600" fill="${COLOR_TEXT_MUTED}">Retraction rows</text>`;
  const rollbackLabel = `<text x="${(origin.x + origin.w / 2 + dead.ledger.x + dead.ledger.w / 2) / 2}" y="546" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="600" fill="${COLOR_DEAD}">the whole lane unwinds</text>`;

  return `${defs}
  <g>
    ${links}
    ${renderRollbackArc()}
  </g>
  ${renderOrigin()}
  <g>
    ${renderRows(live.rows, true)}
    ${renderRows(dead.rows, false)}
  </g>
  ${steps}
  ${rowsLabel}
  ${rollbackLabel}`;
}

/**
 * The content cover: the diagram, no title text. Shown on the page itself
 * (blog index + post header).
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

  <g transform="translate(400, 153) scale(0.66)">
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
