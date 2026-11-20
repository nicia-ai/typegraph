// Shared rendering primitives for blog cover/social images: canvas size,
// the logo mark, the illustration background, and title-text layout. Used
// by both the generic seeded-graph generator (generate-blog-images.mjs) and
// per-post bespoke diagram generators (e.g. generate-provenance-diagram.mjs).
// Keeping this shared means every generated image — abstract or
// content-specific — carries the same logo, background, and typography.
//
// One canvas, one light background — no separate dark band. The logo uses
// the same dark-on-light color scheme as src/assets/logo-light.svg (the
// site's own light-background logo variant), so it sits directly on the
// illustration background without a wash-out risk. Diagram content keeps
// clear of the top-left corner (see CONTENT_SAFE_TOP) so it never collides
// with the logo.

import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export const CANVAS_WIDTH = 1200;
export const CANVAS_HEIGHT = 630;
export const MARGIN_X = 90;
// Diagram/title content should start below this to stay clear of the logo.
export const CONTENT_SAFE_TOP = 150;

const MAX_TITLE_LINES = 3;
const AVG_CHAR_WIDTH_EM = 0.56;
/** @type {readonly number[]} */
const CANDIDATE_FONT_SIZES = [56, 48, 42, 36, 32];
const FALLBACK_FONT_SIZE = 32;

/**
 * @param {string} text
 * @returns {string}
 */
export function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * @param {string} bodyMarkup
 * @returns {string}
 */
export function svgDocument(bodyMarkup) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}">
${bodyMarkup}
</svg>
`;
}

/**
 * @returns {string}
 */
function renderDefs() {
  return `<defs>
    <linearGradient id="illustration-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#eff6ff"/>
      <stop offset="1" stop-color="#f8fafc"/>
    </linearGradient>
    <radialGradient id="illustration-glow" cx="0.85" cy="0.1" r="0.8">
      <stop offset="0" stop-color="#93c5fd" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#93c5fd" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

/**
 * The canvas background: a light gradient with a soft blue highlight,
 * covering the full canvas. Includes the shared gradient defs, since this
 * is always the first thing every generator renders — callers never need
 * to remember a separate defs call.
 * @returns {string}
 */
export function renderIllustrationBackground() {
  return `${renderDefs()}
  <rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="url(#illustration-bg)"/>
  <rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="url(#illustration-glow)"/>`;
}

/**
 * The logo mark + "TypeGraph" wordmark, in the same dark-on-light colors as
 * src/assets/logo-light.svg. Sits directly on the illustration background
 * near the top-left corner — no separate band.
 * @returns {string}
 */
export function renderLogoMark() {
  return `<g transform="translate(${MARGIN_X}, 60) scale(0.62)">
    <g stroke="#3178c6" stroke-width="3" stroke-linecap="round">
      <line x1="50" y1="35" x2="50" y2="10"/>
      <line x1="65" y1="58" x2="88" y2="70"/>
      <line x1="35" y1="58" x2="12" y2="82"/>
    </g>
    <polygon points="50,30 68,42 68,62 50,74 32,62 32,42" fill="#3178c6"/>
    <text x="50" y="58" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="white" text-anchor="middle">TS</text>
    <circle cx="50" cy="10" r="10" fill="#6aaccc"/>
    <circle cx="88" cy="70" r="9" fill="#4080a8"/>
    <circle cx="12" cy="82" r="11" fill="#1a3a6c"/>
  </g>
  <text x="${MARGIN_X + 52}" y="94" font-family="system-ui, -apple-system, sans-serif" font-size="26" font-weight="700" fill="#1e293b">TypeGraph</text>`;
}

/**
 * @param {string} title
 * @param {number} fontSize
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapTitle(title, fontSize, maxWidth) {
  const maxCharsPerLine = Math.floor(maxWidth / (fontSize * AVG_CHAR_WIDTH_EM));
  const words = title.split(" ");
  /** @type {string[]} */
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length > maxCharsPerLine && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = candidate;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}

/**
 * @param {string} title
 * @param {number} [maxWidth]
 * @returns {{ lines: string[]; fontSize: number }}
 */
export function layoutTitle(title, maxWidth = CANVAS_WIDTH - MARGIN_X * 2) {
  for (const fontSize of CANDIDATE_FONT_SIZES) {
    const lines = wrapTitle(title, fontSize, maxWidth);
    if (lines.length <= MAX_TITLE_LINES) {
      return { lines, fontSize };
    }
  }
  return {
    lines: wrapTitle(title, FALLBACK_FONT_SIZE, maxWidth),
    fontSize: FALLBACK_FONT_SIZE,
  };
}

