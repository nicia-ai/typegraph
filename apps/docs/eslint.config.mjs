// @ts-check

import astro from "eslint-plugin-astro";
import astroParser from "astro-eslint-parser";

import { createBaseConfig, tseslint } from "@typegraph/eslint-config/base";

function normalizeConfigList(config) {
  if (!config) {
    return [];
  }

  return Array.isArray(config) ? config : [config];
}

const baseConfig = createBaseConfig(import.meta.dirname);
const astroRecommended =
  astro.configs?.["flat/recommended"] ?? astro.configs?.recommended;
const astroConfigList = normalizeConfigList(astroRecommended);

export default [
  ...baseConfig,
  {
    ignores: [".astro/**", "public/**"],
  },
  ...astroConfigList,
  {
    files: ["**/*.astro"],
    languageOptions: {
      parser: astroParser,
      parserOptions: {
        parser: tseslint.parser,
        project: "./tsconfig.json",
        projectService: false,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".astro"],
      },
    },
  },
];
