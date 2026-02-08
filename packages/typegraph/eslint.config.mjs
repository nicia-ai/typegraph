// @ts-check

import { createLibraryConfig } from "@typegraph/eslint-config/library";

export default createLibraryConfig(import.meta.dirname, {
  ignores: ["examples/**"],
});
