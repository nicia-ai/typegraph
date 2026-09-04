// @ts-check

import { createLibraryConfig } from "@typegraph/eslint-config/library";

import {
  profileCovers,
  WRITE_PIPELINE_EXEMPTIONS,
  writePipelineBlocks,
} from "./eslint/write-pipeline-inventory.mjs";

const DIALECT_SEAM_MESSAGE =
  "Do not branch on dialect identity with an inline literal comparison or " +
  "switch. Express the difference as a method/capability on DialectAdapter " +
  "(a token-level seam) or a declared backend capability — anywhere under " +
  "src — so TypeScript forces every backend to provide an implementation and " +
  "the divergence stays visible and cross-backend testable. A file that " +
  "genuinely cannot (one-shot provisioning/migration, the pessimistic-lock " +
  "fence's one owner, a resource-audit driver fact, dialect-specific error " +
  "classification) is named file by file in DIALECT_LITERAL_EXEMPTIONS, " +
  "below, with the reason.";

const LOCALE_API_MESSAGE =
  "Locale-dependent APIs (localeCompare / toLocale* / Intl) vary with the " +
  "host's ICU configuration, so two processes can order or format the same " +
  "values differently — turning 'sorted' lock-acquisition sequences into " +
  "cross-process deadlocks and making result ordering flap between " +
  "environments. Use compareStrings from src/utils/compare (or toSorted() " +
  "with no comparator) for deterministic code-unit ordering.";

const GLOBAL_SYMBOL_MESSAGE =
  "Register TypeGraph process-wide symbols through typeGraphGlobalSymbol so " +
  "the closed symbol inventory and ESM/CJS identity contract stay audited.";

/**
 * Exported, like every other column of the block table below, so the exemption
 * ratchet resolves THIS restriction out of the real config rather than
 * re-spelling it.
 */
export const GLOBAL_SYMBOL_RESTRICTION = {
  selector:
    'CallExpression[callee.object.name="Symbol"][callee.property.name="for"]',
  message: GLOBAL_SYMBOL_MESSAGE,
};

export const RUNTIME_PORT_RESTRICTIONS = [
  {
    selector:
      "ImportSpecifier[imported.name=/^(STORE_RUNTIME|StoreRuntime|TRANSACTION_RUNTIME|TransactionRuntime)$/]",
    message:
      "Use the internal storeBackend/transactionBackend accessor; runtime symbols stay inside src/store.",
  },
  {
    selector:
      "ExportSpecifier[local.name=/^(STORE_RUNTIME|StoreRuntime|TRANSACTION_RUNTIME|TransactionRuntime)$/]",
    message:
      "Runtime symbols and their structural contracts must not be re-exported outside src/store.",
  },
];

export const BACKEND_SEAM_IMPORT_RESTRICTIONS = [
  {
    selector: 'ImportSpecifier[imported.name="deriveBackend"]',
    message:
      "deriveBackend is decoration-only and restricted to audited modules; use an allowlist projection to narrow capabilities.",
  },
  {
    selector: 'ExportSpecifier[local.name="deriveBackend"]',
    message:
      "deriveBackend must not be re-exported from a new surface; capability narrowing uses allowlist projections.",
  },
];

const CARRY_MESSAGE =
  "carryBackendResourceAudit is the construction seam's private carry. Only " +
  "src/backend/derive-backend.ts may import it: a second importer is a second " +
  "place that decides when a derived backend inherits its base's " +
  "serialized-resource verdict, and the two WILL drift. Derive through the " +
  "seam instead — the carry runs there.";

const AUDIT_MESSAGE =
  "auditBackendResource records a backend's serialized-resource verdict, and " +
  "it is written ONCE by the factory that built the backend, before the " +
  "object escapes. Only src/backend/drizzle/engine/create-sql-backend.ts may " +
  "import it; anything else either derives through " +
  "src/backend/derive-backend.ts (which carries the verdict) or reads it " +
  "through resolveBackendAudit.";

/**
 * The I1 import ban. Exported so the exemption ratchet resolves THESE selectors
 * out of the real config instead of re-spelling them — a per-file block that
 * forgets to spread this list is invisible to a test that carries its own copy.
 */
export const BACKEND_CARRY_RESTRICTIONS = [
  {
    selector: 'ImportSpecifier[imported.name="carryBackendResourceAudit"]',
    message: CARRY_MESSAGE,
  },
  {
    selector: 'ExportSpecifier[local.name="carryBackendResourceAudit"]',
    message: CARRY_MESSAGE,
  },
];

/** The I2 import ban, exported for the same reason as its carry counterpart. */
export const BACKEND_AUDIT_RESTRICTIONS = [
  {
    selector: 'ImportSpecifier[imported.name="auditBackendResource"]',
    message: AUDIT_MESSAGE,
  },
  {
    selector: 'ExportSpecifier[local.name="auditBackendResource"]',
    message: AUDIT_MESSAGE,
  },
];

/**
 * Why a copied backend is a defect (#435), stated where the copy is written.
 * Exported so the ratchet tests consume THESE selectors rather than a second
 * emulation of them.
 */
export const BACKEND_SEAM_MESSAGE =
  "Derive a backend through src/backend/derive-backend.ts (deriveBackend / " +
  "projectBackend / projectBackendWithout / projectGraphBackend). A spread, " +
  "Object.assign copy or rest-omission builds a NEW object that the " +
  "serialized-resource audit does not follow — the #435 defect. An identifier " +
  "ending in `Backend` denotes a whole backend object; name a members " +
  "fragment `*Members`.";

