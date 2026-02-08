import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  joinJsonPointers,
  jsonPointer,
  type JsonPointerInput,
  MAX_JSON_POINTER_DEPTH,
  normalizeJsonPointer,
  parseJsonPointer,
} from "../../src/query/json-pointer";

// Generator for valid pointer segments (string or non-negative integer)
const segmentArb = fc.oneof(
  fc.string().filter((s) => s !== "-"),
  fc.integer({ min: 0 }).map((index) => index.toString()), // Treat as string for comparison simplicity
);

// Generator for valid pointer segment arrays (respecting max depth)
const pointerSegmentsArb = fc
  .array(segmentArb, { minLength: 0, maxLength: MAX_JSON_POINTER_DEPTH })
  .map((segments) =>
    segments.map((s) => (/^\d+$/.test(s) ? Number.parseInt(s, 10) : s)),
  );

describe("JSON Pointer Properties", () => {
  it("round-trips segments -> pointer -> segments", () => {
    fc.assert(
      fc.property(pointerSegmentsArb, (segments) => {
        const pointer = jsonPointer(segments);
        const parsed = parseJsonPointer(pointer);

        // Convert parsed back to mixed types (parseJsonPointer returns all strings)
        // jsonPointer input can be numbers, but output of parse is always string
        const expected = segments.map(String);
        expect(parsed).toEqual(expected);
      }),
    );
  });

  it("round-trips pointer -> segments -> pointer", () => {
    // Generate valid pointers by first generating segments
    const validPointerArb = pointerSegmentsArb.map((segments) =>
      jsonPointer(segments),
    );

    fc.assert(
      fc.property(validPointerArb, (pointer) => {
        const segments = parseJsonPointer(pointer);
        // We need to cast back to segments, but jsonPointer accepts strings too
        const reconstructed = jsonPointer(segments);
        expect(reconstructed).toBe(pointer);
      }),
    );
  });

  it("normalizeJsonPointer is idempotent", () => {
    const validPointerArb = pointerSegmentsArb.map((segments) =>
      jsonPointer(segments),
    );

    fc.assert(
      fc.property(validPointerArb, (pointer) => {
        const first = normalizeJsonPointer(pointer);
        const second = normalizeJsonPointer(first);
        expect(second).toBe(first);
      }),
    );
  });

  it("normalizeJsonPointer handles array input same as string input", () => {
    fc.assert(
      fc.property(pointerSegmentsArb, (segments) => {
        const viaString = normalizeJsonPointer(jsonPointer(segments));
        // Cast segments to JsonPointerInput to test array normalization.
        // The runtime implementation handles any valid segment array.
        const viaArray = normalizeJsonPointer(
          segments as unknown as JsonPointerInput<Record<string, unknown>>,
        );
        expect(viaArray).toBe(viaString);
      }),
    );
  });

  it("joinJsonPointers is associative (within depth limits)", () => {
    // We need 3 pointers where total length <= MAX_DEPTH
    const tripleSegmentsArb = fc
      .tuple(
        fc.array(segmentArb, { maxLength: MAX_JSON_POINTER_DEPTH }),
        fc.array(segmentArb, { maxLength: MAX_JSON_POINTER_DEPTH }),
        fc.array(segmentArb, { maxLength: MAX_JSON_POINTER_DEPTH }),
      )
      .filter(
        ([a, b, c]) => a.length + b.length + c.length <= MAX_JSON_POINTER_DEPTH,
      )
      .map(
        ([a, b, c]) =>
          [
            jsonPointer(
              a.map((s) => (/^\d+$/.test(s) ? Number.parseInt(s, 10) : s)),
            ),
            jsonPointer(
              b.map((s) => (/^\d+$/.test(s) ? Number.parseInt(s, 10) : s)),
            ),
            jsonPointer(
              c.map((s) => (/^\d+$/.test(s) ? Number.parseInt(s, 10) : s)),
            ),
          ] as const,
      );

    fc.assert(
      fc.property(tripleSegmentsArb, ([a, b, c]) => {
        const ab_c = joinJsonPointers(joinJsonPointers(a, b), c);
        const a_bc = joinJsonPointers(a, joinJsonPointers(b, c));
        expect(ab_c).toBe(a_bc);
      }),
    );
  });

  it("handles special characters in segments correctly", () => {
    // Specific test for ~ and /
    const specialCharSegmentsArb = fc.array(
      fc
        .array(fc.constantFrom("~", "/", "0", "1", "a", "b"))
        .map((chars) => chars.join("")),
      { minLength: 0, maxLength: MAX_JSON_POINTER_DEPTH },
    );

    fc.assert(
      fc.property(specialCharSegmentsArb, (segments) => {
        const pointer = jsonPointer(segments);
        const parsed = parseJsonPointer(pointer);
        expect(parsed).toEqual(segments);

        // Check that / is encoded as ~1 and ~ is encoded as ~0
        const hasSlash = segments.some((s) => s.includes("/"));
        const hasTilde = segments.some((s) => s.includes("~"));
        const containsTilde1 = pointer.includes("~1");
        const containsTilde0 = pointer.includes("~0");

        // If segment contains /, pointer must contain ~1
        expect(!hasSlash || containsTilde1).toBe(true);
        // If segment contains ~, pointer must contain ~0
        expect(!hasTilde || containsTilde0).toBe(true);
      }),
    );
  });
});
