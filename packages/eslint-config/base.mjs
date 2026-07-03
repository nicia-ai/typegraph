// @ts-check

import eslint from "@eslint/js";
import configPrettier from "eslint-config-prettier";
import functional from "eslint-plugin-functional";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";

/**
 * Common ignore patterns for all packages
 */
export const ignores = [
  ".stryker-tmp/**",
  ".wrangler/**",
  "coverage/**",
  "dist/**",
  "node_modules/**",
  "eslint.config.mjs",
  "*.config.ts",
  "*.config.mjs",
];

/**
 * Abbreviation allowlist for unicorn/name-replacements
 */
export const abbreviationAllowlist = {
  Db: true,
  Def: true,
  Dir: true,
  Env: true,
  Err: true,
  Param: true,
  Params: true,
  Props: true,
  Ref: true,
  args: true,
  ctx: true,
  db: true,
  def: true,
  dir: true,
  e2e: true,
  env: true,
  err: true,
  fn: true,
  params: true,
  props: true,
  ref: true,
  utils: true,
};

/**
 * Base TypeScript rules shared across all packages
 */
export const baseTypeScriptRules = {
  "@typescript-eslint/consistent-type-imports": "error",
  "@typescript-eslint/restrict-template-expressions": [
    "error",
    { allowNumber: true },
  ],
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      destructuredArrayIgnorePattern: "^_",
      ignoreRestSiblings: true,
    },
  ],
  "@typescript-eslint/no-non-null-assertion": "off",
  "@typescript-eslint/no-unnecessary-type-arguments": "off",
  "@typescript-eslint/no-unnecessary-type-parameters": "off",
  "@typescript-eslint/only-throw-error": "off",
};

/**
 * eslint-plugin-unicorn v70's `recommended` config promotes 164 rules from
 * its `all` config (previously opt-in only) to on-by-default, on top of the
 * v64 recommended set this codebase was written against. Adopting each of
 * those is a deliberate exercise (many require judgment calls: renaming
 * public API members, restructuring call nesting, rewriting promise chains),
 * not a side effect of a routine dependency bump. Pin them off here so the
 * upgrade is behavior-neutral; remove entries from this list to adopt a rule.
 */