/** The mutating half of the same class: Object.assign's FIRST argument. */
export const BACKEND_MUTATION_MESSAGE =
  "Object.assign(<backend>, …) MUTATES a backend other wrappers already hold, " +
  "including frozen store projections (store.ts, createStore's backend " +
  "projection). Derive instead.";

/**
 * The construction ratchet: every spelling that builds a new backend object
 * from an existing one without going through the seam.
 *
 * Name-based by construction — the same heuristic class as the dialect-literal
 * ban — so it is a cheap first net for the dominant spelling, not the argument
 * that the seam holds. The type-aware population is measured by the scanner in
 * tests/backend-derivation-scan.ts.
 */
export const BACKEND_CONSTRUCTION_RESTRICTIONS = [
  // Copies: identifier, `.backend` member, and factory-call spellings.
  {
    selector: "ObjectExpression > SpreadElement[argument.name=/[Bb]ackend$/]",
    message: BACKEND_SEAM_MESSAGE,
  },
  {
    selector:
      'ObjectExpression > SpreadElement[argument.property.name="backend"]',
    message: BACKEND_SEAM_MESSAGE,
  },
  {
    selector:
      "ObjectExpression > SpreadElement[argument.callee.name=/[Bb]ackend$/]",
    message: BACKEND_SEAM_MESSAGE,
  },
  // Rest-omission: the same three spellings of the initializer.
  {
    selector:
      "VariableDeclarator[init.name=/[Bb]ackend$/] > ObjectPattern > RestElement",
    message: BACKEND_SEAM_MESSAGE,
  },
  {
    selector:
      "VariableDeclarator[init.callee.name=/[Bb]ackend$/] > ObjectPattern > RestElement",
    message: BACKEND_SEAM_MESSAGE,
  },
  {
    selector:
      'VariableDeclarator[init.property.name="backend"] > ObjectPattern > RestElement',
    message: BACKEND_SEAM_MESSAGE,
  },
  // Object.assign, split so a mutation and a copy do not share one message.
  {
    selector:
      'CallExpression[callee.object.name="Object"][callee.property.name="assign"] > :first-child[name=/[Bb]ackend$/]',
    message: BACKEND_MUTATION_MESSAGE,
  },
  {
    selector:
      'CallExpression[callee.object.name="Object"][callee.property.name="assign"] > :not(:first-child)[name=/[Bb]ackend$/]',
    message: BACKEND_SEAM_MESSAGE,
  },
];

/**
 * The backend-derivation guardrails a file keeps even when it is one of the
 * audited decorators: the two import bans that name a single owner
 * (`carryBackendResourceAudit`, `auditBackendResource`) and the construction
 * ratchet. An audited overlay module is allowed to DECORATE; it is not allowed
 * to own the audit carry or to build a backend by copying one.
 *
 * Named once because flat-config rule entries REPLACE rather than merge, so
 * every block that respells a profile's list has to spread the same group — and
 * the write-pipeline profile generator respells four of them.
 */
const BACKEND_AUDIT_TRAIL_RESTRICTIONS = [
  ...BACKEND_CARRY_RESTRICTIONS,
  ...BACKEND_AUDIT_RESTRICTIONS,
  ...BACKEND_CONSTRUCTION_RESTRICTIONS,
];

/**
 * The full derivation ban for a file that is NOT an audited decorator: the
 * audit-trail group plus the `deriveBackend` import ban.
 */
const BACKEND_DERIVATION_RESTRICTIONS = [
  ...BACKEND_SEAM_IMPORT_RESTRICTIONS,
  ...BACKEND_AUDIT_TRAIL_RESTRICTIONS,
];

const INTEROP_PROBE_MESSAGE =
  'Do not compare a property key against "then" / "toJSON" inline. These ' +
  "are legal schema field names, so a trap that answers them by NAME before " +
  "consulting its own keys (or the schema's declared fields) drops a stored " +
  "value — the read-side twin of the prototype-member membership bug hasOwnKey " +
  "fixes. Look the key up as data FIRST, then fall back to isInteropProbeKey " +
  "from src/utils/object, which owns this decision and documents the ordering.";

// Protocol-key ratchet: the one comparison form that reintroduces the class.
// Set-membership spellings are centralized in isInteropProbeKey, so banning the
// inline comparison leaves exactly one owner of the decision.
const INTEROP_PROBE_RESTRICTIONS = [
  {
    selector:
      "BinaryExpression[operator=/^(===|!==|==|!=)$/] > Literal[value=/^(then|toJSON)$/]",
    message: INTEROP_PROBE_MESSAGE,
  },
];

// Determinism guardrail for the whole library source. NOTE: flat-config rule
// entries REPLACE, not merge — any later block that sets no-restricted-syntax
// for a subset of src must spread SOURCE_WIDE_RESTRICTIONS back in (see the
// query compiler block below).
const DETERMINISM_RESTRICTIONS = [
  {
    selector:
      'CallExpression > MemberExpression.callee[property.name="localeCompare"]',
    message: LOCALE_API_MESSAGE,
  },
  {
    selector:
      "CallExpression > MemberExpression.callee[property.name=/^toLocale/]",
    message: LOCALE_API_MESSAGE,
  },
  {
    selector: 'MemberExpression[object.name="Intl"]',
    message: LOCALE_API_MESSAGE,
  },
];