/**
 * Renders title text for the social card. Dark fill by default, since it
 * always sits on the light illustration background.
 * @param {string[]} lines
 * @param {number} fontSize
 * @param {{ x?: number; centerY?: number; color?: string }} [options]
 * @returns {string}
 */
export function renderTitleLines(lines, fontSize, options = {}) {
  const {
    x = MARGIN_X,
    centerY = CONTENT_SAFE_TOP + (CANVAS_HEIGHT - CONTENT_SAFE_TOP) / 2,
    color = "#0f172a",
  } = options;
  const lineHeight = fontSize * 1.2;
  const startY = centerY - ((lines.length - 1) * lineHeight) / 2;

  return lines
    .map((line, index) => {
      const y = startY + index * lineHeight;
      return `<text x="${x}" y="${y}" font-size="${fontSize}" font-weight="800" fill="${color}" letter-spacing="-1">${escapeXml(line)}</text>`;
    })
    .join("\n    ");
}

/**
 * Every generator script's CLI accepts the same `--out-dir` flag (default
 * `.`). Shared so each per-post `generate-images.mjs` doesn't hand-roll its
 * own copy of this loop.
 * @param {readonly string[]} argv
 * @returns {string | undefined}
 */
export function parseOutDirArgument(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out-dir") return argv[index + 1];
  }
  return;
}

/**
 * Writes a post's two already-rendered SVG strings to `<slug>-cover.svg` /
 * `<slug>-social.svg` under `outDir` and prints a "Wrote ..." summary —
 * the tail every generator script's `main()` otherwise duplicates. The
 * slug prefix (not just `cover.svg`/`social.svg`) matters even though each
 * post now has its own folder: the rasterization workflow stages every
 * post's SVGs into one shared scratch directory (see the blog-cover
 * skill), where an unprefixed name would collide across posts generated
 * back to back.
 * @param {{ slug: string; outDir: string | undefined; coverSvg: string; socialSvg: string }} options
 * @returns {void}
 */
export function writeBlogImages({ slug, outDir, coverSvg, socialSvg }) {
  const resolvedOutDir = outDir ?? ".";
  const coverPath = path.join(resolvedOutDir, `${slug}-cover.svg`);
  const socialPath = path.join(resolvedOutDir, `${slug}-social.svg`);

  writeFileSync(coverPath, coverSvg);
  writeFileSync(socialPath, socialSvg);
  process.stdout.write(`Wrote ${coverPath}\nWrote ${socialPath}\n`);
}

/**
 * A cubic-bezier S-curve connecting two points, used by every bespoke
 * diagram that shows something flowing from one card/node to another
 * (branches converging on a canonical record, sources feeding a fused
 * result, etc.). Horizontal midpoint control points give the curve its
 * characteristic S shape regardless of how far apart the endpoints are.
 * @param {{ x1: number; y1: number; x2: number; y2: number; color: string; opacity?: number; strokeWidth?: number }} options
 * @returns {string}
 */
