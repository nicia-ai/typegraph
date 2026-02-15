/**
 * Compatibility barrel for drizzle SQL builders.
 *
 * The concrete query builders live under ./operations/* and are grouped
 * by concern to keep backend SQL generation easier to read and evolve.
 */
export * from "./operations/index";