// Every no-restricted-syntax block below starts from this list: both guardrails
// apply to the whole library source, and a block that set only one of them
// would silently switch the other off for its files.
export const SOURCE_WIDE_RESTRICTIONS = [
  ...DETERMINISM_RESTRICTIONS,
  ...INTEROP_PROBE_RESTRICTIONS,
];

// The dialect ban, named once so every block that also needs it can respell
// its profile without dropping it. Flat-config rule entries REPLACE, so a
// later block that forgot this list would silently switch the parity
// guardrail off for that file. Originally the query compiler's own ban, now
// spread into every `no-restricted-syntax` block that covers `src/**/*.ts`
// — see DIALECT_LITERAL_EXEMPTIONS immediately below for the per-file release
// valve that lifts it where an AST-level literal still exists. Exported, like
// DRIZZLE_ZONE_RESTRICTIONS, so `tests/backend-construction-lint.test.ts` can
// resolve THIS list out of the real config as its own ban column, rather than
// only checking the exemption list against the tree.
export const DIALECT_SEAM_RESTRICTIONS = [
  {
    selector:
      "BinaryExpression[operator=/^(===|!==|==|!=)$/] > Literal[value=/^(sqlite|postgres)$/]",
    message: DIALECT_SEAM_MESSAGE,
  },
  {
    selector: "SwitchCase > Literal[value=/^(sqlite|postgres)$/]",
    message: DIALECT_SEAM_MESSAGE,
  },
];

/**
 * The dialect-literal ban's exemption ratchet: exactly the `src/**` files
 * that contain an AST-level `dialect === "postgres"` / `"sqlite"` comparison
 * or `switch (dialect)` today (the same two shapes DIALECT_SEAM_RESTRICTIONS
 * matches), each with the reason it may, whether that reason is permanent or
 * a later commit removes it, and the number of such sites the reason covers.
 * `tests/dialect-literal-inventory.test.ts` asserts this list's file set
 * equals the set of real dialect-literal sites, BOTH directions — a stale
 * entry (a file whose literal has been removed) fails as loudly as a new,
 * unlisted one — and separately asserts each entry's `sites` count against
 * the same file, so a reason that names N decisions stays honest as sites are
 * removed one at a time: the count drops before the last one does, forcing
 * the reason to narrow rather than surviving on a stale justification.
 *
 * @typedef {Readonly<{ file: string, reason: string, permanent: boolean, sites: number }>} DialectLiteralExemptionEntry
 * @type {readonly DialectLiteralExemptionEntry[]}
 */
export const DIALECT_LITERAL_EXEMPTIONS = [
  {
    file: "src/store/store.ts",
    reason:
      "Passes ownsWriteLock=true only for SQLite's BEGIN IMMEDIATE transactions, which already hold the write lock recorded-clock allocation would otherwise re-acquire — the one boolean flag this preflight path threads through.",
    permanent: true,
    sites: 1,
  },
  {
    file: "src/backend/migrate-vectors.ts",
    reason:
      "Decodes the legacy engine-native embedding column with engine-specific SQL; a one-shot migration over a format each engine wrote differently, not query compilation.",
    permanent: true,
    sites: 1,
  },
  {
    file: "src/backend/migrate-recorded-time.ts",
    reason:
      "At two sites the DDL column types the recorded-time migration writes, and at a third site the legacy mapping column the backfill joins on; provisioning code, not query compilation.",
    permanent: true,
    sites: 3,
  },
  {
    file: "src/backend/repair-validity-windows.ts",
    reason:
      "Selects a dialect-specific repair query and skips the SQLite-only backfill on Postgres; a one-shot provisioning tool, not query compilation.",
    permanent: true,
    sites: 2,
  },
  {
    file: "src/backend/capabilities/write-fence.ts",
    reason:
      "The dialect-keyed default lock capabilities the fence planner starts from (deriveFromDialect), plus the refusal and declaration-guidance messages that must name the engine's own lock primitives and isolation spelling (refuseWriteFenceSqlUnavailable, refuseFenceSqlSessionFactUnavailable, pessimisticLockDeclarationLine, unfencedRefusalMessage).",
    permanent: true,
    sites: 6,
  },
  {
    file: "src/store/algorithms/iterative-graph-operation.ts",
    reason:
      "Classifies a PostgreSQL-specific serialization-failure error code and selects a dialect-appropriate retry value; error handling, not query compilation.",
    permanent: true,
    sites: 2,
  },
  {
    file: "src/backend/transaction-resource.ts",
    reason:
      "The SQLite-only same-object and identity-lease arms of the serialized-resource audit are a driver fact, not a decision this ban's seam could generalize.",
    permanent: true,
    sites: 2,
  },
];

/**
 * The single owner of "is this specifier a Drizzle package" TEXT, shared by
 * substring between this file's L1 selectors and
 * scripts/drizzle-reachability-scan.ts's `DRIZZLE_SPECIFIER_PATTERN` (L2). A
 * plain ESM config file cannot cheaply import that TypeScript module, so the
 * shared owner is the pattern's SOURCE TEXT rather than the compiled RegExp:
 * `new RegExp(DRIZZLE_SPECIFIER_PATTERN_SOURCE).source` must equal
 * `DRIZZLE_SPECIFIER_PATTERN.source` exactly, and every one of the five
 * selectors below must contain this string — both asserted by
 * tests/drizzle-zone-inventory.test.ts, so the two guardrails cannot drift
 * apart silently.
 */
