/**
 * The missing-peer ledger and typed refusal for `drizzle-orm`, an optional
 * peer dependency (design §4.4b, ruling OQ1).
 *
 * Two published entrypoints (`./sqlite/local`, `./postgres/pglite`)
 * construct their Drizzle connection internally, behind a dynamic import —
 * they are the only entrypoints a consumer can reach WITHOUT themselves
 * importing `drizzle-orm` first, and therefore the only ones that can turn
 * "drizzle-orm is not installed" into a typed, actionable error instead of a
 * bare module-resolution stack. The seven explicit `./adapters/drizzle/*`
 * entrypoints expose Drizzle-native backends, connections, or schema builders
 * — `./adapters/drizzle/engine`'s `createSqlBackend` included, whose module
 * tree reaches `drizzle-orm` through the shared member modules it assembles
 * a backend from — and load `drizzle-orm` when their module is evaluated.
 * Their raw resolution failure is an accepted, documented exemption (ruling
 * r3-OQ2), not a mechanism this module builds.
 *
 * {@link isMissingDrizzlePeerError} is the single narrow both factories call
 * (through {@link loadDrizzleBackedModule}), so the decision is spelled
 * exactly once. It narrows on the FAILING SPECIFIER captured out of the
 * message, never on the whole message text: the ESM message also names the
 * importer's own path (`… imported from …/node_modules/drizzle-orm/bs3.js`),
 * and a whole-message regex would launder a genuinely missing dependency OF
 * `drizzle-orm` into a false "install drizzle-orm" instruction.
 */
import { ConfigurationError } from "../errors";

/** The optional peer dependency the typed refusal names. */
export const MISSING_PEER_PACKAGE = "drizzle-orm";

/** The install command the typed refusal's message and suggestion carry. */
export const MISSING_PEER_INSTALL_COMMAND = "npm install drizzle-orm";

/**
 * One published, non-portable entrypoint's disposition when `drizzle-orm` is
 * absent — a discriminated union on `arm`, not a shape with optional fields:
 * a `typed-refusal` row cannot carry (and a `documented-resolution-error`
 * row cannot omit) `reason`/`documentedIn`, so "each exempt row names where
 * it is documented" is structural rather than a convention a future row
 * could silently drop.
 */
export type MissingPeerLedgerEntry =
  | Readonly<{
      entrypoint: string;
      arm: "typed-refusal";
      formats: readonly ("import" | "require")[];
    }>
  | Readonly<{
      entrypoint: string;
      arm: "documented-resolution-error";
      formats: readonly ("import" | "require")[];
      reason: string;
      documentedIn: readonly string[];
    }>;

const SYNCHRONOUS_HANDLE_ADAPTER_REASON =
  "synchronous pass-a-Drizzle-handle factory: deferring the adapter implementation to translate its module-resolution failure would require an async signature change";

const SYNCHRONOUS_CONNECTION_ADAPTER_REASON =
  "synchronous connection-owning adapter factory: deferring its Drizzle-backed implementation to translate the module-resolution failure would require an async signature change";

const ASYNC_DRIZZLE_NATIVE_ADAPTER_REASON =
  "explicit Drizzle-native adapter entrypoint: it eagerly exposes a Drizzle database alongside the GraphBackend, so a missing drizzle-orm fails at module evaluation with the raw resolution error";

const DRIZZLE_INDEX_BUILDERS_REASON =
  "Drizzle-native schema-builder entrypoint with no factory boundary at which to translate a missing drizzle-orm import";

const ASSEMBLED_PROFILE_MODULE_TREE_REASON =
  "the factory takes a caller-assembled engine profile, never a raw Drizzle handle or connection, but its module tree statically imports the shared member modules that construct Drizzle-backed row access, so a missing drizzle-orm fails at module evaluation with the raw resolution error";

/**
 * Repo-root-relative, POSIX paths (matching `scripts/drizzle-claim-inventory.ts`'s
 * path grain) naming every file that states the peer's optionality and the
 * install command for the seven documented-resolution-error rows.
 */
const SYNCHRONOUS_ADAPTER_DOCUMENTED_IN: readonly string[] = [
  "README.md",
  "packages/typegraph/README.md",
  "apps/docs/src/content/docs/backend-setup.md",
];

/**
 * Every non-portable published entrypoint, in exactly one arm. The two
 * "batteries included" entrypoints get the typed refusal because their
 * factory owns the connection; the seven `./adapters/drizzle/*` entrypoints
 * are the documented, accepted exemption. `tests/missing-peer-refusal.test.ts`
 * asserts this set equals `Object.keys(classifyEntrypoints())` minus the
 * portable entrypoints, both directions — so the covered set and the
 * asserted set are one object.
 */
