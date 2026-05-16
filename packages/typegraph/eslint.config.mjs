// @ts-check

import { createLibraryConfig } from "@typegraph/eslint-config/library";

export default createLibraryConfig(import.meta.dirname, {
  ignores: [
    "examples/**",
    "test-d/**",
    "type-smoke/**",
    "tmp/**",
    // #140: workerd-only do-sqlite suite (cloudflare:test). Runs via
    // its own `test:do` lane, not the Node lanes which cannot resolve
    // the `cloudflare:test` / worker ambient types.
    "tests/do-sqlite/**",
  ],
});
