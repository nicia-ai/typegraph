/**
 * Shared Arbitrary Generators for Property-Based Tests
 *
 * Reusable fast-check arbitraries for TypeGraph domain objects.
 * Import these to reduce duplication across property tests.
 */
import fc from "fast-check";

// ============================================================
// String Arbitraries
// ============================================================

/**
 * Unicode strings including edge cases.
 */
export const unicodeStringArb = fc.oneof(
  fc.string(), // ASCII
  fc.string({ unit: "grapheme" }), // Unicode graphemes
  fc.constant(""), // Empty
  fc.constant(" ".repeat(3)), // Whitespace only
  fc.constantFrom(
    "日本語", // Japanese
    "中文", // Chinese
    "한국어", // Korean
    "العربية", // Arabic
    "עברית", // Hebrew
    "Ελληνικά", // Greek
    "Кириллица", // Cyrillic
    "🎉🚀💻", // Emoji
    "Hello\nWorld", // Newlines
    "Tab\there", // Tabs
    "Quote's\"here", // Quotes
    String.raw`Back\slash`, // Backslash
  ),
);

// ============================================================
// Query-Related Arbitraries
// ============================================================

/**
 * Sort directions.
 */
export const sortDirectionArb = fc.constantFrom("asc", "desc");