export const DRIZZLE_SPECIFIER_PATTERN_SOURCE =
  "^(drizzle-orm|drizzle-kit|drizzle-|@drizzle-team\\/)";

export const DRIZZLE_ZONE_MESSAGE =
  "This module sits outside the sanctioned Drizzle-specifier zone " +
  "(DRIZZLE_ZONE below: src/backend/drizzle/**, the three connection- " +
  "constructing adapter entrypoints, and src/indexes/drizzle.ts). " +
  "TypeGraph isolates Drizzle behind the GraphBackend port; importing, " +
  "re-exporting, dynamically importing, or requiring a Drizzle specifier " +
  "here defeats that isolation. This selector sees only the specifier " +
  "text (L1) — a module that reaches Drizzle through a RELATIVE helper " +
  "import is caught instead by scripts/drizzle-reachability-scan.ts's " +
  "closure walk (L2). If this file genuinely belongs in the zone, add it " +
  "to DRIZZLE_ZONE with its reason.";

/**
 * Builds the zone ban's five selectors from one pattern source: four
 * conceptual forms, with the re-export form split into its two distinct AST
 * node types (`export { x } from "…"` is an ExportNamedDeclaration;
 * `export * from "…"` is an ExportAllDeclaration). `no-restricted-imports`
 * cannot express the dynamic-import or `require` forms, so this stays
 * `no-restricted-syntax` throughout, matching every other ratchet in this
 * file. Exported so a downstream test can assert each selector still
 * CONTAINS the one pattern source, rather than re-deriving the selector
 * shape itself.
 *
 * @param {string} patternSource
 * @returns {readonly import("./eslint.config.d.mts").RestrictedSyntaxEntry[]}
 */
export function drizzleZoneRestrictions(patternSource) {
  return [
    {
      selector: `ImportDeclaration[source.value=/${patternSource}/]`,
      message: DRIZZLE_ZONE_MESSAGE,
    },
    {
      selector: `ExportNamedDeclaration[source.value=/${patternSource}/]`,
      message: DRIZZLE_ZONE_MESSAGE,
    },
    {
      selector: `ExportAllDeclaration[source.value=/${patternSource}/]`,
      message: DRIZZLE_ZONE_MESSAGE,
    },
    {
      selector: `ImportExpression > Literal[value=/${patternSource}/]`,
      message: DRIZZLE_ZONE_MESSAGE,
    },
    {
      selector: `CallExpression[callee.name="require"] > Literal[value=/${patternSource}/]`,
      message: DRIZZLE_ZONE_MESSAGE,
    },
  ];
}

/**
 * The I1 zone ban, exported so the exemption ratchet and the construction-
 * lint ratchet both resolve THESE selectors out of the real config instead
 * of re-spelling them.
 */
export const DRIZZLE_ZONE_RESTRICTIONS = drizzleZoneRestrictions(
  DRIZZLE_SPECIFIER_PATTERN_SOURCE,
);

/** @typedef {Readonly<{ file: string, reason: string }>} DrizzleZoneEntry */

/** Shared by the 26 files under src/backend/drizzle/** that are the adapter implementation itself. */
const DRIZZLE_ADAPTER_IMPLEMENTATION_REASON =
  "the Drizzle adapter implementation itself; L2's closure scan, not L1, " +
  "is what keeps it unreachable from a portable entrypoint";

/**
 * The sanctioned Drizzle-specifier zone (I1): every `src` module that
 * genuinely imports a Drizzle package, each with the reason it may.
 * `tests/drizzle-zone-inventory.test.ts` asserts this list equals the set of
 * real Drizzle importers, BOTH directions — a stale entry (a file that no
 * longer imports Drizzle) fails as loudly as a new, unlisted importer. A
 * blanket zone is unspellable by construction: every entry names one real
 * file, never a glob.
 *
 * @type {readonly DrizzleZoneEntry[]}
 */
export const DRIZZLE_ZONE = [
  {
    file: "src/backend/drizzle/columns/fulltext.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/columns/vector.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/contribution-materializations.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/ddl.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/engine/members/contribution-members.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/execution/postgres-execution.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/execution/sqlite-execution.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/execution/types.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/index-materializations.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/kind-removals.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operation-backend-core.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/clear.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/collections.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/constraint-fence-audit.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/atomic-node-claims.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/edge-claims.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/edges.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/fulltext.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/hybrid.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/nodes.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/node-projections.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/schema.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/shared.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/strategy.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/operations/uniques.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/postgres-schema-write-fence.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/postgres.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/schema/postgres.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/schema/sqlite.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/drizzle/sqlite.ts",
    reason: DRIZZLE_ADAPTER_IMPLEMENTATION_REASON,
  },
  {
    file: "src/backend/postgres/pglite.ts",
    reason:
      "a published, pass-a-handle adapter entrypoint that constructs a PGlite connection directly",
  },
  {
    file: "src/backend/sqlite/libsql.ts",
    reason:
      "a published, pass-a-handle adapter entrypoint that constructs a libSQL connection directly",
  },
  {
    file: "src/backend/sqlite/local.ts",
    reason:
      "a published, pass-a-handle adapter entrypoint that constructs a better-sqlite3 connection directly",
  },
  {
    file: "src/indexes/drizzle.ts",
    reason:
      "a Drizzle-typed module inside the otherwise-portable src/indexes/ " +
      "tree; not a published entrypoint (./adapters/drizzle/indexes maps " +
      "to src/backend/drizzle/indexes.ts) but named here so a future " +
      "portable module importing it does not go unnoticed by L1 (I1/F15)",
  },
];

