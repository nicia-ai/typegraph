// @ts-check

import { createLibraryConfig } from "@typegraph/eslint-config/library";

const DIALECT_SEAM_MESSAGE =
  "Do not branch on dialect identity in the query compiler. Express the " +
  "difference as a method/capability on DialectAdapter (a token-level seam) so " +
  "TypeScript forces every backend to provide an implementation and the " +
  "divergence stays visible and cross-backend testable. Backend provisioning " +
  "(src/backend) may branch on dialect for DDL/migration; the query compiler " +
  "must not.";

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
  "object escapes. Only the two drizzle factories may import it; anything " +
  "else either derives through src/backend/derive-backend.ts (which carries " +
  "the verdict) or reads it through resolveBackendAudit.";

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

export default [
  ...createLibraryConfig(import.meta.dirname, {
    ignores: [
      "test-d/**",
      "type-smoke/**",
      "tmp/**",
      // Plain-node CI tooling (runs under `node`, not part of the typed
      // library program); still formatted by prettier.
      "scripts/**/*.mjs",
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
  // source.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...BACKEND_SEAM_IMPORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
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
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_SEAM_IMPORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
      ],
    },
  },

  // Backend, dialect, and strategy port functions explicitly reject
  // receiver-dependent implementations with `this: void`. This is a valid
  // TypeScript this parameter, not a void-valued data field.
  {
    files: [
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
  // parallel-path failure mode that hid the set-operation gap, so ban it here.
  // (Spreads DETERMINISM_RESTRICTIONS back in: this block REPLACES the src/**
  // no-restricted-syntax entry for query-compiler files.)
  //
  // `src/identity/historical-sql.ts` is query-compiler SQL construction that
  // lives outside src/query, so it is in scope. The rest of src/identity is
  // not: `service.ts` legitimately branches on dialect to gate PostgreSQL
  // advisory locks, which is backend provisioning, not query compilation.
  {
    files: ["src/query/**/*.ts", "src/identity/historical-sql.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_SEAM_IMPORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
        {
          selector:
            "BinaryExpression[operator=/^(===|!==|==|!=)$/] > Literal[value=/^(sqlite|postgres)$/]",
          message: DIALECT_SEAM_MESSAGE,
        },
        {
          selector: "SwitchCase > Literal[value=/^(sqlite|postgres)$/]",
          message: DIALECT_SEAM_MESSAGE,
        },
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
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_SEAM_IMPORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
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
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
      ],
    },
  },

  // Audited same-surface decorator over transaction-scoped backends. Retains
  // every guardrail except the seam import ban, which it needs because it
  // decorates through deriveBackend. It gets no audit exemption: only the two
  // drizzle factories write a verdict.
  {
    files: ["src/backend/drizzle/contribution-materializations.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
      ],
    },
  },

  // The two backend factories are the only modules that WRITE a verdict, so
  // each is exempted from the audit import ban and from nothing else. They are
  // separate blocks — one shared block would hand the audit setter to
  // contribution-materializations.ts for free. The PostgreSQL factory also
  // decorates trusted transactions through the seam, so it drops the seam
  // import ban; the SQLite factory imports no seam and keeps it.
  {
    files: ["src/backend/drizzle/postgres.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
      ],
    },
  },
  {
    files: ["src/backend/drizzle/sqlite.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...RUNTIME_PORT_RESTRICTIONS,
        ...BACKEND_SEAM_IMPORT_RESTRICTIONS,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
      ],
    },
  },
  {
    files: [
      "src/store/operations/edge-operations.ts",
      "src/store/operations/node-operations.ts",
      "src/store/recorded-capture.ts",
      "src/store/recorded-read-service.ts",
      "src/store/store.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SOURCE_WIDE_RESTRICTIONS,
        GLOBAL_SYMBOL_RESTRICTION,
        ...BACKEND_CARRY_RESTRICTIONS,
        ...BACKEND_AUDIT_RESTRICTIONS,
        ...BACKEND_CONSTRUCTION_RESTRICTIONS,
      ],
    },
  },

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
];
