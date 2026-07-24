#!/usr/bin/env node
// Cover/social images for "Introducing TypeGraph" — the generic seeded-graph
// fallback, not a bespoke diagram: this is a meta/announcement post (the
// origin story, not a single worked mechanism), so there's no concrete
// example to draw. See scripts/generate-blog-images.mjs (imported here as
// "#generic-blog-image") for how the graph is generated — deterministically
// seeded from the slug below, so it's stable across regenerations.
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

import process from "node:process";

import { parseOutDirArgument, writeBlogImages } from "#blog-art";
import { generateCoverSvg, generateSocialSvg } from "#generic-blog-image";

const SLUG = "introducing-typegraph";
const TITLE = "Introducing TypeGraph";

function main() {
  writeBlogImages({
    slug: SLUG,
    outDir: parseOutDirArgument(process.argv.slice(2)),
    coverSvg: generateCoverSvg({ slug: SLUG }),
    socialSvg: generateSocialSvg({ slug: SLUG, title: TITLE }),
  });
}

main();
