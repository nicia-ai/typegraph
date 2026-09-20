#!/usr/bin/env node
// Pattern: 1. Field with a lit path (see the blog-cover skill).
//
// Bespoke cover/social images for the "Durable Branches" post. The field is
// a spread of short-lived process lifetimes: muted capsules, each one ending
// in a small ×. One route is lit up across all of them: a durable branch
// that starts in one process, is handed on as a small JSON descriptor
// (`{ }`) after that process dies, is reopened in a second, then a third,
// and finally ends in an explicit `destroy`. The route only means something
// because of every capsule around it that ended without carrying anything.
//
// Why this pattern and not pattern 2 (fan): a fan draws one subject
// multiplying into many instances. Here there is exactly ONE working copy —
// the mechanism is that it persists while the processes that touch it die,
// and only one holds it at a time. A fan would also read as a duplicate of
// infinite-graph-databases.
//
// See #blog-art (scripts/lib/blog-art.mjs) for the shared
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

const SLUG = "durable-merge-branches";
const TITLE = "Durable Branches: The Working Copy Outlives the Process";

const COLOR_CAPSULE_FILL = "#cbd5e1";
const COLOR_CAPSULE_STROKE = "#94a3b8";
const COLOR_END_MARK = "#64748b";
const COLOR_PATH = "#2563eb";
const COLOR_PATH_GLOW = "#93c5fd";
const COLOR_PATH_STROKE = "#1d4ed8";
const COLOR_TEXT_DARK = "#0f172a";
const COLOR_TOKEN_FILL = "#ffffff";
const FONT_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const ROWS = [200, 245, 290, 335, 380, 425, 470, 515];
const FIELD_X_MIN = 60;
const FIELD_X_MAX = 1140;
const FIELD_CAPSULE_HEIGHT = 14;
const LIT_CAPSULE_HEIGHT = 28;
const LABEL_FONT_SIZE = 16;
const LABEL_CHAR_WIDTH = 9.8;
const KEEP_OUT_PAD = 26;

/** The three processes that hold the branch, in order. */
const LIT_CAPSULES = [
  { y: 290, x1: 110, x2: 330, label: "branchDurable" },
  { y: 470, x1: 430, x2: 650, label: "reopen" },
  { y: 335, x1: 750, x2: 930, label: "operate" },
];
const END_NODE = { x: 1090, y: 470, r: 18, label: "destroy" };

// The route: through each lit capsule, S-curving to the next one.
const ROUTE = [
  { move: [LIT_CAPSULES[0].x1, LIT_CAPSULES[0].y] },
  { line: [LIT_CAPSULES[0].x2, LIT_CAPSULES[0].y] },
  {
    curve: [
      [380, 290],
      [380, 470],
      [LIT_CAPSULES[1].x1, LIT_CAPSULES[1].y],
    ],
  },
  { line: [LIT_CAPSULES[1].x2, LIT_CAPSULES[1].y] },
  {
    curve: [
      [700, 470],
      [700, 335],
      [LIT_CAPSULES[2].x1, LIT_CAPSULES[2].y],
    ],
  },
  { line: [LIT_CAPSULES[2].x2, LIT_CAPSULES[2].y] },
  {
    curve: [
      [1010, 335],
      [1010, 470],
      [END_NODE.x, END_NODE.y],
    ],
  },
];

/** `{ }` tokens sitting on the S-curves: the descriptor in transit. */
const TOKENS = [
  { x: 380, y: 380 },
  { x: 700, y: 402 },
  { x: 1010, y: 402 },
];
const TOKEN_WIDTH = 46;
const TOKEN_HEIGHT = 28;

/**
 * Deterministic PRNG so the field is stable between runs.
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let state = seed;
  return () => {
    state = Math.imul(state + 0x6d_2b_79_f5, 1);
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * @param {string} label
 * @param {number} centerX
 * @param {number} baselineY
 * @returns {{ left: number, right: number, top: number, bottom: number }}
 */
function labelBox(label, centerX, baselineY) {
  const width = label.length * LABEL_CHAR_WIDTH;
  return {
    left: centerX - width / 2,
    right: centerX + width / 2,
    top: baselineY - LABEL_FONT_SIZE,
    bottom: baselineY + 6,
  };
}