/**
 * Generates one exemption block per {@link DRIZZLE_ZONE} entry: the LAST
 * block in `blocks` that sets `no-restricted-syntax` and covers `file`,
 * minus the zone ban's own selectors. Never an `ignores` hole: a zone file
 * keeps every OTHER guardrail its covering block installed, and loses only
 * the zone ban itself.
 *
 * Reuses {@link profileCovers} (the write-pipeline generator's "is this file
 * in that block?" predicate) so this generator and that one cannot disagree
 * about the same kind of question.
 *
 * @param {readonly Readonly<{
 *   name?: string,
 *   files?: readonly string[],
 *   ignores?: readonly string[],
 *   rules?: Readonly<Record<string, unknown>>,
 * }>[]} blocks
 * @param {readonly DrizzleZoneEntry[]} zone
 */
export function drizzleZoneExemptionBlocks(blocks, zone) {
  const zoneSelectors = new Set(
    DRIZZLE_ZONE_RESTRICTIONS.map((restriction) => restriction.selector),
  );

  function isRestrictedSyntaxOption(option) {
    return (
      typeof option === "object" &&
      option !== null &&
      "selector" in option &&
      typeof option.selector === "string"
    );
  }

  return zone.map((entry) => {
    const coveringBlocks = blocks.filter(
      (block) =>
        block.files !== undefined &&
        Array.isArray(block.rules?.["no-restricted-syntax"]) &&
        profileCovers(entry.file, {
          files: block.files,
          ignores: block.ignores,
        }),
    );
    const coveringBlock = coveringBlocks.at(-1);
    if (coveringBlock === undefined) {
      throw new Error(
        `drizzleZoneExemptionBlocks: no lint block sets no-restricted-syntax and covers ${entry.file}.`,
      );
    }

    const inheritedOption = coveringBlock.rules?.["no-restricted-syntax"];
    const inherited = (
      Array.isArray(inheritedOption) ? inheritedOption : []).filter(
      (option) =>
        !isRestrictedSyntaxOption(option) ||
        !zoneSelectors.has(option.selector),
    );

    return {
      name: `typegraph/drizzle-zone/exempt/${entry.file}`,
      files: [entry.file],
      rules: {
        "no-restricted-syntax": inherited,
      },
    };
  });
}

/**
 * Generates one exemption block per {@link DIALECT_LITERAL_EXEMPTIONS} entry:
 * the LAST block in `blocks` that sets `no-restricted-syntax` and covers
 * `file`, minus the dialect-literal ban's own selectors. Mirrors
 * {@link drizzleZoneExemptionBlocks}'s "find the last covering block, drop
 * only this ban's selectors" shape — the same composition rule applied to a
 * second, independent ban — so a file keeps every OTHER guardrail its
 * covering block installed and loses only the dialect-literal ban.
 *
 * @param {readonly Readonly<{
 *   name?: string,
 *   files?: readonly string[],
 *   ignores?: readonly string[],
 *   rules?: Readonly<Record<string, unknown>>,
 * }>[]} blocks
 * @param {readonly DialectLiteralExemptionEntry[]} exemptions
 */
export function dialectLiteralExemptionBlocks(blocks, exemptions) {
  const banSelectors = new Set(
    DIALECT_SEAM_RESTRICTIONS.map((restriction) => restriction.selector),
  );

  function isRestrictedSyntaxOption(option) {
    return (
      typeof option === "object" &&
      option !== null &&
      "selector" in option &&
      typeof option.selector === "string"
    );
  }

  return exemptions.map((entry) => {
    const coveringBlocks = blocks.filter(
      (block) =>
        block.files !== undefined &&
        Array.isArray(block.rules?.["no-restricted-syntax"]) &&
        profileCovers(entry.file, {
          files: block.files,
          ignores: block.ignores,
        }),
    );
    const coveringBlock = coveringBlocks.at(-1);
    if (coveringBlock === undefined) {
      throw new Error(
        `dialectLiteralExemptionBlocks: no lint block sets no-restricted-syntax and covers ${entry.file}.`,
      );
    }

    const inheritedOption = coveringBlock.rules?.["no-restricted-syntax"];
    const inherited = (
      Array.isArray(inheritedOption) ? inheritedOption : []).filter(
      (option) =>
        !isRestrictedSyntaxOption(option) || !banSelectors.has(option.selector),
    );

    return {
      name: `typegraph/dialect-seam/exempt/${entry.file}`,
      files: [entry.file],
      rules: {
        "no-restricted-syntax": inherited,
      },
    };
  });
}

