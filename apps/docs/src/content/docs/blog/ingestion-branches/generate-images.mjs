#!/usr/bin/env node
// PATTERN: streams converging on a record (see .claude/skills/blog-cover/SKILL.md).
//
// Cover/social images for "Ingestion Branches". An untrusted feed arrives
// carrying an alias that repeats a canonical patient's MRN. On an ordinary
// branch the duplicate is rejected during staging, before entity resolution
// ever sees it. `ingestionBranch()` defers node uniqueness so the duplicate
// and the identity evidence explaining it can be staged together and
// validated as one set at merge.
//
// The mechanism is entirely a matter of WHERE the gate sits, so the two
// lanes are identical except for that: the top lane's fence stands at
// staging and the feed stops dead against it; the bottom lane's fence stands
// at merge, and the feed reaches it carrying the evidence it picked up on
// the way. Both lanes run the full width, so the distance the lower feed
// travels — and what it gathers over that distance — is the payload.
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

const SLUG = "ingestion-branches";
const TITLE = "Ingestion Branches: Staging the Duplicate You Came to Resolve";

const COLOR_FEED = "#9db8dd";
const COLOR_FEED_LINE = "#6698d8";
const COLOR_DUP = "#d97706";
const COLOR_EVIDENCE = "#1d4ed8";
const COLOR_STOP = "#dc2626";
const COLOR_PASS = "#1d4ed8";
const COLOR_PASS_GLOW = "#93c5fd";
const COLOR_TEXT = "#0f172a";
const COLOR_MUTED_TEXT = "#64748b";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const LANE_LEFT = 140;
const ORDINARY_Y = 268;
const INGESTION_Y = 452;
const STAGING_X = 470;
const MERGE_X = 905;

/**
 * @param {number} y
 * @param {number} until
 * @param {number} count
 * @returns {string}
 */
function renderFeed(y, until, count) {
  const span = until - LANE_LEFT - 30;
  return Array.from({ length: count }, (unused, index) => {
    const x = LANE_LEFT + 18 + (index / (count - 1)) * span;
    return `<circle cx="${x.toFixed(1)}" cy="${y}" r="8" fill="${COLOR_FEED}" stroke="#ffffff" stroke-width="2"/>`;
  }).join("\n    ");
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const ordinary = `<line x1="${LANE_LEFT}" y1="${ORDINARY_Y}" x2="${STAGING_X - 16}" y2="${ORDINARY_Y}" stroke="${COLOR_FEED_LINE}" stroke-width="2.5" opacity="0.55"/>
    ${renderFeed(ORDINARY_Y, STAGING_X - 16, 5)}
    <circle cx="${STAGING_X - 48}" cy="${ORDINARY_Y}" r="11" fill="${COLOR_DUP}" stroke="#ffffff" stroke-width="2"/>
    <rect x="${STAGING_X - 5}" y="${ORDINARY_Y - 62}" width="10" height="124" rx="5" fill="${COLOR_STOP}"/>
    <text x="${STAGING_X + 26}" y="${ORDINARY_Y + 6}" font-family="${SANS}" font-size="18" font-weight="700" fill="${COLOR_STOP}">rejected during staging</text>
    <text x="${LANE_LEFT}" y="${ORDINARY_Y - 42}" font-family="${MONO}" font-size="18" font-weight="700" fill="${COLOR_TEXT}">ordinary branch</text>`;

  // The lower lane runs the full width, gathering the identity evidence that
  // explains the duplicate before anything is validated.
  const evidenceX = [610, 700, 790];
  const evidence = evidenceX
    .map(
      (x) =>
        `<circle cx="${x}" cy="${INGESTION_Y}" r="10" fill="${COLOR_EVIDENCE}" stroke="#ffffff" stroke-width="2"/>`,
    )
    .join("\n    ");

  const ingestion = `<line x1="${LANE_LEFT}" y1="${INGESTION_Y}" x2="${MERGE_X - 16}" y2="${INGESTION_Y}" stroke="${COLOR_FEED_LINE}" stroke-width="2.5" opacity="0.55"/>
    ${renderFeed(INGESTION_Y, STAGING_X + 30, 5)}
    <circle cx="${STAGING_X - 20}" cy="${INGESTION_Y}" r="11" fill="${COLOR_DUP}" stroke="#ffffff" stroke-width="2"/>
    <line x1="${STAGING_X}" y1="${INGESTION_Y - 52}" x2="${STAGING_X}" y2="${INGESTION_Y + 52}" stroke="${COLOR_MUTED_TEXT}" stroke-width="3" stroke-dasharray="7 7" opacity="0.6"/>
    <text x="${STAGING_X + 18}" y="${INGESTION_Y - 62}" font-family="${MONO}" font-size="16" fill="${COLOR_MUTED_TEXT}">uniqueness deferred</text>
    ${evidence}
    <text x="${evidenceX[1]}" y="${INGESTION_Y + 38}" text-anchor="middle" font-family="${MONO}" font-size="16" font-weight="600" fill="${COLOR_EVIDENCE}">identity evidence</text>
    <rect x="${MERGE_X - 5}" y="${INGESTION_Y - 62}" width="10" height="124" rx="5" fill="${COLOR_PASS_GLOW}"/>
    <rect x="${MERGE_X - 3}" y="${INGESTION_Y - 62}" width="6" height="124" rx="3" fill="${COLOR_PASS}"/>
    <text x="${MERGE_X + 22}" y="${INGESTION_Y - 32}" font-family="${SANS}" font-size="18" font-weight="700" fill="${COLOR_PASS}">validated</text>
    <text x="${MERGE_X + 22}" y="${INGESTION_Y - 8}" font-family="${SANS}" font-size="18" font-weight="700" fill="${COLOR_PASS}">as one set</text>
    <text x="${LANE_LEFT}" y="${INGESTION_Y - 42}" font-family="${MONO}" font-size="18" font-weight="700" fill="${COLOR_TEXT}">ingestionBranch()</text>`;

  const dupKey = `<text x="${LANE_LEFT}" y="${INGESTION_Y + 96}" font-family="${SANS}" font-size="17" font-weight="600" fill="${COLOR_DUP}">the duplicate MRN you came to resolve</text>`;

  return `${ordinary}\n    ${ingestion}\n    ${dupKey}`;
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
  <g transform="translate(350, 130) scale(0.53)">
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
