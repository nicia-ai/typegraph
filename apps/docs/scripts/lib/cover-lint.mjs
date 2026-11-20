// Mechanical checks on a post's cover art. These are deliberately only the
// rules a machine can decide: canvas size, label legibility at display
// width, and text parked in the kicker/footer bands the design system bans.
//
// Everything about *composition* — whether the cover has a subject acting
// on a field, or is four labelled boxes at rest — is a review question, not
// a lint rule. A 2026-08 audit of the published covers confirmed this the
// hard way: ink coverage, element count, and text count were all measured
// against a human keep/rework verdict on all 15 covers and NONE of them
// separated the two groups (the densest cover in the corpus was a reject;
// the keeps ranged from 18 to 107 drawn shapes). Do not add a "density" or
// "element count" threshold here believing it stands in for quality — it
// does not. The blog-cover skill carries those rules with worked examples.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const PNG_SIGNATURE = "89504e470d0a1a0a";
const IHDR_OFFSET = 16;

export const CANVAS_WIDTH = 1200;
export const CANVAS_HEIGHT = 630;

/**
 * Labels smaller than this are unreadable once the 1200px canvas is drawn
 * in the ~760px blog column — a 13px label lands at roughly 8px there.
 */
export const MIN_FONT_SIZE = 15;

/** The logo's own wordmark sits at y=94 and is exempt from the band rules. */
const LOGO_TEXT_MAX_Y = 120;
const KICKER_BAND = { top: 120, bottom: 190 };
const FOOTER_BAND_TOP = 555;

/**
 * Reads a PNG's pixel dimensions straight out of the IHDR chunk, which is
 * always the first chunk and always at a fixed offset.
 * @param {string} file
 * @returns {{ width: number; height: number }}
 */
export function readPngSize(file) {
  const buffer = readFileSync(file);
  if (buffer.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
    throw new Error(`${file} is not a PNG`);
  }
  return {
    width: buffer.readUInt32BE(IHDR_OFFSET),
    height: buffer.readUInt32BE(IHDR_OFFSET + 4),
  };
}

/**
 * Runs a post's generator into a scratch directory and returns its cover
 * SVG. Doing this rather than parsing the generator source means the lint
 * sees exactly what ships — and a generator that no longer runs fails here
 * instead of rotting silently.
 * @param {string} generatorPath
 * @param {string} slug
 * @returns {string}
 */
export function renderCoverSvg(generatorPath, slug) {
  const outDir = mkdtempSync(path.join(tmpdir(), "cover-lint-"));
  try {
    execFileSync(process.execPath, [generatorPath, "--out-dir", outDir], {
      stdio: "pipe",
    });
    return readFileSync(path.join(outDir, `${slug}-cover.svg`), "utf8");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * @param {string} svg
 * @returns {readonly { y: number; size: number | undefined }[]}
 */
function textElements(svg) {
  return [...svg.matchAll(/<text\b([^>]*)>/g)].map((match) => {
    const attributes = match[1];
    const y = /\by="(-?[\d.]+)"/.exec(attributes);
    const size = /\bfont-size="([\d.]+)"/.exec(attributes);
    return {
      y: y ? Number(y[1]) : 0,
      size: size ? Number(size[1]) : undefined,
    };
  });
}

/**
 * @param {{ slug: string; coverPng: string; generator: string }} post
 * @returns {readonly string[]} one message per violation, empty when clean
 */
export function lintCover({ slug, coverPng, generator }) {
  /** @type {string[]} */
  const violations = [];

  const { width, height } = readPngSize(coverPng);
  if (width !== CANVAS_WIDTH || height !== CANVAS_HEIGHT) {
    violations.push(
      `cover.png is ${width}x${height}; every cover must be ${CANVAS_WIDTH}x${CANVAS_HEIGHT}`,
    );
  }

  /** @type {string} */
  let svg;
  try {
    svg = renderCoverSvg(generator, slug);
  } catch (error) {
    violations.push(
      `generate-images.mjs failed to run: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
    return violations;
  }

  const texts = textElements(svg);

  const tooSmall = texts
    .map((text) => text.size)
    .filter((size) => size !== undefined && size < MIN_FONT_SIZE);
  if (tooSmall.length > 0) {
    const smallest = Math.min(...tooSmall);
    violations.push(
      `${tooSmall.length} label(s) below ${MIN_FONT_SIZE}px (smallest ${smallest}px) — ` +
        `at blog-column width that renders near ${Math.round((smallest * 760) / CANVAS_WIDTH)}px`,
    );
  }

  const kickers = texts.filter(
    (text) =>
      text.y > Math.max(KICKER_BAND.top, LOGO_TEXT_MAX_Y) &&
      text.y < KICKER_BAND.bottom,
  );
  if (kickers.length > 0) {
    violations.push(
      `${kickers.length} line(s) of text in the kicker band above the diagram — ` +
        `attach the fact to the element it describes instead`,
    );
  }

  const footers = texts.filter((text) => text.y > FOOTER_BAND_TOP);
  if (footers.length > 0) {
    violations.push(
      `${footers.length} line(s) of text in the footer band below the diagram — ` +
        `the post's prose carries the explanation`,
    );
  }

  return violations;
}