/**
 * The audited overlay files: they legitimately drop the backend-overlay ban
 * (they ARE the audited decorators), so they are their own restriction profile
 * rather than an `ignores` hole in the store profile.
 *
 * `write-executor.ts` is here because the write frame owns the ONE decoration
 * row work can ask for: a session over a read overlay of the frame's target.
 * Row work states the reads and the executor applies them, precisely so that
 * a caller holding the read-only projection never has to hold — or decorate —
 * a writable backend of its own.
 */
const AUDITED_OVERLAY_FILES = [
  "src/store/operations/edge-batch-validation.ts",
  "src/store/operations/node-operations.ts",
  "src/store/operations/write-executor.ts",
  "src/store/recorded-capture.ts",
  "src/store/recorded-read-service.ts",
  "src/store/store.ts",
];

/**
 * The write-pipeline ban's restriction PROFILES: every file in scope belongs
 * to exactly one, and each states the whole `no-restricted-syntax` list that
 * applies to it (flat config replaces rather than merges). The generator emits
 * two blocks per profile — the in-scheme half adds the write-pipeline
 * selectors, the exempt half is the identical list without them, which is the
 * only difference an exemption is allowed to make.
 */
const RECORDED_CAPTURE_DIALECT_SEAM_FILES = [
  "src/store/recorded-capture/clock.ts",
];

/**
 * The three `subsystems`-profile files whose dialect branching is now the
 * pessimistic-lock decision (`resolveWriteFencePlan`, §5.3) rather than
 * backend provisioning — moved to the `dialect-seam` profile below so the
 * ban applies to them too.
 */
const DIALECT_SEAM_LOCK_FILES = [
  "src/identity/service-read.ts",
  "src/identity/schema-transition.ts",
  "src/graph-merge/provenance-store.ts",
];

const WRITE_PIPELINE_PROFILES = [
  {
    name: "store",
    files: ["src/store/**/*.ts"],
    ignores: [...AUDITED_OVERLAY_FILES, ...RECORDED_CAPTURE_DIALECT_SEAM_FILES],
    restrictions: [
      ...SOURCE_WIDE_RESTRICTIONS,
      ...DRIZZLE_ZONE_RESTRICTIONS,
      GLOBAL_SYMBOL_RESTRICTION,
      ...BACKEND_DERIVATION_RESTRICTIONS,
      ...DIALECT_SEAM_RESTRICTIONS,
    ],
  },
  {
    name: "subsystems",
    files: [
      "src/interchange/**/*.ts",
      "src/identity/**/*.ts",
      "src/graph-merge/**/*.ts",
      "src/provenance/**/*.ts",
    ],
    ignores: ["src/identity/historical-sql.ts", ...DIALECT_SEAM_LOCK_FILES],
    restrictions: [
      ...SOURCE_WIDE_RESTRICTIONS,
      ...DRIZZLE_ZONE_RESTRICTIONS,
      GLOBAL_SYMBOL_RESTRICTION,
      ...RUNTIME_PORT_RESTRICTIONS,
      ...BACKEND_DERIVATION_RESTRICTIONS,
      ...DIALECT_SEAM_RESTRICTIONS,
    ],
  },
  {
    name: "audited-overlay",
    files: AUDITED_OVERLAY_FILES,
    restrictions: [
      ...SOURCE_WIDE_RESTRICTIONS,
      ...DRIZZLE_ZONE_RESTRICTIONS,
      GLOBAL_SYMBOL_RESTRICTION,
      ...BACKEND_AUDIT_TRAIL_RESTRICTIONS,
      ...DIALECT_SEAM_RESTRICTIONS,
    ],
  },
  {
    // The pessimistic-lock decision's one owner is `resolveWriteFencePlan`
    // (src/backend/capabilities/write-fence.ts); every site that used to
    // spell `dialect === "postgres"` to make that decision now resolves a
    // plan instead, and this profile is what keeps the spelling from
    // reappearing at any of them.
    name: "dialect-seam",
    files: ["src/identity/historical-sql.ts", ...DIALECT_SEAM_LOCK_FILES],
    restrictions: [
      ...SOURCE_WIDE_RESTRICTIONS,
      ...DRIZZLE_ZONE_RESTRICTIONS,
      GLOBAL_SYMBOL_RESTRICTION,
      ...RUNTIME_PORT_RESTRICTIONS,
      ...BACKEND_DERIVATION_RESTRICTIONS,
      ...DIALECT_SEAM_RESTRICTIONS,
    ],
  },
  {
    // clock.ts is a `store/**` file, so it re-spreads the `store` profile's
    // own restriction list (not `subsystems`') alongside the dialect-literal
    // ban — the same one-owner rationale as the `dialect-seam` profile above.
    name: "recorded-capture-dialect-seam",
    files: RECORDED_CAPTURE_DIALECT_SEAM_FILES,
    restrictions: [
      ...SOURCE_WIDE_RESTRICTIONS,
      ...DRIZZLE_ZONE_RESTRICTIONS,
      GLOBAL_SYMBOL_RESTRICTION,
      ...BACKEND_DERIVATION_RESTRICTIONS,
      ...DIALECT_SEAM_RESTRICTIONS,
    ],
  },
];

