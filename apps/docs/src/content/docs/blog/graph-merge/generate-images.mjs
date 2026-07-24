#!/usr/bin/env node
// Bespoke cover/social images for the "Graph Merge" post — NOT a generic
// template. Two rows, same real mechanism (block by birthDate, then decide
// by fulltext name similarity against a 0.78 threshold), opposite outcomes —
// both drawn from real fixtures:
//
//   - NO MERGE: "Zoe Adams" / "Quinn Webb" (tests/graph-merge/sources.test.ts)
//     share a birthDate block but score ~0 similarity — miles below
//     threshold, so they stay two distinct patients. Connectors stop short
//     and cross into a red X instead of continuing into a canonical card.
//   - MERGE: "Mohammed Ali" / "Mohamed Ali" (examples/18-fhir-graph-merge.ts)
//     share a birthDate block AND clear the 0.78 threshold, so their
//     connectors taper into one canonical card — a literal visual merge
//     (the git-graph / river-confluence shape).
//
// Showing the rejection alongside the merge is the point: merge() isn't
// "collapse anything similar-looking", it's a threshold decision that
// correctly leaves most candidate pairs alone. See the blog-cover skill's
// "Draw the mechanism the title names" rule.
//
// See ../hybrid-search/generate-images.mjs for the sibling bespoke script
// this one follows the pattern of, and #blog-art
// (scripts/lib/blog-art.mjs) for the shared canvas/logo/background/title
// primitives.
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

import process from "node:process";