export function renderConnector({
  x1,
  y1,
  x2,
  y2,
  color,
  opacity = 0.7,
  strokeWidth = 2.5,
}) {
  const midX = (x1 + x2) / 2;
  return `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
}

/**
 * The left/right mid-edge anchor points of a `{x, y, w, h}` box node, for
 * attaching a `renderConnector()` to a card/node's side rather than its
 * center.
 * @param {{ x: number; y: number; w: number; h: number }} box
 * @returns {{ x: number; y: number }}
 */
export function leftAnchor(box) {
  return { x: box.x, y: box.y + box.h / 2 };
}

/**
 * @param {{ x: number; y: number; w: number; h: number }} box
 * @returns {{ x: number; y: number }}
 */
export function rightAnchor(box) {
  return { x: box.x + box.w, y: box.y + box.h / 2 };
}

/**
 * Palette for the measured-comparison cover pattern. The two steps are one
 * hue light-to-dark, because a before/after pair is two readings of the
 * same measure, not two identities — and they were checked with the
 * dataviz skill's validator rather than picked by eye: both sit inside the
 * lightness band, clear the chroma floor, and separate by ΔE 21.4 normal /
 * 15.5 tritan (target 8). `BAR_BEFORE` lands at 2.9:1 against the pale
 * canvas rather than 3:1, which the validator permits only when every mark
 * carries a visible label — `renderBarComparison()` therefore labels every
 * bar, and that relief is load-bearing, not decoration.
 */
const BAR_BEFORE = "#6698d8";
const BAR_AFTER = "#1d4ed8";
const BAR_AXIS = "#cbd5e1";

const BAR_HEIGHT = 20;
const BAR_GAP = 5;
const BAR_ROW_STRIDE = 120;
const BAR_MIN_WIDTH = 6;
const BAR_LABEL_SIZE = 18;
const BAR_VALUE_SIZE = 18;
const BAR_LEGEND_SIZE = 16;
// SVG defaults to a serif face; every text node here states its own family.
const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const BAR_RADIUS = 4;

/**
 * @param {{ label: string; text: string; value: number; y: number; x: number; maxWidth: number; scale: number; color: string }} bar
 * @returns {string}
 */
function renderComparisonBar({
  label,
  text,
  value,
  y,
  x,
  maxWidth,
  scale,
  color,
}) {
  const width = Math.max(BAR_MIN_WIDTH, (value / scale) * maxWidth);
  return `<rect x="${x}" y="${y}" width="${width.toFixed(1)}" height="${BAR_HEIGHT}" rx="${BAR_RADIUS}" fill="${color}"/>
    <text x="${(x + width + 12).toFixed(1)}" y="${y + BAR_HEIGHT - 3}" font-size="${BAR_VALUE_SIZE}" font-family="${MONO}" font-weight="600" fill="#0f172a">${escapeXml(text)}</text>
    <title>${escapeXml(`${label}: ${text}`)}</title>`;
}

/**
 * The measured-comparison cover pattern: paired before/after bars, one pair
 * per metric. Each pair is scaled to its OWN larger value, so a row reads as
 * "how far did this move" and works whether the metric got smaller (latency)
 * or larger (throughput). Rows are deliberately not comparable to each other
 * — they are separate measures, and forcing them onto one scale would bury
 * every small number under the largest.
 *
 * Keep to three rows: a fourth pushes value labels into the footer band the
 * cover lint rejects.
 *
 * @param {{
 *   rows: readonly { label: string; beforeValue: number; beforeText: string; afterValue: number; afterText: string }[];
 *   beforeLabel: string;
 *   afterLabel: string;
 *   x?: number;
 *   top?: number;
 *   labelWidth?: number;
 *   barMaxWidth?: number;
 * }} options
 * @returns {string}
 */
export function renderBarComparison({
  rows,
  beforeLabel,
  afterLabel,
  x = MARGIN_X,
  top = 248,
  labelWidth = 250,
  barMaxWidth = 560,
}) {
  const barX = x + labelWidth;
  const legendY = top - 45;

  const legend = `<g>
    <rect x="${barX}" y="${legendY - 11}" width="14" height="14" rx="3" fill="${BAR_BEFORE}"/>
    <text x="${barX + 22}" y="${legendY}" font-size="${BAR_LEGEND_SIZE}" font-family="${SANS}" fill="#64748b">${escapeXml(beforeLabel)}</text>
    <rect x="${barX + 130}" y="${legendY - 11}" width="14" height="14" rx="3" fill="${BAR_AFTER}"/>
    <text x="${barX + 152}" y="${legendY}" font-size="${BAR_LEGEND_SIZE}" font-family="${SANS}" fill="#64748b">${escapeXml(afterLabel)}</text>
  </g>`;

  const body = rows
    .map((row, index) => {
      const rowTop = top + index * BAR_ROW_STRIDE;
      const scale = Math.max(row.beforeValue, row.afterValue);
      const beforeY = rowTop;
      const afterY = rowTop + BAR_HEIGHT + BAR_GAP;

      return `<g>
    <text x="${x}" y="${rowTop - 12}" font-size="${BAR_LABEL_SIZE}" font-family="${SANS}" font-weight="600" fill="#0f172a">${escapeXml(row.label)}</text>
    <line x1="${barX - 10}" y1="${beforeY - 4}" x2="${barX - 10}" y2="${afterY + BAR_HEIGHT + 4}" stroke="${BAR_AXIS}" stroke-width="2"/>
    ${renderComparisonBar({ label: beforeLabel, text: row.beforeText, value: row.beforeValue, y: beforeY, x: barX, maxWidth: barMaxWidth, scale, color: BAR_BEFORE })}
    ${renderComparisonBar({ label: afterLabel, text: row.afterText, value: row.afterValue, y: afterY, x: barX, maxWidth: barMaxWidth, scale, color: BAR_AFTER })}
  </g>`;
    })
    .join("\n  ");

  return `${legend}\n  ${body}`;
}
