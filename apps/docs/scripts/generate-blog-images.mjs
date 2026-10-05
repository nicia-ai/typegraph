#!/usr/bin/env node
// Generates the two branded 1200x630 images a blog post needs, as a generic
// per-post graph illustration (node/edge layout deterministically seeded
// from the slug, so every post gets a distinct but on-brand image):
//
//   <slug>-cover.svg  — no title text. This is the image shown on the page
//                       itself (blog index + post header).
//   <slug>-social.svg — the same seeded graph with the post title overlaid.
//                       Used only as the OG/Twitter share-card image (see
//                       src/components/starlight/Head.astro) — never
//                       rendered on the page, so the title isn't shown
//                       twice.
//
// This is the fallback for posts with no content worth diagramming. When a
// post has a concrete example worth illustrating (a graph, a state
// transition, a before/after), prefer a bespoke, hand-authored diagram
// instead, co-located with the post — see
// src/content/docs/blog/graph-merge/generate-images.mjs for a worked
// example. Both share the logo/illustration background/title rendering
// from lib/blog-art.mjs (imported here as "#blog-art" — see the
// package.json "imports" map).
//
// `generateCoverSvg`/`generateSocialSvg` are exported so a post's own
// `generate-images.mjs` can call them directly instead of shelling out to
// this file — see src/content/docs/blog/_template/generate-images.mjs.
// Output is SVG source; rasterize both to PNG (e.g. with the `browse`
// skill, or any SVG renderer) and save them as `cover.png`/`social.png`
// next to the post's `index.mdx`.
//
// Usage (as a standalone CLI, writing into the current directory):
//   node generate-blog-images.mjs --slug my-post --title "Post Title" [--out-dir dir]

import process from "node:process";

import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  CONTENT_SAFE_TOP,
  layoutTitle,
  renderIllustrationBackground,
  renderLogoMark,
  renderTitleLines,
  svgDocument,
  writeBlogImages,
} from "./lib/blog-art.mjs";

const NODE_COUNT = 16;
const NODE_COLORS = ["#2563eb", "#1d4ed8", "#3b82f6", "#1e40af"];
const EDGE_COLOR = "#2563eb";
// Nodes avoid this top-left corner so they never collide with the logo.
const LOGO_SAFE_ZONE = { width: 320, height: CONTENT_SAFE_TOP };

/**
 * @param {readonly string[]} argv
 * @returns {{ slug: string | undefined; title: string | undefined; outDir: string | undefined }}
 */
function parseArguments(argv) {
  /** @type {{ slug: string | undefined; title: string | undefined; outDir: string | undefined }} */
  const args = { slug: undefined, title: undefined, outDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case "--slug": {
        args.slug = value;
        index += 1;
        break;
      }
      case "--title": {
        args.title = value;
        index += 1;
        break;
      }
      case "--out-dir": {
        args.outDir = value;
        index += 1;
        break;
      }
      default: {
        break;
      }
    }
  }
  return args;
}

const MULBERRY32_INCREMENT = 0x6d_2b_79_f5;

/**
 * Deterministic PRNG seeded from a string, so each post's graph art is
 * stable across regenerations but distinct from every other post's.
 * @param {string} seedText
 * @returns {() => number}
 */
