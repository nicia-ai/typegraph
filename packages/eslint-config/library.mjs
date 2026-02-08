// @ts-check

import vitest from "@vitest/eslint-plugin";

import { createBaseConfig, tseslint } from "./base.mjs";

/**
 * ESLint configuration for TypeScript library packages
 * Includes base config + vitest rules for tests
 * @param {string} tsconfigRootDir - Directory containing tsconfig.json
 * @param {object} [options] - Additional options
 * @param {string[]} [options.ignores] - Additional patterns to ignore
 */
export function createLibraryConfig(tsconfigRootDir, options = {}) {
  const baseConfig = createBaseConfig(tsconfigRootDir);

  return tseslint.config(
    ...baseConfig,

    // Additional ignores if provided
    ...(options.ignores ? [{ ignores: options.ignores }] : []),

    // Backend adapters implement async interface with sync operations
    {
      files: ["src/backend/**/adapter.ts"],
      rules: {
        "@typescript-eslint/require-await": "off",
      },
    },

    // Test file configuration
    {
      files: ["tests/**/*.{js,jsx,ts,tsx}"],
      plugins: {
        vitest,
      },
      rules: {
        ...vitest.configs.recommended.rules,
        // Test files often have dynamic type behavior for testing type inference
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        // Tests may not always need explicit assertions
        "vitest/expect-expect": "off",
      },
    },
  );
}

export { createBaseConfig } from "./base.mjs";
