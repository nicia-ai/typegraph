/**
 * Property Tests — Vector strategy pure helpers
 *
 * Invariants of the dialect-neutral helpers shared by every VectorStrategy:
 * physical-name generation (determinism, the 63-char identifier ceiling,
 * charset, and hash-suffix collision-safety on overflow), the embedding /
 * limit validators, and SQL identifier quoting. These are total, deterministic
 * functions — the natural fit for fast-check, and the truncation/overflow
 * branch of `vectorPhysicalName` is one the example tests never reach (they
 * all use short names).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assertFiniteEmbedding,
  assertVectorSearchLimit,
  quoteIdentifier,
  vectorPhysicalName,
} from "../../src/query/dialect/vector-strategy";

// Mirrors the (module-private) MAX_VECTOR_IDENTIFIER_LENGTH in vector-strategy.ts
// — the Postgres / SQLite identifier byte ceiling the helper must never exceed.
const MAX_IDENTIFIER_LENGTH = 63;

const namePart = fc.string({ minLength: 0, maxLength: 80 });
// The prefix is always a trusted internal constant (`tg_vec` for tables,
// `tg_vec_idx` for indexes) — only graphId/kind/field are sanitized, so the
// charset guarantee holds relative to a clean prefix.
const prefixArb = fc.constantFrom("tg_vec", "tg_vec_idx");

describe("vectorPhysicalName properties", () => {
  it("is deterministic", () => {
    fc.assert(
      fc.property(
        prefixArb,
        namePart,
        namePart,
        namePart,
        (prefix, graphId, kind, field) => {
          expect(vectorPhysicalName(prefix, graphId, kind, field)).toBe(
            vectorPhysicalName(prefix, graphId, kind, field),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never exceeds the identifier-length ceiling", () => {
    fc.assert(
      fc.property(
        prefixArb,
        namePart,
        namePart,
        namePart,
        (prefix, graphId, kind, field) => {
          expect(
            vectorPhysicalName(prefix, graphId, kind, field).length,
          ).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("produces a valid lowercase identifier (alphanumerics + underscore)", () => {
    fc.assert(
      fc.property(
        prefixArb,
        namePart,
        namePart,
        namePart,
        (prefix, graphId, kind, field) => {
          const name = vectorPhysicalName(prefix, graphId, kind, field);
          expect(name).toMatch(/^[a-z0-9_]+$/u);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("distinct (graphId, kind, field) triples never collide, even when sanitization/join would (#2)", () => {
    // Each pair has an identical sanitized+joined readable part; the
    // exact-tuple hash suffix must keep them on distinct physical tables.
    const triples: readonly (readonly [string, string, string])[] = [
      ["a_b", "c", "d"], // join ambiguity ...
      ["a", "b_c", "d"], // ... vs this
      ["g", "Doc-A", "e"], // non-alnum sanitization ...
      ["g", "Doc_A", "e"], // ... vs this
      ["g", "Doc", "f"], // case folding ...
      ["g", "doc", "f"], // ... vs this
    ];
    const names = triples.map(([graphId, kind, field]) =>
      vectorPhysicalName("tg_vec", graphId, kind, field),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("disambiguates overflowing names whose truncated prefix collides (hash covers all parts)", () => {
    // Two graph ids long enough to force truncation, identical up to and well
    // past the 63-char cut, differing only in the final character. A naive
    // prefix truncation would map both to the same table name; the hash suffix
    // (computed over the full name) must keep them distinct.
    fc.assert(
      fc.property(
        fc.string({ minLength: 70, maxLength: 90 }).filter((s) => s.length > 0),
        (head) => {
          const a = vectorPhysicalName("tg_vec", `${head}a`, "Kind", "field");
          const b = vectorPhysicalName("tg_vec", `${head}b`, "Kind", "field");
          expect(a.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
          expect(b.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
          expect(a).not.toBe(b);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("assertFiniteEmbedding properties", () => {
  it("accepts any array of finite numbers", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.double({
            noNaN: true,
            noDefaultInfinity: true,
            min: -1e6,
            max: 1e6,
          }),
        ),
        (embedding) => {
          expect(() => {
            assertFiniteEmbedding(embedding, "embedding");
          }).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects a non-finite value and names its index", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ noNaN: true, noDefaultInfinity: true })),
        fc.constantFrom(Number.NaN, Infinity, -Infinity),
        fc.nat(),
        (finite, bad, rawIndex) => {
          const index = finite.length === 0 ? 0 : rawIndex % finite.length;
          const corrupted = [...finite];
          corrupted.splice(index, 0, bad);
          expect(() => {
            assertFiniteEmbedding(corrupted, "embedding");
          }).toThrow(new RegExp(String.raw`embedding\[${index}\]`, "u"));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("assertVectorSearchLimit properties", () => {
  it("accepts any positive integer", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (limit) => {
        expect(() => {
          assertVectorSearchLimit(limit);
        }).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it("rejects non-positive integers", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 0 }), (limit) => {
        expect(() => {
          assertVectorSearchLimit(limit);
        }).toThrow(RangeError);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects non-integers (including NaN / Infinity)", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .double({
              min: 0.0001,
              max: 1000,
              noNaN: true,
              noDefaultInfinity: true,
            })
            .filter((value) => !Number.isInteger(value)),
          fc.constantFrom(Number.NaN, Infinity, -Infinity),
        ),
        (limit) => {
          expect(() => {
            assertVectorSearchLimit(limit);
          }).toThrow(RangeError);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("quoteIdentifier properties", () => {
  it("round-trips: unquoting recovers the original name", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const quoted = quoteIdentifier(name);
        expect(quoted.startsWith('"')).toBe(true);
        expect(quoted.endsWith('"')).toBe(true);
        // Strip the outer quotes, collapse doubled quotes — must equal input.
        const unquoted = quoted.slice(1, -1).replaceAll('""', '"');
        expect(unquoted).toBe(name);
      }),
      { numRuns: 300 },
    );
  });
});