function createSeededRandom(seedText) {
  let seed = 0;
  for (const char of seedText) {
    seed = Math.imul(seed * 31 + (char.codePointAt(0) ?? 0), 1);
  }
  return function random() {
    seed = Math.imul(seed + MULBERRY32_INCREMENT, 1);
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * @typedef {{ x: number; y: number; r: number; color: string }} GraphNode
 * @typedef {{ nodes: GraphNode[]; edges: Array<[number, number]> }} Graph
 */

/**
 * @param {() => number} random
 * @returns {Graph}
 */
function generateGraph(random) {
  /** @type {GraphNode[]} */
  const nodes = [];
  while (nodes.length < NODE_COUNT) {
    const x = 60 + random() * (CANVAS_WIDTH - 120);
    const y = 50 + random() * (CANVAS_HEIGHT - 100);
    if (x < LOGO_SAFE_ZONE.width && y < LOGO_SAFE_ZONE.height) continue;
    nodes.push({
      x,
      y,
      r: 3 + random() * 5,
      color: NODE_COLORS[Math.floor(random() * NODE_COLORS.length)],
    });
  }

  // Connect each node to its nearest already-placed neighbor, producing one
  // connected, organic-looking spanning tree instead of scattered dots.
  /** @type {Array<[number, number]>} */
  const edges = [];
  for (let index = 1; index < nodes.length; index += 1) {
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < index; candidate += 1) {
      const distance = Math.hypot(
        nodes[index].x - nodes[candidate].x,
        nodes[index].y - nodes[candidate].y,
      );
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = candidate;
      }
    }
    edges.push([index, nearestIndex]);
  }

  return { nodes, edges };
}

/**
 * @param {Graph} graph
 * @param {number} opacity
 * @returns {string}
 */
function renderGraphMarkup(graph, opacity) {
  const edgeMarkup = graph.edges
    .map(([a, b]) => {
      const nodeA = graph.nodes[a];
      const nodeB = graph.nodes[b];
      return `<line x1="${nodeA.x.toFixed(1)}" y1="${nodeA.y.toFixed(1)}" x2="${nodeB.x.toFixed(1)}" y2="${nodeB.y.toFixed(1)}" stroke="${EDGE_COLOR}" stroke-width="1.5" opacity="${(0.35 * opacity).toFixed(2)}"/>`;
    })
    .join("\n    ");
  const nodeMarkup = graph.nodes
    .map(
      (node) =>
        `<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${node.r.toFixed(1)}" fill="${node.color}" opacity="${(0.9 * opacity).toFixed(2)}"/>`,
    )
    .join("\n    ");
  return `${edgeMarkup}\n    ${nodeMarkup}`;
}

/**
 * The content cover: a per-post graph illustration, no title text. Shown on
 * the page itself (blog index + post header).
 *
 * Exported (not just used by this file's own `main()`) so a post's own
 * `generate-images.mjs` can import it directly — e.g. `import {
 * generateCoverSvg, generateSocialSvg } from "#generic-blog-image"` — for
 * posts with nothing bespoke to diagram. See
 * src/content/docs/blog/_template/generate-images.mjs for the pattern.
 * @param {{ slug: string }} options
 * @returns {string}
 */
export function generateCoverSvg({ slug }) {
  const graph = generateGraph(createSeededRandom(slug));

  return svgDocument(`  ${renderIllustrationBackground()}

  <g>
    ${renderGraphMarkup(graph, 1)}
  </g>

  ${renderLogoMark()}`);
}

/**
 * The social/OG card: the same seeded graph with the post title overlaid.
 * Only used for og:image / twitter:image — never rendered on the page.
 * @param {{ slug: string; title: string }} options
 * @returns {string}
 */
export function generateSocialSvg({ slug, title }) {
  const graph = generateGraph(createSeededRandom(slug));
  const { lines, fontSize } = layoutTitle(title);
  const titleMarkup = renderTitleLines(lines, fontSize);

  return svgDocument(`  ${renderIllustrationBackground()}

  <g>
    ${renderGraphMarkup(graph, 0.7)}
  </g>

  ${renderLogoMark()}

  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif">
    ${titleMarkup}
  </g>`);
}

function main() {
  const { slug, title, outDir } = parseArguments(process.argv.slice(2));
  if (!slug || !title) {
    process.stderr.write(
      'Usage: node scripts/generate-blog-images.mjs --slug my-post --title "Post Title" [--out-dir dir]\n',
    );
    process.exitCode = 1;
    return;
  }

  writeBlogImages({
    slug,
    outDir,
    coverSvg: generateCoverSvg({ slug }),
    socialSvg: generateSocialSvg({ slug, title }),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
