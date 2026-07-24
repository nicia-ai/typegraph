#!/usr/bin/env node
// Starting point for a new post's cover/social images.
//
// This file, as-is, uses the generic seeded-graph fallback (same visual
// language, no content-specific meaning) — fine for a meta/announcement
// post with nothing concrete to diagram. Update SLUG/TITLE below to match
// this post.
//
// If the post has a concrete mechanism, example, or before/after worth
// drawing instead (the common, preferred case — see the blog-cover skill's
// "Step 0" decision), replace this file's body with a bespoke diagram.
// Copy ../graph-merge/generate-images.mjs as a worked example: hand-laid-out
// nodes/edges as plain JS objects, not a generic algorithm, so the
// illustration is literally true to the post's content. Both styles import
// shared canvas/logo/background/title primitives from "#blog-art"
// (scripts/lib/blog-art.mjs).
//
// Usage:
//   node generate-images.mjs [--out-dir dir]

import process from "node:process";

import { parseOutDirArgument, writeBlogImages } from "#blog-art";
import { generateCoverSvg, generateSocialSvg } from "#generic-blog-image";

const SLUG = "my-post";
const TITLE = "Post title";

function main() {
  writeBlogImages({
    slug: SLUG,
    outDir: parseOutDirArgument(process.argv.slice(2)),
    coverSvg: generateCoverSvg({ slug: SLUG }),
    socialSvg: generateSocialSvg({ slug: SLUG, title: TITLE }),
  });
}

main();
