#!/usr/bin/env node
// PATTERN: field with a lit path (see .claude/skills/blog-cover/SKILL.md).
//
// Cover/social images for "Claim Relations". A declared constraint used to
// be enforced by whoever held the per-graph write lock, which importGraph
// never takes. Each axis is now reserved in a claim relation whose primary
// key admits exactly one live claimant, so the fence holds for lock-free
// writers too.
//
// The field is concurrent writers, importGraph among them and drawn no
// differently from the rest — that sameness is the point, since the whole
// change is that holding the lock stopped mattering. Each axis is a slot,
// and exactly one line per slot reaches it while the others stop short at a
// cross. One claimant per axis, whoever asked.
//
// The three axes are the post's own: uniqueness, disjointWith, and edge
// cardinality.
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

const SLUG = "constraint-fences";
const TITLE =
  "Claim Relations: The Constraint Holds Even When Nobody Took the Lock";

const COLOR_WRITER = "#cbd5e1";
const COLOR_WRITER_STROKE = "#a9bdd6";
const COLOR_HELD = "#1d4ed8";
const COLOR_HELD_GLOW = "#93c5fd";
const COLOR_BLOCKED = "#dc2626";
const COLOR_SLOT_STROKE = "#94a3b8";
const COLOR_TEXT = "#0f172a";
const COLOR_MUTED_TEXT = "#64748b";

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const SLOT_X = 640;
const SLOT_W = 330;
const SLOT_H = 58;
const WRITER_X = 175;

// One slot per constrained axis; `winner` indexes the writer whose claim is
// the live one.
const AXES = [
  { label: "uniqueness", y: 224, winner: 0, losers: [1, 3] },
  { label: "disjointWith", y: 352, winner: 4, losers: [2, 5] },
  { label: "edge cardinality", y: 480, winner: 2, losers: [0, 4] },
];

// Concurrent writers. importGraph is named because the post names it as the
// writer that never holds the lock; it still wins an axis here.
const WRITERS = [
  { y: 214, name: "importGraph" },
  { y: 268 },
  { y: 322 },
  { y: 376 },
  { y: 430 },
  { y: 484 },
];

/**
 * @returns {string}
 */
function renderDiagram() {
  const claims = AXES.flatMap((axis) => {
    const slotY = axis.y + SLOT_H / 2;
    const winner = WRITERS[axis.winner];
    const midX = (WRITER_X + SLOT_X) / 2;

    const held = `<path d="M ${WRITER_X + 14} ${winner.y} C ${midX} ${winner.y}, ${midX} ${slotY}, ${SLOT_X - 8} ${slotY}" fill="none" stroke="${COLOR_HELD_GLOW}" stroke-width="9" opacity="0.5"/>
    <path d="M ${WRITER_X + 14} ${winner.y} C ${midX} ${winner.y}, ${midX} ${slotY}, ${SLOT_X - 8} ${slotY}" fill="none" stroke="${COLOR_HELD}" stroke-width="3.5"/>`;

    const blocked = axis.losers.map((index) => {
      const writer = WRITERS[index];
      const stopX = SLOT_X - 74;
      return `<path d="M ${WRITER_X + 14} ${writer.y} C ${midX - 60} ${writer.y}, ${midX} ${slotY}, ${stopX} ${slotY}" fill="none" stroke="${COLOR_BLOCKED}" stroke-width="2" stroke-dasharray="6 6" opacity="0.7"/>
    <line x1="${stopX - 7}" y1="${slotY - 7}" x2="${stopX + 7}" y2="${slotY + 7}" stroke="${COLOR_BLOCKED}" stroke-width="2.5"/>
    <line x1="${stopX + 7}" y1="${slotY - 7}" x2="${stopX - 7}" y2="${slotY + 7}" stroke="${COLOR_BLOCKED}" stroke-width="2.5"/>`;
    });

    return [...blocked, held];
  }).join("\n    ");

  const slots = AXES.map(
    (axis) =>
      `<rect x="${SLOT_X}" y="${axis.y}" width="${SLOT_W}" height="${SLOT_H}" rx="10" fill="#ffffff" stroke="${COLOR_SLOT_STROKE}" stroke-width="2.5"/>
    <circle cx="${SLOT_X + 30}" cy="${axis.y + SLOT_H / 2}" r="9" fill="${COLOR_HELD}"/>
    <text x="${SLOT_X + 52}" y="${axis.y + SLOT_H / 2 + 7}" font-family="${MONO}" font-size="19" font-weight="600" fill="${COLOR_TEXT}">${escapeXml(axis.label)}</text>`,
  ).join("\n    ");

  const writers = WRITERS.map((writer) => {
    const name =
      writer.name ?
        `<text x="${WRITER_X - 24}" y="${writer.y + 6}" text-anchor="end" font-family="${MONO}" font-size="17" font-weight="600" fill="${COLOR_TEXT}">${escapeXml(writer.name)}</text>`
      : "";
    return `<circle cx="${WRITER_X}" cy="${writer.y}" r="11" fill="${COLOR_WRITER}" stroke="${COLOR_WRITER_STROKE}" stroke-width="2"/>
    ${name}`;
  }).join("\n    ");

  const heading = `<text x="${SLOT_X}" y="${AXES[0].y - 22}" font-family="${SANS}" font-size="17" font-weight="700" fill="${COLOR_TEXT}">one live claimant per axis</text>
    <text x="${MARGIN_X}" y="${WRITERS.at(-1).y + 44}" font-family="${SANS}" font-size="17" font-weight="600" fill="${COLOR_MUTED_TEXT}">concurrent writers · no lock required</text>`;

  return `${claims}\n    ${slots}\n    ${writers}\n    ${heading}`;
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
  <g transform="translate(370, 130) scale(0.53)">
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
