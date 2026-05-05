/**
 * Unit tests for schema/canonical.ts (sortedReplacer + canonicalEqual).
 */
import { describe, expect, it } from "vitest";

import { canonicalEqual, sortedReplacer } from "../src/schema/canonical";

describe("sortedReplacer", () => {
  it("sorts object keys lexicographically", () => {
    const input = { z: 1, a: 2, m: 3 };
    const output = JSON.stringify(input, sortedReplacer);
    expect(output).toBe('{"a":2,"m":3,"z":1}');
  });

  it("sorts nested object keys recursively", () => {
    const input = { z: { y: 2, a: 1 }, a: 1 };
    const output = JSON.stringify(input, sortedReplacer);
    expect(output).toBe('{"a":1,"z":{"a":1,"y":2}}');
  });

  it("preserves array order", () => {
    const input = { items: [3, 1, 2] };
    const output = JSON.stringify(input, sortedReplacer);
    expect(output).toBe('{"items":[3,1,2]}');
  });

  it("does not reorder objects nested inside arrays", () => {
    // Object keys inside arrays still get sorted, but array order is preserved.
    const input = { items: [{ z: 1, a: 2 }, { b: 3 }] };
    const output = JSON.stringify(input, sortedReplacer);
    expect(output).toBe('{"items":[{"a":2,"z":1},{"b":3}]}');
  });
});

describe("canonicalEqual", () => {
  it("returns true for equivalent objects with different key orders", () => {
    const a = { ui: { icon: "x", title: "y" }, audit: { pii: false } };
    const b = { audit: { pii: false }, ui: { title: "y", icon: "x" } };
    expect(canonicalEqual(a, b)).toBe(true);
  });

  it("returns false when values differ", () => {
    const a = { count: 1 };
    const b = { count: 2 };
    expect(canonicalEqual(a, b)).toBe(false);
  });

  it("returns false when arrays have different orders", () => {
    expect(canonicalEqual([1, 2, 3], [3, 2, 1])).toBe(false);
  });

  it("treats two undefined inputs as equal", () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- testing undefined comparison
    expect(canonicalEqual(undefined, undefined)).toBe(true);
  });

  it("compares primitives by value", () => {
    expect(canonicalEqual("hello", "hello")).toBe(true);
    expect(canonicalEqual(42, 42)).toBe(true);
    expect(canonicalEqual(true, true)).toBe(true);
  });
});