const LINT_BLOCKS = [
  ...createLibraryConfig(import.meta.dirname, {
    ignores: [
      "test-d/**",
      "type-smoke/**",
      "tmp/**",
      // Plain-node CI tooling (runs under `node`, not part of the typed
      // library program); still formatted by prettier.
      "scripts/**/*.mjs",
      // Flat-config data imported by eslint.config.mjs itself — plain ESM
      // plus its hand-written declaration, outside the typed library program
      // for the same reason.
      "eslint/**",
      // #140: workerd-only do-sqlite suite (cloudflare:test). Runs via
      // its own `test:do` lane, not the Node lanes which cannot resolve
      // the `cloudflare:test` / worker ambient types.
      "tests/do-sqlite/**",
    ],
  }),

  // Examples are runnable teaching scripts (`npx tsx examples/NN-*.ts`) as
  // well as importable modules, and they lint with the full library ruleset.
  // Console output and process.exit(1) in the runner need no relaxation here:
  // `no-console` is not enabled by the base config and
  // `unicorn/no-process-exit` is already off globally.
  {
    files: ["examples/**/*.ts"],
    rules: {
      // Every example self-executes behind an `import.meta.url` guard so that
      // importing it never runs it; top-level await would execute on import,
      // which is fundamentally at odds with that runner idiom.
      "unicorn/prefer-top-level-await": "off",
    },
  },

  // graph-merge is intentionally heavy on deterministic ordering helpers plus
  // branch-dependent assertions. Relax only STYLE-ONLY Unicorn/Vitest
  // preferences for the subsystem. The type-safety rules
  // (no-unnecessary-condition, prefer-nullish-coalescing, require-await) stay ON
  // for the SOURCE — this is the most algorithmically complex code in the
  // package and exactly where a dead guard or a value-dropping `||` must be
  // caught.
  {
    files: [
      "src/graph-merge/**/*.ts",
      "tests/graph-merge/**/*.ts",
      "tests/property/graph-merge/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/no-array-callback-reference": "off",
      "unicorn/no-array-reduce": "off",
      "unicorn/no-array-reverse": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/no-await-expression-member": "off",
      "unicorn/no-for-loop": "off",
      "unicorn/no-null": "off",
      "unicorn/prefer-code-point": "off",
      "unicorn/prefer-structured-clone": "off",
      "unicorn/name-replacements": "off",
      "vitest/no-conditional-expect": "off",
    },
  },

  // Merge TESTS additionally relax two rules that are pure noise in test code:
  // `no-unnecessary-condition` (defensive `cleanups ?? []` harness idioms,
  // tautological narrowing after an `expect(x).toBe(...)`) and `require-await`
  // (uniform `async` test/callback signatures). These stay ON for the source.
  {
    files: ["tests/graph-merge/**/*.ts", "tests/property/graph-merge/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/require-await": "off",
    },
  },

  // Determinism guardrail: no locale-dependent APIs anywhere in the library
  // source. Also carries the dialect-literal ban, extended here to the whole
  // library (previously the query compiler's alone); DIALECT_LITERAL_EXEMPTIONS
  // lifts it, file by file, where an AST-level literal still exists.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        ...DRIZZLE_ZONE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...BACKEND_SEAM_IMPORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
        ...DIALECT_SEAM_RESTRICTIONS,
      ],
    },
  },

  // Runtime symbols are private implementation ports. Privileged subsystems
  // use the storeBackend/transactionBackend accessors instead of importing the
  // symbols or their structural contracts directly.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/store/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        ...DRIZZLE_ZONE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_SEAM_IMPORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
        ...DIALECT_SEAM_RESTRICTIONS,
      ],
    },
  },

  // Backend, dialect, and strategy port functions explicitly reject
  // receiver-dependent implementations with `this: void`. This is a valid
  // TypeScript this parameter, not a void-valued data field.
  {
    files: [
      "src/backend/capabilities/catalog.ts",
      "src/backend/types.ts",
      "src/query/dialect/fulltext-strategy.ts",
      "src/query/dialect/types.ts",
      "src/query/dialect/vector-strategy.ts",
    ],
    rules: {
      "@typescript-eslint/no-invalid-void-type": [
        "error",
        { allowAsThisParameter: true, allowInGenericTypeArguments: true },
      ],
    },
  },

  // Backend parity guardrail. The query compiler is a single shared path; the
  // only sanctioned place for a dialect difference is a DialectAdapter member.
  // Inline `=== "sqlite"` / `case "postgres"` branching reintroduces the
  // parallel-path failure mode that hid the set-operation gap. The ban itself
  // (DIALECT_SEAM_RESTRICTIONS) is already installed on every `src/**/*.ts`
  // block; this block only re-spreads it, because flat config's rule entries
  // REPLACE rather than merge and this block's `files` list overrides the
  // general one for query-compiler files. (Spreads DETERMINISM_RESTRICTIONS
  // back in for the same reason.)
  //
  // `src/identity/historical-sql.ts` is query-compiler SQL construction that
  // lives outside src/query, so it is in scope here too. See
  // DIALECT_LITERAL_EXEMPTIONS below for the full file-by-file accounting of
  // where this ban does and doesn't reach across the rest of `src/**`.
  {
    files: ["src/query/**/*.ts", "src/identity/historical-sql.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        ...DRIZZLE_ZONE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_DERIVATION_RESTRICTIONS,
        ...DIALECT_SEAM_RESTRICTIONS,
      ],
    },
  },

  // This is the only module allowed to call Symbol.for directly. Every other
  // source module must use its closed TypeGraph symbol-name inventory.
  {
    files: ["src/utils/global-symbol.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        ...DRIZZLE_ZONE_RESTRICTIONS,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_SEAM_IMPORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
        ...DIALECT_SEAM_RESTRICTIONS,
      ],
    },
  },

  // The construction seam itself: it DEFINES deriveBackend and is the ONE
  // module allowed to import the carry, so those two bans cannot apply here.
  // Every other guardrail is spread back in — a flat-config entry REPLACES, so
  // omitting one would switch it off for the one module that owns the carry.
  // It needs no construction exemption: deriveBackend is a Proxy, projectBackend
  // builds through Object.fromEntries, and the overlay's descriptor spread is
  // not a `*Backend` name.
  {
    files: ["src/backend/derive-backend.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        ...DRIZZLE_ZONE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
        ...DIALECT_SEAM_RESTRICTIONS,
      ],
    },
  },

  // Audited same-surface decorator over transaction-scoped backends. Retains
  // every guardrail except the seam import ban, which it needs because it
  // decorates through deriveBackend. It gets no audit exemption: only the
  // shared engine factory below writes a verdict.
  {
    files: ["src/backend/drizzle/contribution-materializations.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        ...DRIZZLE_ZONE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
        ...DIALECT_SEAM_RESTRICTIONS,
      ],
    },
  },

  // The two backend factories no longer write a verdict themselves — they
  // resolve it (`resolveDeclaredBackendResource`) and hand it to the shared
  // engine factory below, which applies the mark — so neither needs the
  // audit-import exemption and both keep the full restriction list. The
  // PostgreSQL factory still decorates trusted transactions through the
  // seam, so it alone drops the seam import ban; the SQLite factory needs
  // no exemption at all and so gets no block of its own (it falls through
  // to the general `src/**/*.ts` block above).
  {
    files: ["src/backend/drizzle/postgres.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        ...DRIZZLE_ZONE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
        ...DIALECT_SEAM_RESTRICTIONS,
      ],
    },
  },
  // The shared engine factory both dialect factories delegate to
  // (`createSqlBackend`) is the sole module that writes a verdict, so it is
  // the only block exempted from the audit import ban.
  {
    files: ["src/backend/drizzle/engine/create-sql-backend.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        ...DRIZZLE_ZONE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_SEAM_IMPORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
        ...DIALECT_SEAM_RESTRICTIONS,
      ],
    },
  },
  // The write-pipeline ban, and — because flat config applies the LAST
  // matching block — every restriction those files already carried,
  // regenerated from one data source. This replaces the hand-written per-file
  // block for the audited overlay files: it is now the `audited-overlay`
  // profile below, so its coverage cannot drift from the ban's scopes.
  ...writePipelineBlocks({
    profiles: WRITE_PIPELINE_PROFILES,
    exemptions: WRITE_PIPELINE_EXEMPTIONS,
  }),

  // The construction ratchet applies to the test tree too: a double built by
  // spreading a backend is the #435 defect written in a fixture, and the
  // fixture is what the store under test then runs against. Only the
  // construction group is installed — SOURCE_WIDE_RESTRICTIONS and the import
  // bans are source-only by design, and the runtime-port ban would forbid the
  // accessors the suite legitimately reaches for.
  //
  // The two sites this cannot reach are suppressed inline, each with its
  // reason, and both are enumerated by the exemption ratchet in
  // `tests/backend-derivation-population.test.ts`.
  {
    files: ["tests/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...BACKEND_CONSTRUCTION_RESTRICTIONS],
    },
  },

  // The reference-backend tree (B5's `tests/reference/**`, not yet created):
  // the zone ban plus the construction ratchet. B5 EXTENDS this block's
  // `no-restricted-syntax` list (I5's relative-`src` ban and bare-specifier
  // allowlist) rather than adding a second `tests/reference/**` block — flat
  // config entries REPLACE, so a second block would silently drop whichever
  // ban it forgot to respell.
  {
    name: "typegraph/drizzle-zone/reference",
    files: ["tests/reference/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...DRIZZLE_ZONE_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
      ],
    },
  },
];