/**
 * @param {{ y: number, x1: number, x2: number }} capsule
 * @returns {{ x: number, y: number }}
 */
function litLabelPosition(capsule) {
  return {
    x: (capsule.x1 + capsule.x2) / 2,
    y: capsule.y - LIT_CAPSULE_HEIGHT / 2 - 12,
  };
}

function endLabelPosition() {
  return { x: END_NODE.x, y: END_NODE.y + END_NODE.r + 26 };
}

function keepOutZones() {
  const zones = LIT_CAPSULES.map((capsule) => {
    const { x, y } = litLabelPosition(capsule);
    const box = labelBox(capsule.label, x, y);
    return {
      left: Math.min(capsule.x1, box.left) - KEEP_OUT_PAD,
      right: Math.max(capsule.x2, box.right) + KEEP_OUT_PAD,
      top: box.top - KEEP_OUT_PAD / 2,
      bottom: capsule.y + LIT_CAPSULE_HEIGHT / 2 + KEEP_OUT_PAD / 2,
    };
  });
  for (const { x, y } of TOKENS) {
    zones.push({
      left: x - TOKEN_WIDTH / 2 - KEEP_OUT_PAD,
      right: x + TOKEN_WIDTH / 2 + KEEP_OUT_PAD,
      top: y - TOKEN_HEIGHT / 2 - KEEP_OUT_PAD / 2,
      bottom: y + TOKEN_HEIGHT / 2 + KEEP_OUT_PAD / 2,
    });
  }
  const end = endLabelPosition();
  const endBox = labelBox(END_NODE.label, end.x, end.y);
  zones.push({
    left: endBox.left - KEEP_OUT_PAD,
    right: endBox.right + KEEP_OUT_PAD,
    top: END_NODE.y - END_NODE.r - KEEP_OUT_PAD,
    bottom: endBox.bottom + KEEP_OUT_PAD / 2,
  });
  return zones;
}