export const unopinionatedUnicornRecommendedAdditions = {
  "unicorn/better-dom-traversing": "off",
  "unicorn/class-reference-in-static-methods": "off",
  "unicorn/consistent-boolean-name": "off",
  "unicorn/consistent-class-member-order": "off",
  "unicorn/consistent-compound-words": "off",
  "unicorn/consistent-conditional-object-spread": "off",
  "unicorn/consistent-export-decorator-position": "off",
  "unicorn/consistent-json-file-read": "off",
  "unicorn/consistent-optional-chaining": "off",
  "unicorn/consistent-tuple-labels": "off",
  "unicorn/default-export-style": "off",
  "unicorn/explicit-timer-delay": "off",
  "unicorn/logical-assignment-operators": "off",
  "unicorn/max-nested-calls": "off",
  "unicorn/no-accidental-bitwise-operator": "off",
  "unicorn/no-array-concat-in-loop": "off",
  "unicorn/no-array-fill-with-reference-type": "off",
  "unicorn/no-array-from-fill": "off",
  "unicorn/no-array-sort-for-min-max": "off",
  "unicorn/no-array-splice": "off",
  "unicorn/no-async-promise-finally": "off",
  "unicorn/no-blob-to-file": "off",
  "unicorn/no-boolean-sort-comparator": "off",
  "unicorn/no-break-in-nested-loop": "off",
  "unicorn/no-canvas-to-image": "off",
  "unicorn/no-chained-comparison": "off",
  "unicorn/no-collection-bracket-access": "off",
  "unicorn/no-computed-property-existence-check": "off",
  "unicorn/no-confusing-array-splice": "off",
  "unicorn/no-confusing-array-with": "off",
  "unicorn/no-constant-zero-expression": "off",
  "unicorn/no-declarations-before-early-exit": "off",
  "unicorn/no-double-comparison": "off",
  "unicorn/no-duplicate-if-branches": "off",
  "unicorn/no-duplicate-logical-operands": "off",
  "unicorn/no-duplicate-loops": "off",
  "unicorn/no-duplicate-set-values": "off",
  "unicorn/no-error-property-assignment": "off",
  "unicorn/no-exports-in-scripts": "off",
  "unicorn/no-global-object-property-assignment": "off",
  "unicorn/no-impossible-length-comparison": "off",
  "unicorn/no-incorrect-query-selector": "off",
  "unicorn/no-incorrect-template-string-interpolation": "off",
  "unicorn/no-invalid-argument-count": "off",
  "unicorn/no-invalid-character-comparison": "off",
  "unicorn/no-invalid-well-known-symbol-methods": "off",
  "unicorn/no-late-current-target-access": "off",
  "unicorn/no-late-event-control": "off",
  "unicorn/no-loop-iterable-mutation": "off",
  "unicorn/no-mismatched-map-key": "off",
  "unicorn/no-misrefactored-assignment": "off",
  "unicorn/no-negated-array-predicate": "off",
  "unicorn/no-negated-comparison": "off",
  "unicorn/no-non-function-verb-prefix": "off",
  "unicorn/no-nonstandard-builtin-properties": "off",
  "unicorn/no-object-methods-with-collections": "off",
  "unicorn/no-optional-chaining-on-undeclared-variable": "off",
  "unicorn/no-redundant-comparison": "off",
  "unicorn/no-return-array-push": "off",
  "unicorn/no-selector-as-dom-name": "off",
  "unicorn/no-subtraction-comparison": "off",
  "unicorn/no-this-outside-of-class": "off",
  "unicorn/no-top-level-assignment-in-function": "off",
  "unicorn/no-top-level-side-effects": "off",
  "unicorn/no-uncalled-method": "off",
  "unicorn/no-undeclared-class-members": "off",
  "unicorn/no-unnecessary-array-flat-map": "off",
  "unicorn/no-unnecessary-boolean-comparison": "off",
  "unicorn/no-unnecessary-fetch-options": "off",
  "unicorn/no-unnecessary-global-this": "off",
  "unicorn/no-unnecessary-nested-ternary": "off",
  "unicorn/no-unnecessary-splice": "off",
  "unicorn/no-unreadable-for-of-expression": "off",
  "unicorn/no-unreadable-object-destructuring": "off",
  "unicorn/no-unsafe-buffer-conversion": "off",
  "unicorn/no-unsafe-promise-all-settled-values": "off",
  "unicorn/no-unsafe-property-key": "off",
  "unicorn/no-unsafe-string-replacement": "off",
  "unicorn/no-unused-array-method-return": "off",
  "unicorn/no-useless-boolean-cast": "off",
  "unicorn/no-useless-coercion": "off",
  "unicorn/no-useless-compound-assignment": "off",
  "unicorn/no-useless-concat": "off",
  "unicorn/no-useless-continue": "off",
  "unicorn/no-useless-delete-check": "off",
  "unicorn/no-useless-else": "off",
  "unicorn/no-useless-logical-operand": "off",
  "unicorn/no-useless-override": "off",
  "unicorn/no-useless-recursion": "off",
  "unicorn/no-useless-template-literals": "off",
  "unicorn/no-xor-as-exponentiation": "off",
  "unicorn/operator-assignment": "off",
  "unicorn/prefer-abort-signal-any": "off",
  "unicorn/prefer-abort-signal-timeout": "off",
  "unicorn/prefer-add-event-listener-options": "off",
  "unicorn/prefer-aggregate-error": "off",
  "unicorn/prefer-array-from-async": "off",
  "unicorn/prefer-array-from-map": "off",
  "unicorn/prefer-array-from-range": "off",
  "unicorn/prefer-array-iterable-methods": "off",
  "unicorn/prefer-array-last-methods": "off",
  "unicorn/prefer-array-slice": "off",
  "unicorn/prefer-await": "off",
  "unicorn/prefer-block-statement-over-iife": "off",
  "unicorn/prefer-boolean-return": "off",
  "unicorn/prefer-continue": "off",
  "unicorn/prefer-direct-iteration": "off",
  "unicorn/prefer-dom-node-replace-children": "off",
  "unicorn/prefer-early-return": "off",
  "unicorn/prefer-else-if": "off",
  "unicorn/prefer-flat-math-min-max": "off",
  "unicorn/prefer-get-or-insert-computed": "off",
  "unicorn/prefer-global-number-constants": "off",
  "unicorn/prefer-group-by": "off",
  "unicorn/prefer-has-check": "off",
  "unicorn/prefer-hoisting-branch-code": "off",
  "unicorn/prefer-https": "off",
  "unicorn/prefer-identifier-import-export-specifiers": "off",
  "unicorn/prefer-includes-over-repeated-comparisons": "off",
  "unicorn/prefer-iterable-in-constructor": "off",
  "unicorn/prefer-iterator-helpers": "off",
  "unicorn/prefer-iterator-to-array": "off",
  "unicorn/prefer-iterator-to-array-at-end": "off",
  "unicorn/prefer-location-assign": "off",
  "unicorn/prefer-map-from-entries": "off",
  "unicorn/prefer-math-abs": "off",
  "unicorn/prefer-math-constants": "off",
  "unicorn/prefer-minimal-ternary": "off",
  "unicorn/prefer-number-coercion": "off",
  "unicorn/prefer-number-is-safe-integer": "off",
  "unicorn/prefer-object-define-properties": "off",
  "unicorn/prefer-object-destructuring-defaults": "off",
  "unicorn/prefer-object-iterable-methods": "off",
  "unicorn/prefer-observer-apis": "off",
  "unicorn/prefer-path2d": "off",
  "unicorn/prefer-private-class-fields": "off",
  "unicorn/prefer-promise-try": "off",
  "unicorn/prefer-promise-with-resolvers": "off",
  "unicorn/prefer-queue-microtask": "off",
  "unicorn/prefer-scoped-selector": "off",
  "unicorn/prefer-set-methods": "off",
  "unicorn/prefer-simple-sort-comparator": "off",
  "unicorn/prefer-simplified-conditions": "off",
  "unicorn/prefer-single-array-predicate": "off",
  "unicorn/prefer-single-object-destructuring": "off",
  "unicorn/prefer-single-replace": "off",
  "unicorn/prefer-smaller-scope": "off",
  "unicorn/prefer-split-limit": "off",
  "unicorn/prefer-string-match-all": "off",
  "unicorn/prefer-string-pad-start-end": "off",
  "unicorn/prefer-string-repeat": "off",
  "unicorn/prefer-toggle-attribute": "off",
  "unicorn/prefer-type-literal-last": "off",
  "unicorn/prefer-uint8array-base64": "off",
  "unicorn/prefer-unary-minus": "off",
  "unicorn/prefer-unicode-code-point-escapes": "off",
  "unicorn/prefer-url-can-parse": "off",
  "unicorn/prefer-url-href": "off",
  "unicorn/prefer-url-search-parameters": "off",
  "unicorn/prefer-while-loop-condition": "off",
  "unicorn/require-array-sort-compare": "off",
  "unicorn/require-css-escape": "off",
  "unicorn/require-passive-events": "off",
  "unicorn/require-proxy-trap-boolean-return": "off",
};

