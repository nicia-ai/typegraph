// @ts-check

import { createLibraryConfig } from "@typegraph/eslint-config/library";

const DIALECT_SEAM_MESSAGE =
  "Do not branch on dialect identity in the query compiler. Express the " +
  "difference as a method/capability on DialectAdapter (a token-level seam) so " +
  "TypeScript forces every backend to provide an implementation and the " +
  "divergence stays visible and cross-backend testable. Backend provisioning " +
  "(src/backend) may branch on dialect for DDL/migration; the query compiler " +
  "must not.";

export default [
  ...createLibraryConfig(import.meta.dirname, {
    ignores: [
      "examples/**",
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
      "unicorn/prevent-abbreviations": "off",
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

  // Backend parity guardrail. The query compiler is a single shared path; the
  // only sanctioned place for a dialect difference is a DialectAdapter member.
  // Inline `=== "sqlite"` / `case "postgres"` branching reintroduces the
  // parallel-path failure mode that hid the set-operation gap, so ban it here.
  {
    files: ["src/query/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
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
];
