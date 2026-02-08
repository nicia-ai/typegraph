// @ts-check

import eslint from "@eslint/js";
import configPrettier from "eslint-config-prettier";
import functional from "eslint-plugin-functional";
import promise from "eslint-plugin-promise";
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
 * Abbreviation allowlist for unicorn/prevent-abbreviations
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
    },
  ],
  "@typescript-eslint/no-non-null-assertion": "off",
  "@typescript-eslint/no-unnecessary-type-parameters": "off",
  "@typescript-eslint/only-throw-error": "off",
};

/**
 * Base unicorn plugin rules
 */
export const baseUnicornRules = {
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
  "unicorn/prevent-abbreviations": [
    "error",
    {
      allowList: abbreviationAllowlist,
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
        promise,
      },
    },
    {
      rules: {
        ...(promise.configs?.recommended?.rules ?? {}),
        ...baseTypeScriptRules,
        ...baseUnicornRules,
        "simple-import-sort/imports": "error",
        "simple-import-sort/exports": "error",
      },
    },
  );
}

export { tseslint, configPrettier, unicorn, functional };