/**
 * Base unicorn plugin rules
 */
export const baseUnicornRules = {
  ...unopinionatedUnicornRecommendedAdditions,
  // Disabled: conflicts with prettier which lowercases hex literals
  "unicorn/number-literal-case": "off",
  "unicorn/filename-case": [
    "error",
    {
      cases: {
        kebabCase: true,
        pascalCase: true,
      },
    },
  ],
  "unicorn/no-nested-ternary": "off",
  "unicorn/no-process-exit": "off",
  "unicorn/name-replacements": [
    "error",
    {
      allowList: abbreviationAllowlist,
      // v70 added these 19 default replacements on top of the v64 map this
      // codebase was written against (e.g. `expr` -> `expression`,
      // `configuration` -> `config`, `dep`/`deps` -> `dependency`/
      // `dependencies`). Disabled for the same reason as
      // unopinionatedUnicornRecommendedAdditions above: a deliberate,
      // reviewed rename, not a side effect of a dependency bump.
      replacements: {
        application: false,
        applications: false,
        buf: false,
        cfg: false,
        cmd: false,
        configuration: false,
        decl: false,
        decls: false,
        dep: false,
        deps: false,
        expr: false,
        exprs: false,
        ident: false,
        idents: false,
        perf: false,
        proto: false,
        repository: false,
        stmt: false,
        stmts: false,
      },
    },
  ],
};

/**
 * Base ESLint configuration for all TypeScript packages
 * @param {string} tsconfigRootDir - Directory containing tsconfig.json
 */
export function createBaseConfig(tsconfigRootDir) {
  return tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    configPrettier,
    unicorn.configs["recommended"],
    functional.configs.externalTypeScriptRecommended,

    {
      ignores,
    },
    {
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
    },
    {
      linterOptions: {
        reportUnusedDisableDirectives: "error",
        reportUnusedInlineConfigs: "error",
      },
    },
    {
      plugins: {
        "simple-import-sort": simpleImportSort,
      },
    },
    {
      rules: {
        ...baseTypeScriptRules,
        ...baseUnicornRules,
        "simple-import-sort/imports": "error",
        "simple-import-sort/exports": "error",
      },
    },
  );
}

export { tseslint, configPrettier, unicorn, functional };