import {
  CONTENT_SAFE_TOP,
  escapeXml,
  layoutTitle,
  parseOutDirArgument,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "#blog-art";

const SLUG = "graph-merge";
const TITLE = "Graph Merge: Same Patient, Two Feeds, One Canonical Record";

const COLOR_EHR = "#3b82f6";
const COLOR_CLAIMS = "#1e40af";
const COLOR_CANONICAL_FILL = "#2563eb";
const COLOR_CANONICAL_STROKE = "#1d4ed8";
const COLOR_TEXT_MUTED = "#64748b";
const COLOR_TEXT_DARK = "#0f172a";
const COLOR_REJECT_STROKE = "#94a3b8";
const COLOR_REJECT_X = "#dc2626";

/**
 * @typedef {{
 *   kind: "no-merge" | "merge";
 *   ehrName: string;
 *   claimsName: string;
 *   birthDate: string;
 *   canonicalName?: string;
 *   rowTop: number;
 *   reason: string;
 * }} MergeRow
 */

const CARD_H = 60;
const CURVE_ZONE = 52;
const EHR_W = 220;
const CLAIMS_W = 220;
const CANONICAL_W = 260;
const EHR_X = 90;
const CLAIMS_X = 890;
const CANONICAL_X =
  (EHR_X + EHR_W / 2 + (CLAIMS_X + CLAIMS_W / 2)) / 2 - CANONICAL_W / 2;
const MERGE_X = CANONICAL_X + CANONICAL_W / 2;

/** @type {MergeRow[]} */
const ROWS = [
  {
    kind: "no-merge",
    ehrName: "Zoe Adams",
    claimsName: "Quinn Webb",
    birthDate: "2000-01-01",
    rowTop: 172,
    reason: "same birthDate block — similarity ~0 → stays separate",
  },
  {
    kind: "merge",
    ehrName: "Mohammed Ali",
    claimsName: "Mohamed Ali",
    canonicalName: "Mohamed Ali",
    birthDate: "1990-08-21",
    rowTop: 392,
    reason: "same birthDate block — similarity ≥ 0.78 → merges",
  },
];

/**
 * @param {{ x: number; y: number; w: number; name: string; subtitle: string; fill: string; stroke: string; textColor: string; dashed?: boolean }} options
 * @returns {string}
 */
function renderCard({
  x,
  y,
  w,
  name,
  subtitle,
  fill,
  stroke,
  textColor,
  dashed = false,
}) {
  const centerX = x + w / 2;
  const nameY = y + CARD_H / 2 - 4;
  const subtitleY = y + CARD_H / 2 + 18;
  const dash = dashed ? ' stroke-dasharray="6 5"' : "";
  return `<rect x="${x}" y="${y}" width="${w}" height="${CARD_H}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="2"${dash}/>
    <text x="${centerX}" y="${nameY}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="17" font-weight="700" fill="${textColor}">${escapeXml(name)}</text>
    <text x="${centerX}" y="${subtitleY}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" fill="${textColor}" opacity="0.85">${escapeXml(subtitle)}</text>`;
}

/**
 * A connector that tapers into a single shared point — both source cards'
 * connectors terminate at the exact same (x2, y2), so the two curves
 * visually converge into one line, instead of landing on two different
 * sides of a box. Leaves each start point vertically and arrives at the
 * shared point vertically, for a clean funnel/confluence shape.
 * @param {{ x1: number; y1: number; x2: number; y2: number; color: string; dashed?: boolean }} options
 * @returns {string}
 */
function renderMergeConnector({ x1, y1, x2, y2, color, dashed = false }) {
  const midY = (y1 + y2) / 2;
  const dash = dashed ? ' stroke-dasharray="6 5"' : "";
  return `<path d="M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="3" opacity="0.8"${dash}/>`;
}

/**
 * @param {MergeRow} row
 * @returns {string}
 */
function renderMergeRow(row) {
  const ehrCard = renderCard({
    x: EHR_X,
    y: row.rowTop,
    w: EHR_W,
    name: row.ehrName,
    subtitle: row.birthDate,
    fill: "#ffffff",
    stroke: COLOR_EHR,
    textColor: COLOR_TEXT_DARK,
  });
  const claimsCard = renderCard({
    x: CLAIMS_X,
    y: row.rowTop,
    w: CLAIMS_W,
    name: row.claimsName,
    subtitle: row.birthDate,
    fill: "#ffffff",
    stroke: COLOR_CLAIMS,
    textColor: COLOR_TEXT_DARK,
  });

  const canonicalY = row.rowTop + CARD_H + CURVE_ZONE;
  const canonicalCard = renderCard({
    x: CANONICAL_X,
    y: canonicalY,
    w: CANONICAL_W,
    name: row.canonicalName ?? "",
    subtitle: row.birthDate,
    fill: COLOR_CANONICAL_FILL,
    stroke: COLOR_CANONICAL_STROKE,
    textColor: "#ffffff",
  });

  // Both connectors converge on this exact point: the top-center of the
  // canonical card. That shared endpoint is what makes the two curves read
  // as one merge instead of two unrelated lines.
  const mergeY = canonicalY;
  const ehrConnector = renderMergeConnector({
    x1: EHR_X + EHR_W / 2,
    y1: row.rowTop + CARD_H,
    x2: MERGE_X,
    y2: mergeY,
    color: COLOR_EHR,
  });
  const claimsConnector = renderMergeConnector({
    x1: CLAIMS_X + CLAIMS_W / 2,
    y1: row.rowTop + CARD_H,
    x2: MERGE_X,
    y2: mergeY,
    color: COLOR_CLAIMS,
  });
  const mergePoint = `<circle cx="${MERGE_X}" cy="${mergeY}" r="5" fill="${COLOR_CANONICAL_STROKE}"/>`;

  const reasonY = canonicalY + CARD_H + 22;
  const reason = `<text x="${MERGE_X}" y="${reasonY}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="600" fill="${COLOR_TEXT_MUTED}">${escapeXml(row.reason)}</text>`;

  return `${ehrConnector}\n    ${claimsConnector}\n    ${mergePoint}\n    ${ehrCard}\n    ${claimsCard}\n    ${canonicalCard}\n    ${reason}`;
}

/**
 * The rejected pair's connectors stop short of the canonical row's height
 * and cross into an X instead — no third card, because nothing survives as
 * canonical. Muted, dashed cards signal "this pairing was considered and
 * let go" rather than "this is the live state," the same visual language
 * the graph-algorithms post uses for a not-taken path.
 * @param {MergeRow} row
 * @returns {string}
 */
function renderNoMergeRow(row) {
  const ehrCard = renderCard({
    x: EHR_X,
    y: row.rowTop,
    w: EHR_W,
    name: row.ehrName,
    subtitle: row.birthDate,
    fill: "#ffffff",
    stroke: COLOR_REJECT_STROKE,
    textColor: COLOR_TEXT_MUTED,
    dashed: true,
  });
  const claimsCard = renderCard({
    x: CLAIMS_X,
    y: row.rowTop,
    w: CLAIMS_W,
    name: row.claimsName,
    subtitle: row.birthDate,
    fill: "#ffffff",
    stroke: COLOR_REJECT_STROKE,
    textColor: COLOR_TEXT_MUTED,
    dashed: true,
  });

  // Connectors converge on the same point a canonical card would occupy,
  // then stop — an X marks where the merge would have happened.
  const xY = row.rowTop + CARD_H + CURVE_ZONE / 2 + 8;
  const ehrConnector = renderMergeConnector({
    x1: EHR_X + EHR_W / 2,
    y1: row.rowTop + CARD_H,
    x2: MERGE_X,
    y2: xY,
    color: COLOR_REJECT_STROKE,
    dashed: true,
  });
  const claimsConnector = renderMergeConnector({
    x1: CLAIMS_X + CLAIMS_W / 2,
    y1: row.rowTop + CARD_H,
    x2: MERGE_X,
    y2: xY,
    color: COLOR_REJECT_STROKE,
    dashed: true,
  });
  const xSize = 11;
  const rejectX = `<g stroke="${COLOR_REJECT_X}" stroke-width="4" stroke-linecap="round">
    <line x1="${MERGE_X - xSize}" y1="${xY - xSize}" x2="${MERGE_X + xSize}" y2="${xY + xSize}"/>
    <line x1="${MERGE_X - xSize}" y1="${xY + xSize}" x2="${MERGE_X + xSize}" y2="${xY - xSize}"/>
  </g>`;

  const reasonY = xY + CARD_H;
  const reason = `<text x="${MERGE_X}" y="${reasonY}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="600" fill="${COLOR_REJECT_X}">${escapeXml(row.reason)}</text>`;

  return `${ehrConnector}\n    ${claimsConnector}\n    ${rejectX}\n    ${ehrCard}\n    ${claimsCard}\n    ${reason}`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const firstRowTop = ROWS[0].rowTop;
  const ehrLabel = `<text x="${EHR_X}" y="${firstRowTop - 18}" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="700" fill="${COLOR_TEXT_DARK}" letter-spacing="1">EHR BRANCH</text>`;
  const claimsLabel = `<text x="${CLAIMS_X + CLAIMS_W}" y="${firstRowTop - 18}" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="700" fill="${COLOR_TEXT_DARK}" letter-spacing="1">CLAIMS BRANCH</text>`;

  const rows = ROWS.map((row) =>
    row.kind === "merge" ? renderMergeRow(row) : renderNoMergeRow(row),
  ).join("\n    ");

  return `<g>
    ${ehrLabel}
    ${claimsLabel}
    ${rows}
  </g>`;
}

/**
 * The content cover: the merge diagram, no title text. Shown on the page
 * itself (blog index + post header).
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/**
 * The social/OG card: title on top, diagram scaled down and centered
 * below it. Only used for og:image / twitter:image — never rendered on
 * the page.
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 1000);
  const titleMarkup = renderTitleLines(lines, fontSize, {
    x: 90,
    centerY: CONTENT_SAFE_TOP + 60,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(230, 195) scale(0.62)">
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