// The zone ban applies to every `src`/`tests/reference` block above by
// default (installed alongside SOURCE_WIDE_RESTRICTIONS at every one of
// those spreads); these generated blocks are what EXEMPTS the 30 real
// Drizzle importers, and only from the zone ban itself — every other
// guardrail their covering block installed stays in force. Appended last so
// flat config's "last block wins" makes them authoritative for exactly
// their one file each.
const CONFIG_WITHOUT_DIALECT_LITERAL_EXEMPTIONS = [
  ...LINT_BLOCKS,
  ...drizzleZoneExemptionBlocks(LINT_BLOCKS, DRIZZLE_ZONE),
];

// The dialect-literal ban's exemptions, resolved against the config above so
// a file that is ALSO a Drizzle-zone import (e.g. `operations/strategy.ts`)
// keeps that exemption too — this generator finds the true last-matching
// block, drizzle-zone exemption included, before subtracting only the
// dialect-literal selectors. Appended last for the same "last block wins"
// reason as the zone exemptions above.
export default [
  ...CONFIG_WITHOUT_DIALECT_LITERAL_EXEMPTIONS,
  ...dialectLiteralExemptionBlocks(
    CONFIG_WITHOUT_DIALECT_LITERAL_EXEMPTIONS,
    DIALECT_LITERAL_EXEMPTIONS,
  ),
];
