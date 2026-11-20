/**
 * Declarations for the named exports `eslint.config.mjs` publishes alongside
 * its default config.
 *
 * The ratchet tests consume the REAL selector list rather than a second
 * emulation of it — one predicate, one owner — and the package program has no
 * `allowJs`, so the import needs this sidecar to type-check.
 */

/** The flat config ESLint itself loads. Opaque to the tests. */
declare const config: readonly unknown[];
export default config;

/** A single `no-restricted-syntax` entry. */
export type RestrictedSyntaxEntry = Readonly<{
  selector: string;
  message: string;
}>;

export declare const BACKEND_SEAM_MESSAGE: string;
export declare const BACKEND_MUTATION_MESSAGE: string;

/**
 * Every column of the `src/**` block table, so the exemption ratchet can assert
 * each one is installed whole rather than only the two it was written for.
 */
export declare const SOURCE_WIDE_RESTRICTIONS: readonly RestrictedSyntaxEntry[];
export declare const GLOBAL_SYMBOL_RESTRICTION: RestrictedSyntaxEntry;
export declare const RUNTIME_PORT_RESTRICTIONS: readonly RestrictedSyntaxEntry[];
export declare const BACKEND_SEAM_IMPORT_RESTRICTIONS: readonly RestrictedSyntaxEntry[];
export declare const BACKEND_CONSTRUCTION_RESTRICTIONS: readonly RestrictedSyntaxEntry[];
export declare const BACKEND_CARRY_RESTRICTIONS: readonly RestrictedSyntaxEntry[];
export declare const BACKEND_AUDIT_RESTRICTIONS: readonly RestrictedSyntaxEntry[];

/**
 * The I1 zone ban's shared pieces: the one pattern-source string L1's
 * selectors and scripts/drizzle-reachability-scan.ts's
 * `DRIZZLE_SPECIFIER_PATTERN` both derive from, the resulting five
 * selectors, and the zone list itself.
 */
export declare const DRIZZLE_SPECIFIER_PATTERN_SOURCE: string;
export declare const DRIZZLE_ZONE_MESSAGE: string;
export declare const DRIZZLE_ZONE_RESTRICTIONS: readonly RestrictedSyntaxEntry[];

/** The dialect-literal ban's own selector pair, resolved as a ban column in its own right. */
export declare const DIALECT_SEAM_RESTRICTIONS: readonly RestrictedSyntaxEntry[];

/** One `DRIZZLE_ZONE` entry: a real file that genuinely imports Drizzle, and why it may. */
export type DrizzleZoneEntry = Readonly<{ file: string; reason: string }>;

export declare const DRIZZLE_ZONE: readonly DrizzleZoneEntry[];

/**
 * One `DIALECT_LITERAL_EXEMPTIONS` entry: a real file that still contains an
 * AST-level dialect-literal comparison, the reason it may, whether that
 * reason is permanent or a later commit removes it, and the number of such
 * sites in the file the reason accounts for.
 */
export type DialectLiteralExemptionEntry = Readonly<{
  file: string;
  reason: string;
  permanent: boolean;
  sites: number;
}>;

export declare const DIALECT_LITERAL_EXEMPTIONS: readonly DialectLiteralExemptionEntry[];
