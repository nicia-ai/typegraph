import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import baseConfig from "./vitest.config";

const directory = new URL("tests/graph-merge/", import.meta.url);
// Concrete-driver suites retain their own lanes. Exercise every shared matrix suite.
const include = readdirSync(directory)
  .filter(
    (name) =>
      name.endsWith(".test.ts") &&
      /\bbackendMatrix\s*\(/.test(
        readFileSync(new URL(name, directory), "utf8"),
      ),
  )
  .map((name) => fileURLToPath(new URL(name, directory)));

export default defineConfig({
  resolve: baseConfig.resolve,
  test: { include, maxWorkers: 2, testTimeout: 60_000, hookTimeout: 60_000 },
});