/** Muted process lifetimes: the field the lit route passes through. */
function generateFieldCapsules() {
  const random = mulberry32(20_260_920);
  const zones = keepOutZones();
  /** @type {Array<{ x1: number, x2: number, y: number }>} */
  const capsules = [];
  for (const y of ROWS) {
    let x = FIELD_X_MIN + random() * 90;
    while (x < FIELD_X_MAX - 60) {
      const length = 60 + random() * 130;
      const x2 = Math.min(x + length, FIELD_X_MAX);
      const halfHeight = FIELD_CAPSULE_HEIGHT / 2;
      const blocked = zones.some(
        (zone) =>
          x < zone.right &&
          x2 > zone.left &&
          y + halfHeight > zone.top &&
          y - halfHeight < zone.bottom,
      );
      if (!blocked) capsules.push({ x1: x, x2, y });
      x = x2 + 12 + random() * 34;
    }
  }
  return capsules;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {number} strokeWidth
 * @returns {string}
 */
function renderEndMark(x, y, size, strokeWidth) {
  return `<path d="M ${x - size} ${y - size} L ${x + size} ${y + size} M ${x - size} ${y + size} L ${x + size} ${y - size}" stroke="${COLOR_END_MARK}" stroke-width="${strokeWidth}" stroke-linecap="round" fill="none"/>`;
}

function renderFieldCapsules() {
  return generateFieldCapsules()
    .map((capsule) => {
      const width = capsule.x2 - capsule.x1;
      const top = capsule.y - FIELD_CAPSULE_HEIGHT / 2;
      return `<rect x="${capsule.x1}" y="${top}" width="${width}" height="${FIELD_CAPSULE_HEIGHT}" rx="${FIELD_CAPSULE_HEIGHT / 2}" fill="${COLOR_CAPSULE_FILL}" stroke="${COLOR_CAPSULE_STROKE}" stroke-width="1.5" opacity="0.7"/>
    ${renderEndMark(capsule.x2 - 9, capsule.y, 3.5, 1.8)}`;
    })
    .join("\n    ");
}

function renderLitCapsules() {
  return LIT_CAPSULES.map((capsule) => {
    const width = capsule.x2 - capsule.x1;
    const top = capsule.y - LIT_CAPSULE_HEIGHT / 2;
    return `<rect x="${capsule.x1}" y="${top}" width="${width}" height="${LIT_CAPSULE_HEIGHT}" rx="${LIT_CAPSULE_HEIGHT / 2}" fill="#ffffff" stroke="${COLOR_PATH}" stroke-width="2.5"/>`;
  }).join("\n    ");
}

function routePathData() {
  return ROUTE.map((step) => {
    if (step.move) return `M ${step.move[0]} ${step.move[1]}`;
    if (step.line) return `L ${step.line[0]} ${step.line[1]}`;
    const [c1, c2, end] = step.curve;
    return `C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${end[0]} ${end[1]}`;
  }).join(" ");
}

function renderRoute() {
  const d = routePathData();
  return `<path d="${d}" fill="none" stroke="${COLOR_PATH_GLOW}" stroke-width="14" stroke-linejoin="round" stroke-linecap="round" opacity="0.45"/>
    <path d="${d}" fill="none" stroke="${COLOR_PATH}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function renderLitEndMarks() {
  return LIT_CAPSULES.map((capsule) =>
    renderEndMark(capsule.x2 - 14, capsule.y - 0, 5.5, 2.6),
  ).join("\n    ");
}

function renderTokens() {
  const width = TOKEN_WIDTH;
  const height = TOKEN_HEIGHT;
  return TOKENS.map(
    ({ x, y }) =>
      `<rect x="${x - width / 2}" y="${y - height / 2}" width="${width}" height="${height}" rx="7" fill="${COLOR_TOKEN_FILL}" stroke="${COLOR_PATH}" stroke-width="2"/>
    <text x="${x}" y="${y + 6}" text-anchor="middle" font-family="${FONT_MONO}" font-size="${LABEL_FONT_SIZE}" font-weight="700" fill="${COLOR_PATH_STROKE}">{ }</text>`,
  ).join("\n    ");
}

/**
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @returns {string}
 */
function renderLabel(text, x, y) {
  return `<text x="${x}" y="${y}" text-anchor="middle" font-family="${FONT_MONO}" font-size="${LABEL_FONT_SIZE}" font-weight="700" fill="${COLOR_TEXT_DARK}">${escapeXml(text)}</text>`;
}

function renderNodesAndLabels() {
  const origin = LIT_CAPSULES[0];
  const originNode = `<circle cx="${origin.x1}" cy="${origin.y}" r="15" fill="${COLOR_PATH}" stroke="${COLOR_PATH_STROKE}" stroke-width="3"/>`;
  const endNode = `<circle cx="${END_NODE.x}" cy="${END_NODE.y}" r="${END_NODE.r}" fill="${COLOR_PATH}" stroke="${COLOR_PATH_STROKE}" stroke-width="3.5"/>
    <circle cx="${END_NODE.x}" cy="${END_NODE.y}" r="${END_NODE.r + 8}" fill="none" stroke="${COLOR_PATH_GLOW}" stroke-width="2.5"/>`;
  const litLabels = LIT_CAPSULES.map((capsule) => {
    const { x, y } = litLabelPosition(capsule);
    return renderLabel(capsule.label, x, y);
  });
  const end = endLabelPosition();
  return [
    originNode,
    endNode,
    ...litLabels,
    renderLabel(END_NODE.label, end.x, end.y),
  ].join("\n    ");
}

function renderDiagram() {
  return `<g>
    ${renderFieldCapsules()}
    ${renderLitCapsules()}
    ${renderRoute()}
    ${renderLitEndMarks()}
    ${renderTokens()}
    ${renderNodesAndLabels()}
  </g>`;
}

/** Title-free cover: shown on the blog index and at the top of the post. */
function generateCoverSvg() {
  return svgDocument(`  ${renderIllustrationBackground()}

  ${renderDiagram()}

  ${renderLogoMark()}`);
}

/** Social/OG card: title above, the same diagram scaled beneath it. */
function generateSocialSvg() {
  const { lines, fontSize } = layoutTitle(TITLE, 1000);
  const titleMarkup = renderTitleLines(lines, fontSize, {
    x: 90,
    centerY: CONTENT_SAFE_TOP + 60,
  });

  return svgDocument(`  ${renderIllustrationBackground()}

  <g transform="translate(60, 235) scale(0.6)">
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
