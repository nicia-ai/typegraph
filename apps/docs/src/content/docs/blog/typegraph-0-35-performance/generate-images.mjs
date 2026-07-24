#!/usr/bin/env node
// Bespoke cover/social images for the "TypeGraph 0.35" performance release
// post — NOT a generic template. A stat-card grid, not a relationship
// diagram like the other bespoke scripts: this post rounds up ~35 discrete
// performance fixes, so the honest visual is a curated sample of six
// directly-quoted before/after numbers from the actual 0.35.0 changeset
// text, not a single worked example to diagram.
//
// The scaling-fix card (SQLite bulk-load statistics refresh) is
// deliberately NOT a numeric ratio like the other five: the "before" case
// never finished (an unbounded O(n^2) blowup at 2M rows), and the "after"
// number is a reproduction at a smaller (100k-row) scale — presenting
// those as a single "Nx faster" ratio would misrepresent two different
// scales as one measurement. It gets its own badge style instead.
//
// See ../graph-merge/generate-images.mjs for the sibling bespoke script
// this one borrows the card/connector primitives' spirit from, and
// #blog-art (scripts/lib/blog-art.mjs) for the shared
// canvas/logo/background/title primitives.
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

const SLUG = "typegraph-0-35-performance";
const TITLE = "TypeGraph 0.35: A Performance Release";

const COLOR_CARD_STROKE = "#1d4ed8";
const COLOR_BADGE_FILL = "#1e40af";
const COLOR_TEXT_MUTED = "#64748b";
const COLOR_TEXT_DARK = "#0f172a";

/**
 * @typedef {{ title: string; before: string; after: string; badge: string }} StatCard
 */

// Every number here is quoted verbatim (or, where noted, a directly
// computed ratio) from the real 0.35.0 changeset text — see the blog post
// body for the PR references. `before`/`after` are kept short (dropping
// units like "rows/s" that the card title already implies) so every card
// but the last can share one fixed, large font size — see
// FIXED_NUMBERS_FONT_SIZE below.
/** @type {StatCard[]} */
const CARDS = [
  {
    title: "Repeated point query",
    before: "47µs",
    after: "2.4µs",
    badge: "~20× faster",
  },
  {
    title: "Bulk node/edge creation",
    before: "1,600",
    after: "4,100",
    badge: "~2.6× faster",
  },
  {
    title: "importGraph()",
    before: "26k",
    after: "96k",
    badge: "~4× faster",
  },
  {
    title: "Cascade delete (50 edges)",
    before: "24.4ms",
    after: "3.6ms",
    badge: "~6.8× faster",
  },
  {
    title: "Approximate vector search",
    before: "174ms",
    after: "2.1ms",
    badge: "~83× faster",
  },
  {
    title: "SQLite bulk-load stats refresh",
    before: "2M: stalled",
    after: "100k: ~8s",
    badge: "O(n²) → O(n)",
  },
];

const CARD_W = 300;
const CARD_H = 205;
const GAP_X = 60;
const GAP_Y = 25;
const GRID_X = 90;
const GRID_Y = 170;
const NUMBERS_MAX_WIDTH = CARD_W - 48;
/** @type {readonly number[]} */
const NUMBERS_CANDIDATE_SIZES = [30, 27, 24, 21, 18];
// Monospace average advance width as a fraction of font-size (Menlo/SFMono).
const MONO_CHAR_WIDTH_EM = 0.62;
// Every card shares this size except the last: "2M: stalled → 100k: ~8s"
// describes two different scales (see the module comment above) and is
// simply longer than the other five before/after pairs — forcing it to
// the same fixed size would either overflow or force every OTHER card
// down to accommodate it. It falls back to fitNumbersFontSize() instead.
const FIXED_NUMBERS_FONT_SIZE = 27;

/**
 * @param {number} index
 * @returns {{ x: number; y: number }}
 */
function cardPosition(index) {
  const column = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: GRID_X + column * (CARD_W + GAP_X),
    y: GRID_Y + row * (CARD_H + GAP_Y),
  };
}

/**
 * Picks the largest candidate font size whose rendered width (text plus
 * the " → " separator) still fits within the card's available width,
 * so a short pair ("47µs → 2.4µs") reads large and a longer one ("2M:
 * stalled → 100k: ~8s") shrinks just enough to stay on one line.
 * @param {string} combined
 * @returns {number}
 */
function fitNumbersFontSize(combined) {
  for (const size of NUMBERS_CANDIDATE_SIZES) {
    if (combined.length * size * MONO_CHAR_WIDTH_EM <= NUMBERS_MAX_WIDTH) {
      return size;
    }
  }
  return NUMBERS_CANDIDATE_SIZES.at(-1);
}

/**
 * @param {StatCard} card
 * @param {number} index
 * @returns {string}
 */
function renderCard(card, index) {
  const { x, y } = cardPosition(index);
  const centerX = x + CARD_W / 2;

  const titleY = y + 36;
  const numbersY = y + 118;
  const badgeY = y + CARD_H - 36;
  const badgeH = 44;

  const combined = `${card.before} → ${card.after}`;
  const isLastCard = index === CARDS.length - 1;
  const fontSize =
    isLastCard ? fitNumbersFontSize(combined) : FIXED_NUMBERS_FONT_SIZE;

  return `<rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="12" fill="#ffffff" stroke="${COLOR_CARD_STROKE}" stroke-width="2"/>
    <text x="${centerX}" y="${titleY}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="17" font-weight="700" fill="${COLOR_TEXT_DARK}">${escapeXml(card.title)}</text>
    <text x="${centerX}" y="${numbersY}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${fontSize}" font-weight="700" fill="${COLOR_TEXT_DARK}"><tspan fill="${COLOR_TEXT_MUTED}" font-weight="500">${escapeXml(card.before)}</tspan> &#8594; ${escapeXml(card.after)}</text>
    <rect x="${x + 20}" y="${badgeY - badgeH / 2}" width="${CARD_W - 40}" height="${badgeH}" rx="8" fill="${COLOR_BADGE_FILL}"/>
    <text x="${centerX}" y="${badgeY + 6}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="800" fill="#ffffff">${escapeXml(card.badge)}</text>`;
}

/**
 * @returns {string}
 */
function renderDiagram() {
  const cards = CARDS.map((card, index) => renderCard(card, index)).join(
    "\n    ",
  );

  return `<g>
    ${cards}
  </g>`;
}

/**
 * The content cover: the stat-card grid, no title text. Shown on the page
 * itself (blog index + post header).
 * @returns {string}
 */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/**
 * The social/OG card: title on top, stat-card grid scaled down and
 * centered below it. Only used for og:image / twitter:image — never
 * rendered on the page.
 * @returns {string}
 */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 1000);
  const titleMarkup = renderTitleLines(lines, fontSize, {
    x: 90,
    centerY: CONTENT_SAFE_TOP + 60,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(150, 210) scale(0.6)">
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
