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