export const MISSING_PEER_LEDGER = [
  {
    entrypoint: "./sqlite/local",
    arm: "typed-refusal",
    formats: ["import", "require"],
  },
  {
    entrypoint: "./postgres/pglite",
    arm: "typed-refusal",
    formats: ["import", "require"],
  },
  {
    entrypoint: "./adapters/drizzle/sqlite",
    arm: "documented-resolution-error",
    formats: ["import", "require"],
    reason: SYNCHRONOUS_HANDLE_ADAPTER_REASON,
    documentedIn: SYNCHRONOUS_ADAPTER_DOCUMENTED_IN,
  },
  {
    entrypoint: "./adapters/drizzle/postgres",
    arm: "documented-resolution-error",
    formats: ["import", "require"],
    reason: SYNCHRONOUS_HANDLE_ADAPTER_REASON,
    documentedIn: SYNCHRONOUS_ADAPTER_DOCUMENTED_IN,
  },
  {
    entrypoint: "./adapters/drizzle/postgres/pglite",
    arm: "documented-resolution-error",
    formats: ["import", "require"],
    reason: ASYNC_DRIZZLE_NATIVE_ADAPTER_REASON,
    documentedIn: SYNCHRONOUS_ADAPTER_DOCUMENTED_IN,
  },
  {
    entrypoint: "./adapters/drizzle/sqlite/local",
    arm: "documented-resolution-error",
    formats: ["import", "require"],
    reason: SYNCHRONOUS_CONNECTION_ADAPTER_REASON,
    documentedIn: SYNCHRONOUS_ADAPTER_DOCUMENTED_IN,
  },
  {
    entrypoint: "./adapters/drizzle/sqlite/libsql",
    arm: "documented-resolution-error",
    formats: ["import", "require"],
    reason: ASYNC_DRIZZLE_NATIVE_ADAPTER_REASON,
    documentedIn: SYNCHRONOUS_ADAPTER_DOCUMENTED_IN,
  },
  {
    entrypoint: "./adapters/drizzle/indexes",
    arm: "documented-resolution-error",
    formats: ["import", "require"],
    reason: DRIZZLE_INDEX_BUILDERS_REASON,
    documentedIn: SYNCHRONOUS_ADAPTER_DOCUMENTED_IN,
  },
  {
    entrypoint: "./adapters/drizzle/engine",
    arm: "documented-resolution-error",
    formats: ["import", "require"],
    reason: ASSEMBLED_PROFILE_MODULE_TREE_REASON,
    documentedIn: SYNCHRONOUS_ADAPTER_DOCUMENTED_IN,
  },
] as const satisfies readonly MissingPeerLedgerEntry[];

const MISSING_MODULE_ERROR_CODES: ReadonlySet<string> = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
]);

/**
 * Both the ESM (`Cannot find package '<specifier>' imported from …`) and CJS
 * (`Cannot find module '<specifier>'`) forms put the failing specifier in
 * this first quoted group — the ONLY input this predicate reads from the
 * message. The importer path that follows it (ESM only) is never inspected.
 */
const MISSING_SPECIFIER_PATTERN = /Cannot find (?:package|module) '([^']+)'/;

/** Matches `drizzle-orm` and `drizzle-orm/<subpath>`, never a mere substring of a longer specifier or an importer path. */
const DRIZZLE_ORM_SPECIFIER_PATTERN = /^drizzle-orm(\/|$)/;

/** Narrows `unknown` to a plain object whose string-keyed members can be read defensively — never an assertion. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether `error` is a Node module-resolution failure naming a MISSING
 * `drizzle-orm` (or `drizzle-orm/<subpath>`) specifier — never a whole-message
 * scan (see the module doc comment for why). This is the single owner of the
 * narrow; both {@link createLocalSqliteStore} and {@link createLocalPgliteStore}
 * reach it only through {@link loadDrizzleBackedModule}.
 */
export function isMissingDrizzlePeerError(error: unknown): boolean {
  if (!isRecord(error)) return false;

  const code = error["code"];
  if (typeof code !== "string" || !MISSING_MODULE_ERROR_CODES.has(code)) {
    return false;
  }

  const message = error["message"];
  if (typeof message !== "string") return false;

  const specifier = MISSING_SPECIFIER_PATTERN.exec(message)?.[1];
  if (specifier === undefined) return false;

  return DRIZZLE_ORM_SPECIFIER_PATTERN.test(specifier);
}

/**
 * Builds the typed refusal for `entrypoint`. The MESSAGE itself (not only
 * `details`) carries the package name and the install command, because
 * downstream consumers of the packed tarball assert message text, not only
 * structured details. No new error class: `ConfigurationError` with a code
 * is the established pattern (`store.ts`'s `IDENTITY_REQUIRES_ATOMIC_BACKEND`),
 * and a dedicated missing-peer class would have exactly two call sites and
 * no distinct handling. Module-private: only {@link loadDrizzleBackedModule}
 * calls it, so it carries no `export` beyond this file — an unused export
 * knip would otherwise flag correctly.
 */
function missingDrizzlePeerError(
  entrypoint: string,
  cause: unknown,
): ConfigurationError {
  const packageSpecifier = `@nicia-ai/typegraph${entrypoint.slice(1)}`;
  const suggestion = `Run \`${MISSING_PEER_INSTALL_COMMAND}\`.`;
  return new ConfigurationError(
    `${packageSpecifier} requires the optional peer dependency "${MISSING_PEER_PACKAGE}", which is not installed. ${suggestion}`,
    {
      code: "MISSING_PEER_DEPENDENCY",
      package: MISSING_PEER_PACKAGE,
      entrypoint,
    },
    { cause, suggestion },
  );
}

/**
 * The single wiring owner: loads a Drizzle-backed impl module, rethrowing a
 * missing-peer failure as a typed {@link ConfigurationError} naming
 * `entrypoint`, and rethrowing anything else — including
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` and a missing dependency OF `drizzle-orm`
 * itself — completely untouched, so a genuine bug in the impl module, or in
 * one of Drizzle's own dependencies, is never laundered into a missing-peer
 * message. Both `createLocalSqliteStore` and `createLocalPgliteStore` call
 * this rather than `await import(...)` directly, so the refusal's wiring is
 * spelled once.
 */
export async function loadDrizzleBackedModule<T>(
  entrypoint: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isMissingDrizzlePeerError(error)) {
      throw missingDrizzlePeerError(entrypoint, error);
    }
    throw error;
  }
}
